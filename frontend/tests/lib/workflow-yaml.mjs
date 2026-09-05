// A reader for the slice of YAML a GitHub workflow's job/step structure uses, and nothing
// more.
//
// It exists because the check it serves must go red on things a substring search cannot
// see. `run: cargo check …` reads identically whether or not `continue-on-error: true`
// sits beside it, or on the job above it, or whether the run line ends in `|| true`. The
// sibling this would otherwise be modelled on — `ignored-tests-are-run.test.mjs` — matches
// with `.includes(`, and a check in that shape passes every one of those.
//
// Why not a YAML library: there is none in this repository. `frontend/pnpm-lock.yaml`
// declares no yaml package, `node_modules` contains none, and `node:yaml` does not exist.
// Adding one for four assertions is a dependency the repository would carry forever. So
// this reads the narrow shape instead — and, unlike a library, it is itself under test
// (`workflow-yaml.test.mjs`), which is the only thing that makes hand-rolling defensible.
//
// What it does NOT do, stated so nobody mistakes it for a parser: no anchors, no aliases,
// no multi-document files, no flow mappings, no block scalars beyond keeping their text.
// It is enough for `.github/workflows/*.yml` as this repository writes them, and it throws
// rather than guessing when it meets something it does not model.

const INDENT_OF = (line) => line.length - line.trimStart().length;

function isBlank(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/**
 * Parse `key: value` out of a line, returning null when it is not a mapping line.
 * Values keep their text; `true`/`false` become booleans so a caller can test presence
 * separately from truth.
 */
function keyValue(line) {
  const t = line.trim().replace(/^-\s*/, '');
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(t);
  if (!m) return null;
  const raw = m[2].trim();
  let value = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  else if (raw === '') value = null;
  // Strip quotes only when they *pair*. `/^['"]|['"]$/g` also ate a lone trailing quote,
  // which silently truncated any unquoted value ending in one -- e.g. a `run:` whose last
  // character is the closing quote of a --config JSON blob. That produced a command differing
  // from the real one by a single character, in a check whose entire job is comparing commands
  // character for character.
  else if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) {
    value = raw.slice(1, -1);
  } else value = raw;
  return { key: m[1], value, raw };
}

/**
 * The lines belonging to a block that starts at `start` and is indented deeper than
 * `baseIndent`, blank and comment lines included.
 */
function blockLines(lines, start, baseIndent) {
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (isBlank(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    if (INDENT_OF(lines[i]) <= baseIndent) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * Read a workflow's jobs and their steps.
 *
 * Returns `{ on: string[], jobs: [{ id, keys, steps: [{ keys }] }] }`, where `keys` is a
 * flat map of the scalar keys declared directly on that job or step — which is all the
 * caller needs: `continue-on-error`, `if`, `name`, `run`.
 */
export function readWorkflow(text) {
  const lines = text.split('\n');

  // --- `on:` ---------------------------------------------------------------------------
  const onIndex = lines.findIndex((l) => /^on\s*:/.test(l));
  if (onIndex === -1) throw new Error('workflow has no top-level `on:` key');
  const onInline = lines[onIndex].slice(lines[onIndex].indexOf(':') + 1).trim();
  const triggers = [];
  const triggerFilters = {};
  if (onInline !== '') {
    // `on: [pull_request, push]` or `on: push`
    for (const t of onInline.replace(/^\[|\]$/g, '').split(',')) {
      if (t.trim()) triggers.push(t.trim());
    }
  } else {
    for (const line of blockLines(lines, onIndex + 1, 0)) {
      if (isBlank(line)) continue;
      const kv = keyValue(line);
      if (kv && INDENT_OF(line) === 2) {
        triggers.push(kv.key);
        triggerFilters[kv.key] = [];
      } else if (kv && INDENT_OF(line) > 2 && triggers.length) {
        triggerFilters[triggers[triggers.length - 1]].push(kv.key);
      }
    }
  }

  // --- `jobs:` -------------------------------------------------------------------------
  const jobsIndex = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIndex === -1) throw new Error('workflow has no top-level `jobs:` key');

  const jobs = [];
  const jobBlock = blockLines(lines, jobsIndex + 1, 0);
  const jobBase = jobBlock.find((l) => !isBlank(l));
  if (jobBase === undefined) throw new Error('workflow declares `jobs:` and no job');
  const jobIndent = INDENT_OF(jobBase);

  for (let i = 0; i < jobBlock.length; i += 1) {
    const line = jobBlock[i];
    if (isBlank(line) || INDENT_OF(line) !== jobIndent) continue;
    const kv = keyValue(line);
    if (!kv) continue;

    const body = blockLines(jobBlock, i + 1, jobIndent);
    const job = { id: kv.key, keys: {}, steps: [] };

    const bodyBase = body.find((l) => !isBlank(l));
    const bodyIndent = bodyBase === undefined ? jobIndent + 2 : INDENT_OF(bodyBase);

    for (let j = 0; j < body.length; j += 1) {
      if (isBlank(body[j]) || INDENT_OF(body[j]) !== bodyIndent) continue;
      const bkv = keyValue(body[j]);
      if (!bkv) continue;
      if (bkv.key === 'steps') {
        job.steps.push(...readSteps(blockLines(body, j + 1, bodyIndent)));
      } else {
        job.keys[bkv.key] = bkv.value;
      }
    }
    jobs.push(job);
  }

  return { on: triggers, onFilters: triggerFilters, jobs };
}

function readSteps(block) {
  const steps = [];
  let current = null;
  for (let i = 0; i < block.length; i += 1) {
    const line = block[i];
    if (isBlank(line)) continue;
    if (/^\s*-\s/.test(line)) {
      current = { keys: {} };
      steps.push(current);
    }
    const kv = keyValue(line);
    if (!current || !kv) continue;

    // `run: |` and `run: >` keep the lines under them. Joined, so a caller searching the
    // command finds a trailing `|| true` wherever it was written -- which is the neutering
    // vector a substring check over the file cannot distinguish from a real step. Indexed
    // rather than `indexOf(line)`: two steps can carry byte-identical lines, and the first
    // match is then the wrong one.
    if (kv.value === null || kv.raw === '|' || kv.raw === '>') {
      const text = blockLines(block, i + 1, INDENT_OF(line))
        .filter((l) => !isBlank(l))
        .map((l) => l.trim())
        .join('\n');
      current.keys[kv.key] = text;
    } else {
      current.keys[kv.key] = kv.value;
    }
  }
  return steps;
}

// The AppImage CI publishes must be the AppImage the gate describes.
//
// #43. Every Stage 2 observation in this repository's history was made on one laptop by
// hand, and the largest single cost of one is the 8.7-minute build. Moving that build into
// CI only helps if what comes out is what `gopnik.json` stage 2 says to build: a person who
// downloads the artifact and starts at entry 5 is trusting that entries 1-4 already happened
// *as written*. If the workflow drifts to different flags -- a different bundle, updater
// artifacts back on, a debug profile -- the pass runs against something the gate never
// described, and nothing would say so, because both sides would be green.
//
// So this pins the two commands character for character against the gate's own strings,
// rather than checking that a build "happens". The rest holds the job to the same rules
// `lint-step-is-enforced.test.mjs` holds test.yml's steps to, for the same reason: a job
// that can be switched off with `continue-on-error` is a job that reports rather than
// enforces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow-yaml.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = path.join(root, '..');

const WORKFLOW = path.join(repo, '.github/workflows/stage2-artifact.yml');
assert.ok(
  fs.existsSync(WORKFLOW),
  '.github/workflows/stage2-artifact.yml is gone, so the AppImage is built by a person again ' +
    'and #43 is undone'
);
const wf = readWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));
const stage2 = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification.stage2;

// --- 1. it runs on every pull request ----------------------------------------------------
assert.ok(
  wf.on.includes('pull_request'),
  'stage2-artifact.yml no longer runs on pull_request, so the artifact exists only when ' +
    'somebody remembers to dispatch it — which is the manual step this replaced'
);
assert.deepEqual(
  wf.onFilters.pull_request ?? [],
  [],
  'stage2-artifact.yml now filters its pull_request trigger. Every filter is a set of pull ' +
    'requests with no Stage 2 artifact; if that is deliberate, change this and say which.'
);

assert.equal(wf.jobs.length, 1, `expected one job in stage2-artifact.yml, found ${wf.jobs.length}`);
const [job] = wf.jobs;
const steps = job.steps;

// --- 2 and 3. the two build commands are the gate's, verbatim ---------------------------
// `run: |` blocks reach us as their lines joined by newlines; the gate stores one string per
// entry with `&&` between commands. Normalise both to a list of commands so the comparison
// is about what runs, not about how the YAML was wrapped.
const commandsOf = (text) =>
  String(text)
    .split('\n')
    .flatMap((l) => l.split('&&'))
    .map((c) => c.trim())
    .filter(Boolean);

const gateEntry = (needle) => {
  const found = stage2.filter((c) => c.includes(needle));
  assert.equal(
    found.length,
    1,
    `expected exactly one gopnik.json stage 2 entry containing \`${needle}\`, found ${found.length}`
  );
  return found[0];
};

const workflowStep = (needle) => {
  const found = steps.filter((s) => typeof s.keys.run === 'string' && s.keys.run.includes(needle));
  assert.equal(
    found.length,
    1,
    `expected exactly one step in stage2-artifact.yml running \`${needle}\`, found ${found.length}`
  );
  return found[0];
};

for (const [needle, what] of [
  ['cargo build --release -p llama-helper', 'the sidecar the app cannot build without'],
  ['tauri build --bundles appimage', 'the AppImage itself'],
]) {
  const gate = commandsOf(gateEntry(needle));
  const step = commandsOf(workflowStep(needle).keys.run);
  assert.deepEqual(
    step,
    gate,
    `stage2-artifact.yml and gopnik.json stage 2 disagree about how to build ${what}.\n` +
      `  gate:     ${gate.join(' && ')}\n  workflow: ${step.join(' && ')}\n\n` +
      '  A person who downloads this artifact and starts Stage 2 at entry 5 is trusting that ' +
      'entries 1-4 happened as the gate describes them. When these two drift, both sides stay ' +
      'green and the pass runs against something nothing described.'
  );
}

// --- 4. the job cannot be quietly switched off ------------------------------------------
for (const [level, keys, name] of [
  ['job', job.keys, job.id],
  ...steps.map((s) => ['step', s.keys, s.keys.name ?? '<unnamed>']),
]) {
  for (const key of ['continue-on-error', 'if']) {
    assert.ok(
      !(key in keys),
      `the ${level} \`${name}\` carries \`${key}\`, so the artifact can be absent while the ` +
        'workflow reports success'
    );
  }
  if (typeof keys.run === 'string') {
    for (const escape of ['|| true', '||true', '; true', '|| :']) {
      assert.ok(
        !keys.run.includes(escape),
        `the ${level} \`${name}\` ends a command in \`${escape}\`, so it always succeeds`
      );
    }
  }
}

// --- 5. a missing artifact is a failure, not a silence ----------------------------------
const upload = steps.find((s) => String(s.keys.uses ?? '').includes('actions/upload-artifact'));
assert.ok(upload, 'stage2-artifact.yml builds an AppImage and uploads nothing');
assert.match(
  String(upload.keys.with ?? ''),
  /if-no-files-found:\s*error/,
  'the upload step does not set `if-no-files-found: error`, so a build that produced no ' +
    'AppImage uploads nothing and the job goes green — the same reported-and-ignored shape ' +
    'ADR 0017 was written about'
);

// --- 6. the artifact is asserted, not inferred from an exit code ------------------------
const assertion = steps.find(
  (s) => typeof s.keys.run === 'string' && s.keys.run.includes('bundle/appimage')
    && s.keys.run.includes('exit 1')
);
assert.ok(
  assertion,
  'no step asserts the AppImage exists after the build. `.claude/rules/testing.md`: a call ' +
    'that returns success is not evidence it did anything — assert the state after, never the ' +
    "command's own return value."
);

console.log(
  `ok - stage 2 artifact: ${steps.length} steps, on=[${wf.on.join(', ')}] unfiltered, the sidecar ` +
    'and AppImage commands are gopnik stage 2 verbatim, nothing is switched off, and a missing ' +
    'artifact fails the job'
);

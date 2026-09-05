// The lint steps must be there, and they must actually fail a pull request.
//
// Every earlier check of this shape in this repository asserts by substring — see
// `ignored-tests-are-run.test.mjs:104,114,217`. A substring check sees
// `run: RUSTFLAGS="-D warnings" cargo check …` identically whether or not the step is
// switched off beside it, above it, or inside the command. Six ways to neuter it while
// leaving that string untouched:
//
//   1. delete the step                            -> caught by the presence assertion
//   2. `continue-on-error: true` on the step      -> caught by the step assertion
//   3. `continue-on-error: true` on the JOB       -> the level a step-only check misses
//   4. `if: false` on the step or the job         -> the step never runs
//   5. `|| true` at the end of the run            -> the step runs and always succeeds
//   6. `pull_request` removed from `on:`          -> the whole workflow stops firing on PRs
//
// All six produce a green checks list. The `readWorkflow` reader this uses is itself under
// test (`workflow-yaml.test.mjs`) — hand-rolled and checked, rather than a dependency and
// trusted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow-yaml.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = path.join(root, '..');

const WORKFLOW = path.join(repo, '.github/workflows/test.yml');
const wf = readWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));

// The command the deny is. Held here so a rename of the step cannot quietly drop it: the
// check finds the step by what it *runs*, not by what it is called.
const COMMANDS = [
  {
    // #34 / ADR 0017.
    run: 'RUSTFLAGS="-D warnings" cargo check --workspace --all-targets',
    what: 'rustc warnings fail a pull request',
    inGopnik: true,
  },
  {
    // #35. `--max-warnings=0` is load-bearing: eslint exits 0 on warnings, so without it a
    // rule set to `warn` reports and passes -- the same reported-and-ignored shape #34 fixed
    // for rustc.
    run: 'pnpm lint',
    what: 'eslint findings fail a pull request',
    inGopnik: true,
  },
];

// --- 6. the workflow still fires on every pull request ---------------------------------
assert.ok(
  wf.on.includes('pull_request'),
  'test.yml no longer runs on pull_request, so nothing below it runs on a pull request ' +
    'either — every check in this file would pass while enforcing nothing'
);
assert.deepEqual(
  wf.onFilters.pull_request ?? [],
  [],
  'test.yml now filters its pull_request trigger (by branch or path). Every filter is a set ' +
    'of pull requests the suites and the lint step do not run on. If that is deliberate, ' +
    'change this assertion and say which pull requests are no longer checked.'
);

// --- 1..5, for each lint command --------------------------------------------------------
for (const { run: needle, what } of COMMANDS) {
  const matching = wf.jobs
    .flatMap((job) => job.steps.map((step) => ({ job, step })))
    .filter(({ step }) => typeof step.keys.run === 'string' && step.keys.run.includes(needle));

  assert.equal(
    matching.length,
    1,
    `expected exactly one step running \`${needle}\` in test.yml, found ${matching.length}. ` +
      `That command is what makes ${what}; without it the findings come straight back, ` +
      'reported and ignored.'
  );

  const { job, step } = matching[0];

  // --- 5. the command is not defanged ---------------------------------------------------
  for (const escape of ['|| true', '||true', '; true', '|| :']) {
    assert.ok(
      !step.keys.run.includes(escape),
      `the step running \`${needle}\` ends in \`${escape}\`, so it always succeeds and the ` +
        'check is decoration'
    );
  }

  // --- 2, 3, 4. neither the step nor its job is switched off ---------------------------
  for (const [level, keys, name] of [
    ['step', step.keys, step.keys.name ?? '<unnamed>'],
    ['job', job.keys, job.id],
  ]) {
    assert.ok(
      !('continue-on-error' in keys),
      `the ${level} \`${name}\` carries continue-on-error, so the check goes green whatever ` +
        'it reports. A lint that cannot fail a pull request is not a lint.'
    );
    assert.ok(
      !('if' in keys),
      `the ${level} \`${name}\` carries an \`if\`, so it can be skipped without being ` +
        'removed. If it must be conditional, say here which pull requests go unlinted.'
    );
  }
}

// --- and the gate runs the same command ------------------------------------------------
const gopnik = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8'));
for (const { run: needle } of COMMANDS.filter((c) => c.inGopnik)) {
  assert.ok(
    gopnik.verification.stage1.some((cmd) => cmd.includes(needle)),
    `gopnik.json stage 1 no longer runs \`${needle}\`. CI and the gate must agree: a verdict ` +
      'that says READY while CI enforces something the gate did not run is the disagreement ' +
      'this repository keeps paying for.'
  );
}

// --- the eslint config is backed by what it imports -------------------------------------
// The original defect: `eslint.config.mjs` was committed importing `@eslint/eslintrc`, which
// was never installed, so it threw on import before reaching a rule. Deleting the file is a
// legitimate outcome; leaving one that cannot run is not.
const configPath = path.join(root, 'eslint.config.mjs');
if (fs.existsSync(configPath)) {
  const config = fs.readFileSync(configPath, 'utf8');
  const specifiers = [...config.matchAll(/^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1]
  );
  assert.ok(specifiers.length > 0, 'eslint.config.mjs imports nothing; it cannot be a flat config');
  for (const spec of specifiers) {
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    assert.ok(
      fs.existsSync(path.join(root, 'node_modules', pkg)),
      `eslint.config.mjs imports "${spec}" and ${pkg} is not installed, so the config throws ` +
        'on import and lints nothing. That is the defect #35 was raised for, returning.'
    );
  }

  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(
    typeof pkgJson.scripts?.lint === 'string',
    'eslint.config.mjs exists and package.json declares no `lint` script — a configuration ' +
      'with nothing running it, which is where this started'
  );
  assert.match(
    pkgJson.scripts.lint,
    /--max-warnings[= ]0/,
    'the lint script does not pass --max-warnings=0. eslint exits 0 on warnings, so a rule ' +
      'set to `warn` would report and pass — reported and ignored, which is the shape #34 ' +
      'fixed for rustc and this repository should not reintroduce for JavaScript.'
  );
}

console.log(
  `ok - ${COMMANDS.length} lint commands enforced: on=[${wf.on.join(', ')}] with no ` +
    'pull_request filter, one step each, no continue-on-error or if at either level, no ' +
    'escape in any command, gopnik stage 1 runs them, and eslint.config.mjs imports only ' +
    'what is installed'
);

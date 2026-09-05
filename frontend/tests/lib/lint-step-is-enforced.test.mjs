// The denying step must be there, and it must actually deny.
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
const DENY = 'RUSTFLAGS="-D warnings" cargo check --workspace --all-targets';

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

// --- 1. the step exists --------------------------------------------------------------
const denying = wf.jobs
  .flatMap((job) => job.steps.map((step) => ({ job, step })))
  .filter(({ step }) => typeof step.keys.run === 'string' && step.keys.run.includes(DENY));

assert.equal(
  denying.length,
  1,
  `expected exactly one step running \`${DENY}\` in test.yml, found ${denying.length}. ` +
    'That command is what makes rustc warnings fail a pull request (#34); without it the ' +
    'eighteen warnings this repository carried for its whole life come straight back, ' +
    'reported and ignored.'
);

const { job, step } = denying[0];

// --- 5. the command is not defanged ---------------------------------------------------
for (const escape of ['|| true', '||true', '; true', '|| :']) {
  assert.ok(
    !step.keys.run.includes(escape),
    `the denying step's command ends in \`${escape}\`, so it always succeeds and the deny ` +
      'is decoration'
  );
}

// --- 2, 3, 4. neither the step nor its job is switched off -----------------------------
for (const [level, keys, name] of [
  ['step', step.keys, step.keys.name ?? '<unnamed>'],
  ['job', job.keys, job.id],
]) {
  assert.ok(
    !('continue-on-error' in keys),
    `the ${level} \`${name}\` carries continue-on-error, so the check goes green whatever ` +
      'the deny reports. A lint that cannot fail a pull request is not a lint.'
  );
  assert.ok(
    !('if' in keys),
    `the ${level} \`${name}\` carries an \`if\`, so the deny can be skipped without ` +
      'removing it. If it must be conditional, say here which pull requests go unlinted.'
  );
}

// --- and the gate runs the same command ------------------------------------------------
const gopnik = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8'));
assert.ok(
  gopnik.verification.stage1.some((cmd) => cmd.includes(DENY)),
  'gopnik.json stage 1 no longer runs the deny. CI and the gate must agree: a verdict that ' +
    'says READY while CI enforces something the gate did not run is the disagreement this ' +
    'repository keeps paying for.'
);

console.log(
  `ok - lint step enforced: on=[${wf.on.join(', ')}] with no pull_request filter, ` +
    `one denying step in job "${job.id}", no continue-on-error or if at either level, ` +
    'no escape in the command, and gopnik stage 1 runs it too'
);

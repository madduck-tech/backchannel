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
import { spawnSync } from 'node:child_process';
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
    // #36 / ADR 0018. The policy is in `[workspace.lints.clippy]`; this is what denies.
    run: 'cargo clippy --workspace --all-targets -- -D warnings',
    what: 'clippy findings fail a pull request',
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
  {
    // #42 / ADR 0019. Not a lint -- the first non-lint entry in this list, and the reason the
    // list is really "commands CI and the gate must agree on" rather than "lint commands".
    // It is held to the same four escapes because the failure mode is the same: a record that
    // runs on one side only is worse than none, since two records that cannot be compared read
    // like two that agree.
    run: 'scripts/environment-record.sh',
    what: 'a result is attributable to the environment that produced it',
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

// --- the runtimes CI provisions are the ones the repository pins -------------------------
// #42 / ADR 0019. The environment record above makes a skew *visible*; these two make the
// two skews this repository actually had *impossible*. A record nobody diffs is the failure
// mode the issue was written about, so where drift can be removed by construction it is.
const stepsWith = wf.jobs.flatMap((job) => job.steps).filter((st) => typeof st.keys.with === 'string');

const nodeStep = stepsWith.find((st) => String(st.keys.uses ?? '').includes('actions/setup-node'));
assert.ok(nodeStep, 'test.yml no longer sets up Node, so `pnpm test` runs on whatever the image has');
assert.match(
  nodeStep.keys.with,
  /node-version-file:\s*\.nvmrc/,
  'the setup-node step no longer reads `.nvmrc`. A literal here is a second place the Node ' +
    'version lives, and it drifted once already: this said 22 while every measurement in the ' +
    'repository was made on 24.'
);
const nvmrc = fs.readFileSync(path.join(repo, '.nvmrc'), 'utf8').trim();
assert.match(nvmrc, /^\d+\.\d+\.\d+$/, `.nvmrc is \`${nvmrc}\`, not an exact version — a major ` +
  'alone floats, which is what `version: 11` did for pnpm');

const pnpmStep = stepsWith.find((st) => String(st.keys.uses ?? '').includes('pnpm/action-setup'));
assert.ok(pnpmStep, 'test.yml no longer sets up pnpm');
const declared = /version:\s*([0-9][^\s]*)/.exec(pnpmStep.keys.with);
assert.ok(declared, 'the pnpm setup step declares no `version`, so it provisions the action default');
const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager;
assert.equal(
  `pnpm@${declared[1]}`,
  pinned,
  `test.yml provisions pnpm ${declared[1]} while frontend/package.json pins ${pinned}. corepack ` +
    'holds a developer to the pin and this literal holds CI, so when they differ the two sides ' +
    'run different package managers and neither says so.'
);

// --- the record survives a machine that has none of what it reports ----------------------
// The one way this step can turn a pull request red is by failing, and the machine it is most
// likely to fail on is the one that matters: a runner has no sound server, no display and no
// ffmpeg. So run it with an empty PATH -- nothing but the shell it is invoked with -- and
// require exit 0 and the word `absent`. `absent` is asserted because a record that printed an
// empty value for a missing tool would be indistinguishable from one that printed a real
// value, which is the shape of #10 and the reason this script prints the word at all.
const recorder = path.join(repo, 'scripts/environment-record.sh');
const bare = spawnSync('/bin/bash', [recorder], {
  cwd: repo,
  env: { PATH: '', HOME: repo },
  encoding: 'utf8',
});
assert.equal(
  bare.status,
  0,
  `scripts/environment-record.sh exits ${bare.status} when nothing it reports is installed. It ` +
    'is a record, not a check: on a runner most of these tools are legitimately missing, and a ' +
    `record that fails there fails on the case it exists for.\n  stderr: ${bare.stderr}`
);
assert.match(
  bare.stdout,
  /\babsent\b/,
  'with an empty PATH the record printed no `absent` line, so a missing tool and a missing ' +
    'line look the same in the output that a verdict pastes'
);

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
  `ok - ${COMMANDS.length} commands enforced in CI and the gate: on=[${wf.on.join(', ')}] with no ` +
    'pull_request filter, one step each, no continue-on-error or if at either level, no ' +
    'escape in any command, gopnik stage 1 runs them, and eslint.config.mjs imports only ' +
    'what is installed'
);

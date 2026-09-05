// The reader in `workflow-yaml.mjs` is hand-rolled, so it is under test. That is the whole
// argument for hand-rolling it instead of adding a YAML dependency: a library would be
// trusted, this is checked.
//
// Every case below is a way a required step can be neutered while still reading, to a
// substring search, exactly like a step that runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkflow } from './workflow-yaml.mjs';

const BASE = `name: Tests

on:
  pull_request:
  workflow_dispatch:

jobs:
  test:
    name: Frontend and Rust suites
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5

      - name: Rust lints (deny warnings)
        run: RUSTFLAGS="-D warnings" cargo check --workspace --all-targets

      - name: Rust workspace tests
        run: cargo test --workspace
`;

test('reads the triggers, the job and its steps', () => {
  const wf = readWorkflow(BASE);
  assert.deepEqual(wf.on, ['pull_request', 'workflow_dispatch']);
  assert.equal(wf.jobs.length, 1);
  assert.equal(wf.jobs[0].id, 'test');
  assert.deepEqual(
    wf.jobs[0].steps.map((s) => s.keys.name),
    ['Checkout repository', 'Rust lints (deny warnings)', 'Rust workspace tests']
  );
});

test('a step-level continue-on-error is visible', () => {
  const wf = readWorkflow(
    BASE.replace(
      '      - name: Rust lints (deny warnings)\n',
      '      - name: Rust lints (deny warnings)\n        continue-on-error: true\n'
    )
  );
  const step = wf.jobs[0].steps.find((s) => s.keys.name === 'Rust lints (deny warnings)');
  assert.equal(step.keys['continue-on-error'], true);
});

test('a JOB-level continue-on-error is visible, which is the level a step check misses', () => {
  const wf = readWorkflow(BASE.replace('    runs-on:', '    continue-on-error: true\n    runs-on:'));
  assert.equal(wf.jobs[0].keys['continue-on-error'], true);
});

test('a job-level if is visible', () => {
  const wf = readWorkflow(BASE.replace('    runs-on:', '    if: false\n    runs-on:'));
  assert.equal(wf.jobs[0].keys.if, false);
});

test('a step-level if is visible', () => {
  const wf = readWorkflow(
    BASE.replace(
      '      - name: Rust lints (deny warnings)\n',
      '      - name: Rust lints (deny warnings)\n        if: false\n'
    )
  );
  const step = wf.jobs[0].steps.find((s) => s.keys.name === 'Rust lints (deny warnings)');
  assert.equal(step.keys.if, false);
});

test('the whole run command is kept, including a block scalar, so `|| true` cannot hide', () => {
  const wf = readWorkflow(
    BASE.replace(
      '        run: RUSTFLAGS="-D warnings" cargo check --workspace --all-targets\n',
      '        run: |\n          RUSTFLAGS="-D warnings" cargo check --workspace --all-targets || true\n'
    )
  );
  const step = wf.jobs[0].steps.find((s) => s.keys.name === 'Rust lints (deny warnings)');
  assert.match(step.keys.run, /\|\| true/);
});

test('an inline `on:` list is read the same as a block one', () => {
  const wf = readWorkflow(BASE.replace('on:\n  pull_request:\n  workflow_dispatch:\n', 'on: [pull_request, workflow_dispatch]\n'));
  assert.deepEqual(wf.on, ['pull_request', 'workflow_dispatch']);
});

test('a branch filter under a trigger is visible', () => {
  const wf = readWorkflow(BASE.replace('  pull_request:\n', '  pull_request:\n    branches: [main]\n'));
  assert.deepEqual(wf.onFilters.pull_request, ['branches']);
});

test('it refuses a file it does not model rather than guessing', () => {
  assert.throws(() => readWorkflow('name: nothing\n'), /no top-level `on:` key/);
  assert.throws(() => readWorkflow('on: push\n'), /no top-level `jobs:` key/);
});

test('an unquoted value ending in a quote keeps its last character', () => {
  // Red-first. `raw.replace(/^['"]|['"]$/g, '')` strips a *lone* trailing quote, so a `run:`
  // whose final character is the closing quote of an embedded JSON argument came back one
  // character short. That is invisible in every use of this reader except the one that
  // compares a workflow command against gopnik.json character for character (#43), where it
  // read as "CI builds the artifact differently from the gate".
  const wf = readWorkflow(`
on: pull_request
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: Build
        run: tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
`);
  assert.equal(
    wf.jobs[0].steps[0].keys.run,
    `tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`
  );
});

test('a properly quoted value still loses its quotes', () => {
  const wf = readWorkflow(`
on: pull_request
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: 'Quoted name'
        run: "echo hello"
`);
  assert.equal(wf.jobs[0].steps[0].keys.name, 'Quoted name');
  assert.equal(wf.jobs[0].steps[0].keys.run, 'echo hello');
});

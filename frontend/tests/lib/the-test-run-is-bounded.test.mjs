// `pnpm test` is bounded twice (#268): each file by B, in what the `test` script runs, and the CI step
// by `timeout-minutes`, as a backstop that cannot fire before the first file that never exits has
// been named. Measured on 2026-10-27: with neither, one file held "Frontend unit tests" for 79 min in
// silence, until GitHub cancelled the job.
//
// The backstop's floor is T + B + 30 s. Files start in sorted order, four at a time, so in a run
// where one never exits, every file before it has finished by T, the slowest healthy step, and it
// starts by then. So it is named by T + B, and the 30 s is for the report and the kill. The ceiling
// is twice the floor: `timeout-minutes: 360` clears the floor and is the platform's limit renamed.
//
// T is at least the slowest "Frontend unit tests" step of every run #268 cites: its own sample of 25
// successful Tests runs from 40870763866 (2026-10-29 12:07Z) to 41063826941 (2026-10-30 13:30Z),
// slowest 40885884340 at 220 s; the issue's sample, slowest 40563250823 at 221 s; and the pull
// request's own runs under this runner. Raise it with a slower cited run.
// B is not a second constant: it is read from the script.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow-yaml.mjs';

const T_SECONDS = 230;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;

// 1. The bound is in what the script runs.
const runner = /^node scripts\/test-runner\.mjs (.+)$/.exec(script);
assert.ok(runner, `the test script does not run scripts/test-runner.mjs, so no file is bounded: ${script}`);
const bound = /(?:^| )--file-timeout=([1-9][0-9]*)(?: |$)/.exec(runner[1]);
assert.ok(bound, `the test script passes the runner no --file-timeout: ${script}`);
const B_SECONDS = Number(bound[1]) / 1000;
assert.ok(runner[1].includes("'tests/**/*.test.mjs'"), `the test script no longer globs tests/**/*.test.mjs: ${script}`);

// 2. The step carries timeout-minutes.
const wf = readWorkflow(fs.readFileSync(path.join(root, '..', '.github', 'workflows', 'test.yml'), 'utf8'));
const steps = wf.jobs.flatMap((job) => job.steps).filter((s) => s.keys.run === 'pnpm test' && s.keys['working-directory'] === 'frontend');
assert.equal(steps.length, 1, `expected one "pnpm test" step in test.yml, found ${steps.length}`);
const minutes = steps[0].keys['timeout-minutes'];
assert.ok(minutes !== undefined, 'the "pnpm test" step carries no timeout-minutes, so a run the bound misses holds the job for 360 min');
assert.match(String(minutes), /^[1-9][0-9]*$/, `timeout-minutes is not a whole number of minutes: ${minutes}`);

// 3. The floor, and 4. the ceiling.
const floor = Math.ceil((T_SECONDS + B_SECONDS + 30) / 60);
assert.ok(
  Number(minutes) >= floor,
  `timeout-minutes ${minutes} is below the floor of ${floor}: T ${T_SECONDS} s + B ${B_SECONDS} s + 30 s, rounded up to a minute`
);
assert.ok(Number(minutes) <= 2 * floor, `timeout-minutes ${minutes} is above twice the floor of ${floor}, which is the platform's limit renamed`);

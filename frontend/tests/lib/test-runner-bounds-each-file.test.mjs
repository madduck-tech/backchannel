// `pnpm test`'s runner ends a file that never exits, by its path, and kills what the file started
// (#268, item 4). The fixtures in `scripts/test-runner-fixtures/` are the shapes Node's own flags miss;
// they run here through `scripts/test-runner.mjs` with the bound shortened to S.
//
// Why this exists beside the configuration test: the bound was observed once, by hand, for #268's
// verdict. Without this, a later edit that drops one of the runner's kill steps leaves every test
// green, and the first sign is a CI job held for hours again.
//
// It must not hang the suite itself. Every process it starts carries a marker of its own; a nested
// run gets a deadline, later than S + 30 s and well inside the suite's own bound, that kills the
// nested run's group and every marked pid, counts as a failure, and finishes on `exit`. A `finally`
// kills every marked pid again.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = 'scripts/test-runner-fixtures';
const S = 4000;
const DEADLINE_MS = S + 40_000;
const OWN = `bc-runner-test-${process.pid}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-runner-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

function procs() {
  return fs.readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n) && Number(n) !== process.pid);
}
function read(pid, what) {
  try {
    return fs.readFileSync(`/proc/${pid}/${what}`, 'latin1');
  } catch {
    return '';
  }
}
/** `pgrep -x sleep`, kept to the one whose whole command line is `sleep <mark>`. */
const sleepsWith = (mark) => procs().filter((p) => read(p, 'cmdline') === `sleep\0${mark}\0`).map(Number);
/** Every process carrying this test's marker, a file's own `node` as well as its `sleep`. */
const ownPids = () =>
  procs()
    .filter((p) => read(p, 'environ').split('\0').some((e) => e.startsWith('BC_TEST_MARKS=') && e.slice(14).split(' ').includes(OWN)))
    .map(Number);
const kill = (pid) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone
  }
};

/** Fresh sleep arguments for one case, from this test's pid, so no other run can find or kill them. */
function marksFor(n) {
  return { A: `9${process.pid}${n}1`, C: `9${process.pid}${n}3`, D: `9${process.pid}${n}4`, E: `9${process.pid}${n}5` };
}

async function nested(name, n, files, { fileTimeout = S, env: extra = {}, sigtermAt } = {}) {
  const marks = marksFor(n);
  const stamp = path.join(tmp, `stamp-${n}`);
  for (const m of Object.values(marks)) check(sleepsWith(m).length === 0, `${name}: a process already carries ${m} before the run`);
  const env = {
    ...process.env,
    BC_HANG_MARK_A: marks.A,
    BC_HANG_MARK_C: marks.C,
    BC_HANG_MARK_D: marks.D,
    BC_HANG_MARK_E: marks.E,
    BC_HANG_STAMP_D: stamp,
    BC_TEST_MARKS: [process.env.BC_TEST_MARKS, OWN].filter(Boolean).join(' '),
    // As a run under `pnpm test` has it, so the runner's dropping it is what lets the files run.
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8',
    ...extra,
  };
  const started = Date.now();
  const child = spawn(process.execPath, ['scripts/test-runner.mjs', `--file-timeout=${fileTimeout}`, '--concurrency=4', ...files.map((f) => `${FIX}/${f}`)], {
    cwd: frontend,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ended = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
  const mid = sleep(S / 2).then(() => ({
    running: child.exitCode === null && child.signalCode === null,
    a: sleepsWith(marks.A).length,
    c: sleepsWith(marks.C).length,
    stamp: fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '',
  }));
  if (sigtermAt) {
    setTimeout(() => {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // gone
      }
    }, sigtermAt).unref();
  }
  let deadlineFired = false;
  const deadline = setTimeout(() => {
    deadlineFired = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone
    }
    ownPids().forEach(kill);
  }, DEADLINE_MS);
  // On `exit`, not on the pipes: a holder this test does not know of could keep them open.
  const { code, sig } = await ended;
  clearTimeout(deadline);
  const ms = Date.now() - started;
  child.stdout.destroy();
  child.stderr.destroy();
  check(!deadlineFired, `${name}: the nested run was still going at ${DEADLINE_MS} ms and this test's deadline ended it`);
  return { code, sig, ms, out, mid: await mid, marks };
}

const line = (file, rest) => new RegExp(`^✖ ${FIX}/${file.replace(/\./g, '\\.')} — [0-9]+ ms: ${rest}`, 'm');

try {
  // 1. Every shape in one run, at concurrency 4, beside a file that passes.
  {
    const r = await nested('all', 1, ['a-blocks-in-spawnsync.mjs', 'b-awaits-forever.mjs', 'c-detached-child.mjs', 'd-holds-the-output.mjs', 'e-leaves-a-process.mjs', 'passes.mjs']);
    check(r.mid.running, 'all: the run had ended by S/2, before any bound');
    check(r.mid.a > 0, "all: a's sleep was not running at S/2, so its absence later would mean nothing");
    check(r.mid.c > 0, "all: c's sleep was not running at S/2, so its absence later would mean nothing");
    check(/^[0-9]+$/.test(r.mid.stamp), "all: d's stamp holds no pid at S/2, so d never reached its spawn");
    check(r.ms <= S + 30_000, `all: the run took ${r.ms} ms, more than S + 30 s`);
    check(r.code !== 0, `all: the run exited ${r.code}, with four files that never end`);
    for (const f of ['a-blocks-in-spawnsync.mjs', 'b-awaits-forever.mjs', 'c-detached-child.mjs', 'd-holds-the-output.mjs']) {
      check(line(f, `still running after the ${S} ms bound`).test(r.out), `all: no ✖ line names ${f} at its bound`);
    }
    check(line('e-leaves-a-process.mjs', 'exited and left 1 process\\(es\\) running').test(r.out), 'all: no ✖ line names e for the process it left');
    check(new RegExp(`^✔ ${FIX}/passes\\.mjs — `, 'm').test(r.out), 'all: the file that passes did not pass');
    for (const [k, m] of Object.entries(r.marks)) check(sleepsWith(m).length === 0, `all: ${k}'s sleep ${m} is still running after the run`);
  }

  // 2. Where there is no /proc to read (macOS), a file's process group is all the runner can kill.
  {
    const r = await nested('no /proc', 2, ['a-blocks-in-spawnsync.mjs'], { env: { BC_TEST_PROC_ROOT: path.join(tmp, 'no-proc') } });
    check(r.mid.a > 0, "no /proc: a's sleep was not running at S/2");
    check(line('a-blocks-in-spawnsync.mjs', `still running after the ${S} ms bound`).test(r.out), 'no /proc: no ✖ line names a at its bound');
    check(r.code !== 0, `no /proc: the run exited ${r.code}`);
    check(sleepsWith(r.marks.A).length === 0, "no /proc: a's sleep is still running after the run");
  }

  // 3. The runner itself ended, as the CI step's own timeout ends it: what it ran goes with it, named.
  {
    const r = await nested('SIGTERM', 3, ['a-blocks-in-spawnsync.mjs'], { fileTimeout: 60_000, sigtermAt: S / 2 + 500 });
    check(r.mid.a > 0, "SIGTERM: a's sleep was not running at S/2");
    check(r.code === 143, `SIGTERM: the runner exited ${r.code} (${r.sig}), not 143`);
    check(new RegExp(`^✖ ${FIX}/a-blocks-in-spawnsync\\.mjs: the runner received SIGTERM`, 'm').test(r.out), 'SIGTERM: no ✖ line names the file in flight');
    check(sleepsWith(r.marks.A).length === 0, "SIGTERM: a's sleep is still running after the runner ended");
  }
} finally {
  ownPids().forEach(kill);
  for (const n of [1, 2, 3]) for (const m of Object.values(marksFor(n))) sleepsWith(m).forEach(kill);
  fs.rmSync(tmp, { recursive: true, force: true });
}

assert.deepEqual(fails, [], 'the runner did not bound every file');

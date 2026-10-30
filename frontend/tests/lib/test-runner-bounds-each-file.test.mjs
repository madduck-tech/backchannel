// `pnpm test`'s runner ends a file that never exits, by its path, and kills what the file started
// (#268, item 4). The fixtures in `scripts/test-runner-fixtures/` are the shapes Node's own flags miss,
// and the shapes each of the runner's three ways of finding a file's processes misses alone; they run
// here through `scripts/test-runner.mjs` with the bound shortened to S.
//
// Why this exists beside the configuration test: the bound was observed once, by hand, for #268's
// verdict. Without this, a later edit that drops one of the runner's kill steps leaves every test
// green, and the first sign is a CI job held for hours again.
//
// It must not hang the suite itself. Every process it starts carries a marker of its own; a nested
// run gets a deadline, later than S + 30 s and well inside the suite's own bound, that kills the
// nested run's group and every marked pid, counts as a failure, and finishes on `exit`. A `finally`
// kills every marked pid again. It reads /proc, so it fails where there is none, rather than passing
// having checked nothing.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(fs.existsSync('/proc/self/stat'), 'this test reads /proc to find what the runner left, and this platform has none');

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
  return Object.fromEntries(['A', 'C', 'D', 'E', 'F', 'H'].map((k, i) => [k, `9${process.pid}${n}${i}`]));
}
const ALL_CASES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

async function nested(name, n, files, { fileTimeout = S, env: extra = {}, runner = 'scripts/test-runner.mjs', signalAt, prefix = [], closeStdoutAt } = {}) {
  const marks = marksFor(n);
  const stamp = path.join(tmp, `stamp-${n}`);
  for (const m of Object.values(marks)) check(sleepsWith(m).length === 0, `${name}: a process already carries ${m} before the run`);
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(marks).map(([k, m]) => [`BC_HANG_MARK_${k}`, m])),
    BC_HANG_STAMP_D: stamp,
    BC_TEST_MARKS: [process.env.BC_TEST_MARKS, OWN].filter(Boolean).join(' '),
    // As a run under `pnpm test` has it, so the runner's dropping it is what lets the files run.
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8',
    ...extra,
  };
  const started = Date.now();
  const command = [process.execPath, runner, `--file-timeout=${fileTimeout}`, '--concurrency=4', ...files];
  const child = spawn(prefix[0] ?? command[0], [...prefix.slice(1), ...(prefix.length ? command : command.slice(1))], { cwd: frontend, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ended = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
  const mid = sleep(S / 2).then(() => {
    const a = sleepsWith(marks.A);
    const own = new Set(ownPids());
    return {
      running: child.exitCode === null && child.signalCode === null,
      a: a.length,
      aIsOwn: a.length > 0 && a.every((p) => own.has(p)),
      c: sleepsWith(marks.C).length,
      f: sleepsWith(marks.F).length,
      h: sleepsWith(marks.H).length,
      stamp: fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '',
    };
  });
  // A reader that goes away: the runner's next write fails with EPIPE.
  if (closeStdoutAt) setTimeout(() => child.stdout.destroy(), closeStdoutAt).unref();
  if (signalAt) {
    setTimeout(() => {
      try {
        process.kill(child.pid, signalAt.sig);
      } catch {
        // gone
      }
    }, signalAt.ms).unref();
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
  // Read at once: a kill the runner made before it exited has taken effect by now, and a process
  // killed later (by a file's watchdog, up to 500 ms on) has not.
  const leftAtExit = Object.fromEntries(Object.entries(marks).map(([k, m]) => [k, sleepsWith(m).length]));
  clearTimeout(deadline);
  const ms = Date.now() - started;
  child.stdout.destroy();
  child.stderr.destroy();
  check(!deadlineFired, `${name}: the nested run was still going at ${DEADLINE_MS} ms and this test's deadline ended it`);
  return { code, sig, ms, out, mid: await mid, marks, leftAtExit };
}

const fixture = (f) => `${FIX}/${f}`;
const line = (file, rest) => new RegExp(`^✖ ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — [0-9]+ ms: ${rest}`, 'm');
const HUNG = ['a-blocks-in-spawnsync.mjs', 'b-awaits-forever.mjs', 'c-detached-child.mjs', 'd-holds-the-output.mjs'];

try {
  // 1. Every shape in one run, at concurrency 4, beside a file that passes and one whose child ends
  //    inside the grace.
  {
    const r = await nested('all', 1, [...HUNG, 'e-leaves-a-process.mjs', 'g-ends-its-child-soon.mjs', 'passes.mjs'].map(fixture));
    check(r.mid.running, 'all: the run had ended by S/2, before any bound');
    check(r.mid.a > 0, "all: a's sleep was not running at S/2, so its absence later would mean nothing");
    check(r.mid.aIsOwn, "all: a's sleep does not carry this test's marker, so the runner dropped the marker it inherited");
    check(r.mid.c > 0, "all: c's sleep was not running at S/2, so its absence later would mean nothing");
    check(/^[0-9]+$/.test(r.mid.stamp), "all: d's stamp holds no pid at S/2, so d never reached its spawn");
    check(r.ms <= S + 30_000, `all: the run took ${r.ms} ms, more than S + 30 s`);
    check(r.code !== 0, `all: the run exited ${r.code}, with four files that never end`);
    for (const f of HUNG) {
      check(line(fixture(f), `still running after the ${S} ms bound for one file; everything found of it was killed$`).test(r.out), `all: no ✖ line names ${f} at its bound, everything killed`);
    }
    check(line(fixture('e-leaves-a-process.mjs'), 'exited and left 1 process\\(es\\) running').test(r.out), 'all: no ✖ line names e for the process it left');
    check(new RegExp(`^✔ ${FIX}/g-ends-its-child-soon\\.mjs — `, 'm').test(r.out), 'all: g failed, though its child ended inside the grace');
    check(new RegExp(`^✔ ${FIX}/passes\\.mjs — `, 'm').test(r.out), 'all: the file that passes did not pass');
    for (const [k, m] of Object.entries(r.marks)) check(sleepsWith(m).length === 0, `all: ${k}'s sleep ${m} is still running after the run`);
  }

  // 1b. The shapes run 1 would start late, since the runner starts files in sorted order, four at a
  //     time: Chrome's (only the tree finds it), an orphan only the poll saw, a file whose runner is
  //     ended by a signal, and one with more output than is kept.
  {
    const r = await nested('f-j', 7, ['f-hides-its-marker.mjs', 'h-orphans-a-hidden-child.mjs', 'i-kills-its-runner.mjs', 'j-prints-a-lot.mjs'].map(fixture));
    check(r.mid.f > 0, "f-j: f's sleep was not running at S/2, so its absence later would mean nothing");
    check(r.mid.h > 0, "f-j: h's sleep was not running at S/2, so its absence later would mean nothing");
    for (const f of ['f-hides-its-marker.mjs', 'h-orphans-a-hidden-child.mjs']) {
      check(line(fixture(f), `still running after the ${S} ms bound for one file; everything found of it was killed$`).test(r.out), `f-j: no ✖ line names ${f} at its bound, everything killed`);
    }
    check(sleepsWith(r.marks.F).length === 0, "f-j: f's sleep is still running after the run");
    check(sleepsWith(r.marks.H).length === 0, "f-j: h's sleep is still running after the run");
    check(line(fixture('i-kills-its-runner.mjs'), 'exited 137').test(r.out), "f-j: no ✖ line names i for its runner's SIGKILL");
    check(/^… the first [0-9]+ bytes of its output were dropped$/m.test(r.out), "f-j: j's report does not say its output was cut");
    check(new RegExp(`^✔ ${FIX}/j-prints-a-lot\\.mjs — `, 'm').test(r.out), 'f-j: j did not pass');
  }

  // 2. Where there is no /proc to read (macOS), a file's process group is all the runner can kill.
  {
    const r = await nested('no /proc', 2, [fixture('a-blocks-in-spawnsync.mjs')], { env: { BC_TEST_PROC_ROOT: path.join(tmp, 'no-proc') } });
    check(r.mid.a > 0, "no /proc: a's sleep was not running at S/2");
    check(line(fixture('a-blocks-in-spawnsync.mjs'), `still running after the ${S} ms bound`).test(r.out), 'no /proc: no ✖ line names a at its bound');
    check(r.code !== 0, `no /proc: the run exited ${r.code}`);
    check(sleepsWith(r.marks.A).length === 0, "no /proc: a's sleep is still running after the run");
  }

  // 3. The runner ended with SIGTERM: what it ran goes with it, and is named. With h, signalled after
  //    its orphan is made: only the runner's poll knows that orphan, so the file's watchdog, which
  //    also kills on the runner's death, cannot stand in for the runner's own kill.
  {
    const r = await nested('SIGTERM', 3, [fixture('h-orphans-a-hidden-child.mjs')], { fileTimeout: 60_000, signalAt: { sig: 'SIGTERM', ms: S / 2 + 500 } });
    check(r.mid.h > 0, "SIGTERM: h's sleep was not running at S/2");
    check(r.code === 143, `SIGTERM: the runner exited ${r.code} (${r.sig}), not 143`);
    check(new RegExp(`^✖ ${FIX}/h-orphans-a-hidden-child\\.mjs: the runner received SIGTERM`, 'm').test(r.out), 'SIGTERM: no ✖ line names the file in flight');
    let left = sleepsWith(r.marks.H).length;
    for (let i = 0; i < 10 && left; i++) {
      await sleep(100);
      left = sleepsWith(r.marks.H).length;
    }
    check(left === 0, "SIGTERM: h's sleep is still running 1 s after the runner exited");
  }

  // 4. SIGHUP, which a closed terminal or a dropped session sends.
  {
    const r = await nested('SIGHUP', 4, [fixture('a-blocks-in-spawnsync.mjs')], { fileTimeout: 60_000, signalAt: { sig: 'SIGHUP', ms: S / 2 + 500 } });
    check(r.mid.a > 0, "SIGHUP: a's sleep was not running at S/2");
    check(r.code === 129, `SIGHUP: the runner exited ${r.code} (${r.sig}), not 129`);
    check(new RegExp(`^✖ ${FIX}/a-blocks-in-spawnsync\\.mjs: the runner received SIGHUP`, 'm').test(r.out), 'SIGHUP: no ✖ line names the file in flight');
    check(r.leftAtExit.A === 0, "SIGHUP: a's sleep was still running when the runner exited");
  }

  // 5. SIGKILL, which nothing can handle: each file's watchdog kills what its file started once the
  //    runner is gone, inside the group (a) and outside it with no marker (f).
  {
    const r = await nested('SIGKILL', 5, ['a-blocks-in-spawnsync.mjs', 'f-hides-its-marker.mjs'].map(fixture), { fileTimeout: 60_000, signalAt: { sig: 'SIGKILL', ms: S / 2 + 500 } });
    check(r.mid.a > 0 && r.mid.f > 0, "SIGKILL: a's or f's sleep was not running at S/2");
    const gone = async (mark) => {
      for (let i = 0; i < 30 && sleepsWith(mark).length; i++) await sleep(100);
      return sleepsWith(mark).length === 0;
    };
    check(await gone(r.marks.A), "SIGKILL: a's sleep is still running 3 s after the runner was killed");
    check(await gone(r.marks.F), "SIGKILL: f's sleep is still running 3 s after the runner was killed");
  }

  // 8. A closed terminal: SIGHUP, and every write after it fails with EIO. Run on a real pseudo-terminal,
  //    closed after h's orphan is made, which only the runner's own kill reaches.
  {
    const r = await nested('closed terminal', 8, ['c-detached-child.mjs', 'h-orphans-a-hidden-child.mjs'].map(fixture), {
      fileTimeout: 60_000,
      prefix: ['python3', path.join(frontend, FIX, 'close-the-terminal.py'), String((S / 2 + 500) / 1000)],
    });
    check(r.mid.c > 0 && r.mid.h > 0, "closed terminal: c's or h's sleep was not running at S/2");
    check(r.code !== 99, 'closed terminal: the runner was still running 20 s after its terminal closed');
    for (const k of ['C', 'H']) {
      for (let i = 0; i < 20 && sleepsWith(r.marks[k]).length; i++) await sleep(100);
      check(sleepsWith(r.marks[k]).length === 0, `closed terminal: ${k.toLowerCase()}'s sleep is still running after the terminal closed`);
    }
  }

  // 9. A reader that goes away (`pnpm test | head -1`): the runner's next write fails with EPIPE, and
  //    what it is running goes with it, long before the bound. The write is k's report, at 3 s, after
  //    h's orphan is made.
  {
    const r = await nested('EPIPE', 9, ['h-orphans-a-hidden-child.mjs', 'k-passes-late.mjs'].map(fixture), { fileTimeout: 60_000, closeStdoutAt: 300 });
    check(r.mid.h > 0, "EPIPE: h's sleep was not running at S/2");
    check(r.ms < 15_000, `EPIPE: the runner ran on for ${r.ms} ms after its reader went away`);
    check(r.code !== 0, `EPIPE: the runner exited ${r.code}`);
    for (let i = 0; i < 20 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, "EPIPE: h's sleep is still running after the runner ended");
  }

  // 6. Run from a path with a space and one with a non-ASCII letter: it runs, and a failing file fails.
  {
    const failing = path.join(tmp, 'fails.mjs');
    fs.writeFileSync(failing, 'process.exit(1);\n');
    for (const dir of ['with space', 'Проект']) {
      const at = path.join(tmp, dir);
      fs.mkdirSync(at);
      for (const f of ['test-runner.mjs', 'test-runner-watchdog.mjs']) fs.copyFileSync(path.join(frontend, 'scripts', f), path.join(at, f));
      const r = await nested(`from "${dir}"`, 6, [failing], { runner: path.join(at, 'test-runner.mjs') });
      check(r.code === 1, `from "${dir}": the runner exited ${r.code}, not 1, on a file that fails`);
      check(line(failing, 'exited 1').test(r.out), `from "${dir}": no ✖ line names the failing file`);
    }
  }
} finally {
  ownPids().forEach(kill);
  for (const n of ALL_CASES) for (const m of Object.values(marksFor(n))) sleepsWith(m).forEach(kill);
  fs.rmSync(tmp, { recursive: true, force: true });
}

assert.deepEqual(fails, [], 'the runner did not bound every file');

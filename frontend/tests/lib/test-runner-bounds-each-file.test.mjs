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
const ALL_CASES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

const outputs = [];

async function nested(name, n, files, { fileTimeout = S, env: extra = {}, runner = 'scripts/test-runner.mjs', signals = [], prefix = [], closeStdoutAt, pauseStdout, concurrency = 4, watchMarks = [] } = {}) {
  const marks = marksFor(n);
  const stamp = path.join(tmp, `stamp-${n}`);
  const stampH = path.join(tmp, `stamp-h-${n}`);
  for (const m of Object.values(marks)) check(sleepsWith(m).length === 0, `${name}: a process already carries ${m} before the run`);
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(marks).map(([k, m]) => [`BC_HANG_MARK_${k}`, m])),
    BC_HANG_STAMP_D: stamp,
    BC_HANG_STAMP_H: stampH,
    BC_TEST_MARKS: [process.env.BC_TEST_MARKS, OWN].filter(Boolean).join(' '),
    // As a run under `pnpm test` has it, so the runner's dropping it is what lets the files run.
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8',
    ...extra,
  };
  const started = Date.now();
  const command = [process.execPath, runner, `--file-timeout=${fileTimeout}`, `--concurrency=${concurrency}`, ...files];
  const child = spawn(prefix[0] ?? command[0], [...prefix.slice(1), ...(prefix.length ? command : command.slice(1))], { cwd: frontend, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => {
    out += d;
    err += d;
  });
  const ended = new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve({ code, sig }));
    // Without this, a missing python3 threw past the `finally` and left the temp dir behind.
    child.once('error', (error) => resolve({ code: null, sig: null, error }));
  });
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
      hOrphaned: fs.existsSync(stampH),
      stamp: fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '',
    };
  });
  // Whether a process with any of these marks ever runs, sampled every 100 ms until the run ends.
  const seen = {};
  const watching = watchMarks.length
    ? setInterval(() => {
        for (const k of watchMarks) if (sleepsWith(marks[k]).length) seen[k] = true;
      }, 100)
    : null;
  // A reader that goes away: the runner's next write fails with EPIPE.
  if (closeStdoutAt) setTimeout(() => child.stdout.destroy(), closeStdoutAt).unref();
  // A reader that stops for a while and then goes on: the runner's write meets a full pipe.
  if (pauseStdout) {
    setTimeout(() => child.stdout.pause(), pauseStdout.from).unref();
    setTimeout(() => child.stdout.resume(), pauseStdout.to).unref();
  }
  for (const { sig, ms } of signals) {
    setTimeout(() => {
      try {
        process.kill(child.pid, sig);
      } catch {
        // gone
      }
    }, ms).unref();
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
  const { code, sig, error } = await ended;
  if (watching) {
    await sleep(500);
    clearInterval(watching);
  }
  check(!error, `${name}: the nested run could not be started: ${error?.message}`);
  clearTimeout(deadline);
  const ms = Date.now() - started;
  child.stdout.destroy();
  child.stderr.destroy();
  check(!deadlineFired, `${name}: the nested run was still going at ${DEADLINE_MS} ms and this test's deadline ended it`);
  outputs.push({ name, out });
  return { code, sig, ms, out, err, mid: await mid, marks, seen };
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
    check(r.mid.hOrphaned, "f-j: h's helper had not exited by S/2, so its sleep was not yet an orphan");
    for (const f of ['f-hides-its-marker.mjs', 'h-orphans-a-hidden-child.mjs']) {
      check(line(fixture(f), `still running after the ${S} ms bound for one file; everything found of it was killed$`).test(r.out), `f-j: no ✖ line names ${f} at its bound, everything killed`);
    }
    check(sleepsWith(r.marks.F).length === 0, "f-j: f's sleep is still running after the run");
    check(sleepsWith(r.marks.H).length === 0, "f-j: h's sleep is still running after the run");
    check(line(fixture('i-kills-its-runner.mjs'), 'exited 137').test(r.out), "f-j: no ✖ line names i for its runner's SIGKILL");
    check(/^… [0-9]+ bytes of its output were dropped here$/m.test(r.out), "f-j: j's report does not say its output was cut");
    check(/^j: the first line$/m.test(r.out), "f-j: j's first line was dropped, where an early error would be");
    check(/^ℹ files 4, passed 1, failed 3, /m.test(r.out), 'f-j: the run\'s summary line did not arrive');
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
    const r = await nested('SIGTERM', 3, [fixture('h-orphans-a-hidden-child.mjs')], { fileTimeout: 60_000, signals: [{ sig: 'SIGTERM', ms: S / 2 + 500 }] });
    check(r.mid.h > 0, "SIGTERM: h's sleep was not running at S/2");
    check(r.mid.hOrphaned, "SIGTERM: h's helper had not exited by S/2, so its sleep was not yet an orphan");
    check(r.code === 143, `SIGTERM: the runner exited ${r.code} (${r.sig}), not 143`);
    check(new RegExp(`^✖ ${FIX}/h-orphans-a-hidden-child\\.mjs: the runner received SIGTERM`, 'm').test(r.out), 'SIGTERM: no ✖ line names the file in flight');
    let left = sleepsWith(r.marks.H).length;
    for (let i = 0; i < 10 && left; i++) {
      await sleep(100);
      left = sleepsWith(r.marks.H).length;
    }
    check(left === 0, "SIGTERM: h's sleep is still running 1 s after the runner exited");
  }

  // 4. SIGHUP twice, 5 ms apart, as a closed terminal and then its shell send it: the second lands
  //    while the first abort is killing. With h, after its orphan is made.
  {
    const r = await nested('SIGHUP', 4, [fixture('h-orphans-a-hidden-child.mjs')], {
      fileTimeout: 60_000,
      signals: [{ sig: 'SIGHUP', ms: S / 2 + 500 }, { sig: 'SIGHUP', ms: S / 2 + 505 }],
    });
    check(r.mid.h > 0, "SIGHUP: h's sleep was not running at S/2");
    check(r.mid.hOrphaned, "SIGHUP: h's helper had not exited by S/2, so its sleep was not yet an orphan");
    check(r.code === 129, `SIGHUP: the runner exited ${r.code} (${r.sig}), not 129`);
    check(new RegExp(`^✖ ${FIX}/h-orphans-a-hidden-child\\.mjs: the runner received SIGHUP`, 'm').test(r.out), 'SIGHUP: no ✖ line names the file in flight');
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, "SIGHUP: h's sleep is still running 1 s after the runner exited");
  }

  // 5. SIGKILL, which nothing can handle: each file's watchdog kills what its file started once the
  //    runner is gone, inside the group (a) and outside it with no marker (f).
  {
    const r = await nested('SIGKILL', 5, ['a-blocks-in-spawnsync.mjs', 'f-hides-its-marker.mjs'].map(fixture), { fileTimeout: 60_000, signals: [{ sig: 'SIGKILL', ms: S / 2 + 500 }] });
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
    check(r.mid.hOrphaned, "closed terminal: h's helper had not exited by S/2, so its sleep was not yet an orphan");
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
    check(r.mid.hOrphaned, "EPIPE: h's helper had not exited by S/2, so its sleep was not yet an orphan");
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
  // 10. A spawn that fails, as a full process table or a moved node binary makes it: each file is
  //     named as never started, and the run fails, where it once exited 0 having run nothing.
  {
    const r = await nested('spawn fails', 10, ['passes.mjs', 'g-ends-its-child-soon.mjs'].map(fixture), { env: { BC_TEST_RUNNER_NODE: path.join(tmp, 'no-node') } });
    check(r.code === 1, `spawn fails: the runner exited ${r.code}, not 1`);
    for (const f of ['passes.mjs', 'g-ends-its-child-soon.mjs']) check(line(fixture(f), 'could not be started').test(r.out), `spawn fails: no ✖ line names ${f} as never started`);
  }

  // 11. SIGTERM while the reader has stopped: the abort's 400 KiB for l meet a full pipe, and are
  //     waited out once the reader goes on, so the line naming l still arrives.
  {
    const r = await nested('slow reader', 11, [fixture('l-prints-then-hangs.mjs')], {
      fileTimeout: 60_000,
      signals: [{ sig: 'SIGTERM', ms: S / 2 + 500 }],
      pauseStdout: { from: S / 2, to: S / 2 + 1500 },
    });
    check(r.code === 143, `slow reader: the runner exited ${r.code} (${r.sig}), not 143`);
    check(new RegExp(`^✖ ${FIX}/l-prints-then-hangs\\.mjs: the runner received SIGTERM`, 'm').test(r.out), 'slow reader: no ✖ line names l after the pipe filled');
    const named = r.out.search(/^✖ .*l-prints-then-hangs/m);
    check(named >= 0 && named < r.out.indexOf('l: yyy'), "slow reader: l's 400 KiB came before the line naming it");
  }

  // 12 and 13. The runner's own failure, inside main and outside it: what it runs is killed, h's
  //     orphan too, and the stack is printed. With h, faulted when k reports at 3 s, after the orphan.
  for (const [n, fault, code] of [[12, 'report', 2], [13, 'uncaught', 1]]) {
    const name = `fault ${fault}`;
    const r = await nested(name, n, ['h-orphans-a-hidden-child.mjs', 'k-passes-late.mjs'].map(fixture), { fileTimeout: 60_000, env: { BC_TEST_RUNNER_FAULT: fault } });
    check(r.mid.hOrphaned, `${name}: h's helper had not exited by S/2, so its sleep was not yet an orphan`);
    check(r.code === code, `${name}: the runner exited ${r.code} (${r.sig}), not ${code}`);
    check(/a fault injected/.test(r.err) && /\n {4}at /.test(r.err), `${name}: the runner did not print the fault's stack`);
    check(new RegExp(`^✖ ${FIX}/h-orphans-a-hidden-child\\.mjs: the runner failed while this file ran`, 'm').test(r.out), `${name}: no ✖ line names the file in flight`);
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, `${name}: h's sleep is still running after the runner ended`);
  }

  // 14. SIGQUIT (^\\) and SIGUSR2, handled like the others.
  for (const [n, sig, want] of [[14, 'SIGQUIT', 131], [20, 'SIGUSR2', 140]]) {
    const r = await nested(sig, n, [fixture('h-orphans-a-hidden-child.mjs')], { fileTimeout: 60_000, signals: [{ sig, ms: S / 2 + 500 }] });
    check(r.mid.hOrphaned, `${sig}: h's helper had not exited by S/2, so its sleep was not yet an orphan`);
    check(r.code === want, `${sig}: the runner exited ${r.code} (${r.sig}), not ${want}`);
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, `${sig}: h's sleep is still running 1 s after the runner exited`);
  }
  // 11b. SIGTERM with a reader that has stopped and never goes on: the runner still ends, within the
  //      2 s it waits for its output to move, and what it ran is killed.
  {
    const r = await nested('stopped reader', 16, [fixture('l-prints-then-hangs.mjs')], {
      fileTimeout: 60_000,
      signals: [{ sig: 'SIGTERM', ms: S / 2 + 500 }],
      pauseStdout: { from: S / 2, to: DEADLINE_MS * 2 },
    });
    check(r.code === 143, `stopped reader: the runner exited ${r.code} (${r.sig}), not 143`);
    check(r.ms < S / 2 + 500 + 8000, `stopped reader: the runner took ${r.ms} ms to end after SIGTERM with its reader stopped`);
  }

  // 16. The queue stops at an abort: with one slot, a, then h waiting. SIGTERM while a runs, the reader
  //     paused so the abort is still draining when a's slot frees: h must never start.
  {
    const r = await nested('queue', 17, ['a-blocks-in-spawnsync.mjs', 'h-orphans-a-hidden-child.mjs'].map(fixture), {
      fileTimeout: 60_000,
      concurrency: 1,
      signals: [{ sig: 'SIGTERM', ms: S / 2 + 500 }],
      pauseStdout: { from: S / 2, to: S / 2 + 1500 },
      watchMarks: ['H'],
    });
    check(r.mid.a > 0, "queue: a's sleep was not running at S/2");
    check(r.code === 143, `queue: the runner exited ${r.code} (${r.sig}), not 143`);
    check(!r.seen.H, 'queue: h, waiting behind a, started after the abort');
    check(!/h-orphans-a-hidden-child/.test(r.out), 'queue: a line names h, which should never have started');
  }

  // 17. A slow terminal: j's 16 MiB report is written to it synchronously while h's helper lives and
  //     exits. The poll must go on between the report's pieces, or h's orphan is never seen.
  {
    const r = await nested('slow terminal', 18, ['h-orphans-a-hidden-child.mjs', 'j-prints-a-lot.mjs'].map(fixture), {
      prefix: ['python3', path.join(frontend, FIX, 'read-slowly-on-a-terminal.py'), String(4 * 1024 * 1024)],
    });
    check(r.code !== 0, `slow terminal: the run exited ${r.code}, with h never ending`);
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, "slow terminal: h's sleep is still running after the run");
  }

  // 18. Too few file descriptors (EMFILE): Node returns before it sets up a child's stdio. Each file
  //     that could not start is named; the run does not fail as the runner's own bug.
  {
    const files = ['passes.mjs', 'g-ends-its-child-soon.mjs', 'k-passes-late.mjs'];
    const r = await nested('EMFILE', 19, files.map(fixture), { prefix: ['sh', '-c', 'ulimit -n 28; exec "$@"', 'sh'] });
    check(r.code === 1, `EMFILE: the runner exited ${r.code}, not 1`);
    for (const f of files) check(line(fixture(f), 'could not be started: spawn .*EMFILE').test(r.out), `EMFILE: no ✖ line names ${f} as never started`);
    check(!/TypeError/.test(r.out), 'EMFILE: the runner failed with a TypeError');
  }

  // 15. j alone, so its 16 MiB report is the last thing written before the summary: a runner that
  //     exits with output still queued for its pipe loses the end of it.
  {
    const r = await nested('j alone', 15, [fixture('j-prints-a-lot.mjs')]);
    check(/^ℹ files 1, passed 1, failed 0, /m.test(r.out), "j alone: the run's summary line did not arrive after j's report");
  }
} finally {
  ownPids().forEach(kill);
  for (const n of ALL_CASES) for (const m of Object.values(marksFor(n))) sleepsWith(m).forEach(kill);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// On a failure, what each nested run printed, its last 4 KB: on CI that is all there is to go on.
if (fails.length) for (const { name, out } of outputs) process.stderr.write(`\n--- ${name} ---\n${out.slice(-4096)}\n`);
assert.deepEqual(fails, [], 'the runner did not bound every file');

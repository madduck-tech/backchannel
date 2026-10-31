// `pnpm test`'s runner ends a file that never exits, by its path, and kills what the file started
// (#268, item 4). The fixtures in `scripts/test-runner-fixtures/` are the shapes Node's own flags miss,
// and the shapes each of the runner's three ways of finding a file's processes misses alone; they run
// here through `scripts/test-runner.mjs` with the bound shortened to S.
//
// Each run is sampled once, before any bound, to show its case's precondition was reached: a's sleep
// running, h's helper gone, l's output out. It is taken at S/2 at the earliest, so a bound that fires
// before S/2 has already killed what the sample looks for (#268's gate adversary, round 8: a sample at
// S/3 let a bound at 40% of S pass). One that fires between S/2 and S is caught by the duration its ✖
// line gives, which must be at least S: the line prints the configured bound whenever it fires (round 9).
// The duration includes the kill and drain after the bound, 20-30 ms without /proc and 150-330 ms with it,
// so case 2 holds a bound to within about 25 ms of S and cases 1 and 1b to within those few hundred
// (round 10). Not in the slow terminal's case: there j's report holds the event loop, so h's duration
// runs past S whatever its timer was set to. Past S/2 it waits only while its case's state is not yet reached, up
// to a second before S, since on a loaded runner a fixture starts late (CI run 41150739546: h's helper
// was still alive at 2 s). A case's signals, pauses, terminal close and k's report are timed from it, so
// none can land before the state they are meant to interrupt.
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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(fs.existsSync('/proc/self/stat'), 'this test reads /proc to find what the runner left, and this platform has none');

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = 'scripts/test-runner-fixtures';
const S = 6000;
const SAMPLE_MS = S / 2;
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
const ALL_CASES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

const outputs = [];

/** What a run's sample waits for, by the fixtures it runs: each one's sleep, d's stamp, h's orphan, l's output. */
const READY = { a: ['a'], c: ['c'], d: ['stamp'], f: ['f'], h: ['h', 'hOrphaned'], l: ['lPrinted'] };
const readyFor = (files) => files.flatMap((f) => READY[/^([a-z])-/.exec(path.basename(f))?.[1]] ?? []);

async function nested(name, n, files, { fileTimeout = S, env: extra = {}, runner = 'scripts/test-runner.mjs', signals = [], prefix = [], closeStdoutAt, pauseStdout, releaseK, concurrency = 4, watchMarks = [], ready = readyFor(files) } = {}) {
  const marks = marksFor(n);
  const stamp = path.join(tmp, `stamp-${n}`);
  const stampH = path.join(tmp, `stamp-h-${n}`);
  const stampL = path.join(tmp, `stamp-l-${n}`);
  const releaseFile = path.join(tmp, `release-k-${n}`);
  for (const m of Object.values(marks)) check(sleepsWith(m).length === 0, `${name}: a process already carries ${m} before the run`);
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(marks).map(([k, m]) => [`BC_HANG_MARK_${k}`, m])),
    BC_HANG_STAMP_D: stamp,
    BC_HANG_STAMP_H: stampH,
    BC_HANG_STAMP_L: stampL,
    BC_HANG_RELEASE_K: releaseFile,
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
  const sample = () => {
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
      lPrinted: fs.existsSync(stampL),
      stamp: fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '',
    };
  };
  // Every file's bound starts when the file does, after the run's, so S - 1000 is before them all.
  const mid = (async () => {
    for (;;) {
      const at = Date.now() - started;
      const s = sample();
      if ((at >= SAMPLE_MS && ready.every((k) => s[k])) || at >= S - 1000 || !s.running) return { ...s, at };
      await sleep(50);
    }
  })();
  // Whether a process with any of these marks ever runs, sampled every 100 ms until the run ends.
  const seen = {};
  const watching = watchMarks.length
    ? setInterval(() => {
        for (const k of watchMarks) if (sleepsWith(marks[k]).length) seen[k] = true;
      }, 100)
    : null;
  // A reader that goes away: the runner's next write fails with EPIPE.
  if (closeStdoutAt) setTimeout(() => child.stdout.destroy(), closeStdoutAt).unref();
  // After the sample: a reader that stops for a while and then goes on, so the runner's write meets a
  // full pipe; k's report; and the signals.
  mid.then(() => {
    if (releaseK !== undefined) setTimeout(() => fs.writeFileSync(releaseFile, ''), releaseK).unref();
    if (pauseStdout) {
      setTimeout(() => child.stdout.pause(), pauseStdout.from).unref();
      setTimeout(() => child.stdout.resume(), pauseStdout.to).unref();
    }
    for (const { sig, after } of signals) {
      setTimeout(() => {
        try {
          process.kill(child.pid, sig);
        } catch {
          // gone
        }
      }, after).unref();
    }
  });
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const line = (file, rest) => new RegExp(`^✖ ${esc(file)} — [0-9]+ ms: ${rest}`, 'm');
/** How long the runner says `file` ran when its bound ended it, or NaN if no line says so. */
const boundMs = (out, file) => Number(new RegExp(`^✖ ${esc(file)} — ([0-9]+) ms: still running after the `, 'm').exec(out)?.[1]);
const HUNG = ['a-blocks-in-spawnsync.mjs', 'b-awaits-forever.mjs', 'c-detached-child.mjs', 'd-holds-the-output.mjs'];

try {
  // 1. Every shape in one run, at concurrency 4, beside a file that passes and one whose child ends
  //    inside the grace.
  {
    const r = await nested('all', 1, [...HUNG, 'e-leaves-a-process.mjs', 'g-ends-its-child-soon.mjs', 'passes.mjs'].map(fixture));
    check(r.mid.running, 'all: the run had ended by the sample, before any bound');
    check(r.mid.a > 0, "all: a's sleep was not running at the sample, so its absence later would mean nothing");
    check(r.mid.aIsOwn, "all: a's sleep does not carry this test's marker, so the runner dropped the marker it inherited");
    check(r.mid.c > 0, "all: c's sleep was not running at the sample, so its absence later would mean nothing");
    check(/^[0-9]+$/.test(r.mid.stamp), "all: d's stamp holds no pid at the sample, so d never reached its spawn");
    check(r.ms <= S + 30_000, `all: the run took ${r.ms} ms, more than S + 30 s`);
    check(r.code !== 0, `all: the run exited ${r.code}, with four files that never end`);
    for (const f of HUNG) {
      check(line(fixture(f), `still running after the ${S} ms bound for one file; everything found of it was killed$`).test(r.out), `all: no ✖ line names ${f} at its bound, everything killed`);
      check(boundMs(r.out, fixture(f)) >= S, `all: ${f} was ended after ${boundMs(r.out, fixture(f))} ms, before its ${S} ms bound`);
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
    check(r.mid.f > 0, "f-j: f's sleep was not running at the sample, so its absence later would mean nothing");
    check(r.mid.h > 0, "f-j: h's sleep was not running at the sample, so its absence later would mean nothing");
    check(r.mid.hOrphaned, "f-j: h's helper had not exited by the sample, so its sleep was not yet an orphan");
    for (const f of ['f-hides-its-marker.mjs', 'h-orphans-a-hidden-child.mjs']) {
      check(line(fixture(f), `still running after the ${S} ms bound for one file; everything found of it was killed$`).test(r.out), `f-j: no ✖ line names ${f} at its bound, everything killed`);
      check(boundMs(r.out, fixture(f)) >= S, `f-j: ${f} was ended after ${boundMs(r.out, fixture(f))} ms, before its ${S} ms bound`);
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
    check(r.mid.a > 0, "no /proc: a's sleep was not running at the sample");
    check(line(fixture('a-blocks-in-spawnsync.mjs'), `still running after the ${S} ms bound`).test(r.out), 'no /proc: no ✖ line names a at its bound');
    check(boundMs(r.out, fixture('a-blocks-in-spawnsync.mjs')) >= S, `no /proc: a was ended after ${boundMs(r.out, fixture('a-blocks-in-spawnsync.mjs'))} ms, before its ${S} ms bound`);
    check(r.code !== 0, `no /proc: the run exited ${r.code}`);
    check(sleepsWith(r.marks.A).length === 0, "no /proc: a's sleep is still running after the run");
  }

  // 3. The runner ended with SIGTERM: what it ran goes with it, and is named. With h, signalled after
  //    its orphan is made: only the runner's poll knows that orphan, so the file's watchdog, which
  //    also kills on the runner's death, cannot stand in for the runner's own kill.
  {
    const r = await nested('SIGTERM', 3, [fixture('h-orphans-a-hidden-child.mjs')], { fileTimeout: 60_000, signals: [{ sig: 'SIGTERM', after: 500 }] });
    check(r.mid.h > 0, "SIGTERM: h's sleep was not running at the sample");
    check(r.mid.hOrphaned, "SIGTERM: h's helper had not exited by the sample, so its sleep was not yet an orphan");
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
      signals: [{ sig: 'SIGHUP', after: 500 }, { sig: 'SIGHUP', after: 505 }],
    });
    check(r.mid.h > 0, "SIGHUP: h's sleep was not running at the sample");
    check(r.mid.hOrphaned, "SIGHUP: h's helper had not exited by the sample, so its sleep was not yet an orphan");
    check(r.code === 129, `SIGHUP: the runner exited ${r.code} (${r.sig}), not 129`);
    check(new RegExp(`^✖ ${FIX}/h-orphans-a-hidden-child\\.mjs: the runner received SIGHUP`, 'm').test(r.out), 'SIGHUP: no ✖ line names the file in flight');
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, "SIGHUP: h's sleep is still running 1 s after the runner exited");
  }

  // 5. SIGKILL, which nothing can handle: each file's watchdog kills what its file started once the
  //    runner is gone, inside the group (a) and outside it with no marker (f).
  {
    const r = await nested('SIGKILL', 5, ['a-blocks-in-spawnsync.mjs', 'f-hides-its-marker.mjs'].map(fixture), { fileTimeout: 60_000, signals: [{ sig: 'SIGKILL', after: 500 }] });
    check(r.mid.a > 0 && r.mid.f > 0, "SIGKILL: a's or f's sleep was not running at the sample");
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
      prefix: ['python3', path.join(frontend, FIX, 'close-the-terminal.py')],
      signals: [{ sig: 'SIGUSR1', after: 500 }],
    });
    check(r.mid.c > 0 && r.mid.h > 0, "closed terminal: c's or h's sleep was not running at the sample");
    check(r.mid.hOrphaned, "closed terminal: h's helper had not exited by the sample, so its sleep was not yet an orphan");
    check(r.code !== 99, 'closed terminal: the runner was still running 20 s after its terminal closed');
    for (const k of ['C', 'H']) {
      for (let i = 0; i < 20 && sleepsWith(r.marks[k]).length; i++) await sleep(100);
      check(sleepsWith(r.marks[k]).length === 0, `closed terminal: ${k.toLowerCase()}'s sleep is still running after the terminal closed`);
    }
  }

  // 9. A reader that goes away (`pnpm test | head -1`): the runner's next write fails with EPIPE, and
  //    what it is running goes with it, long before the bound. The write is k's report, released half a
  //    second after the sample has seen h's orphan.
  {
    const r = await nested('EPIPE', 9, ['h-orphans-a-hidden-child.mjs', 'k-passes-late.mjs'].map(fixture), { fileTimeout: 60_000, closeStdoutAt: 300, releaseK: 500 });
    check(r.mid.h > 0, "EPIPE: h's sleep was not running at the sample");
    check(r.mid.hOrphaned, "EPIPE: h's helper had not exited by the sample, so its sleep was not yet an orphan");
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
      signals: [{ sig: 'SIGTERM', after: 500 }],
      pauseStdout: { from: 0, to: 1500 },
    });
    check(r.mid.lPrinted, "slow reader: l had not written its 400 KiB by the sample, so the abort met none of it");
    check(r.code === 143, `slow reader: the runner exited ${r.code} (${r.sig}), not 143`);
    check(new RegExp(`^✖ ${FIX}/l-prints-then-hangs\\.mjs: the runner received SIGTERM`, 'm').test(r.out), 'slow reader: no ✖ line names l after the pipe filled');
    const named = r.out.search(/^✖ .*l-prints-then-hangs/m);
    check(named >= 0 && named < r.out.indexOf('l: yyy'), "slow reader: l's 400 KiB came before the line naming it");
    // The names are small and get out at once; what l printed is what the drain is waited for.
    check(r.out.includes(`l: ${'y'.repeat(400 * 1024)}`), "slow reader: l's 400 KiB did not all arrive");
  }

  // 12 and 13. The runner's own failure, inside main and outside it: what it runs is killed, h's
  //     orphan too, and the stack is printed. With h, faulted when k reports, released half a second
  //     after the sample has seen the orphan.
  for (const [n, fault, code] of [[12, 'report', 2], [13, 'uncaught', 1]]) {
    const name = `fault ${fault}`;
    const r = await nested(name, n, ['h-orphans-a-hidden-child.mjs', 'k-passes-late.mjs'].map(fixture), { fileTimeout: 60_000, env: { BC_TEST_RUNNER_FAULT: fault }, releaseK: 500 });
    check(r.mid.hOrphaned, `${name}: h's helper had not exited by the sample, so its sleep was not yet an orphan`);
    check(r.code === code, `${name}: the runner exited ${r.code} (${r.sig}), not ${code}`);
    check(/a fault injected/.test(r.err) && /\n {4}at /.test(r.err), `${name}: the runner did not print the fault's stack`);
    check(new RegExp(`^✖ ${FIX}/h-orphans-a-hidden-child\\.mjs: the runner failed while this file ran`, 'm').test(r.out), `${name}: no ✖ line names the file in flight`);
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, `${name}: h's sleep is still running after the runner ended`);
  }

  // 14. SIGQUIT (^\\) and SIGUSR2, handled like the others.
  for (const [n, sig, want] of [[14, 'SIGQUIT', 131], [20, 'SIGUSR2', 140]]) {
    const r = await nested(sig, n, [fixture('h-orphans-a-hidden-child.mjs')], { fileTimeout: 60_000, signals: [{ sig, after: 500 }] });
    check(r.mid.hOrphaned, `${sig}: h's helper had not exited by the sample, so its sleep was not yet an orphan`);
    check(r.code === want, `${sig}: the runner exited ${r.code} (${r.sig}), not ${want}`);
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, `${sig}: h's sleep is still running 1 s after the runner exited`);
  }
  // 11b. SIGTERM with a reader that has stopped and never goes on: the runner still ends, within the
  //      2 s it waits for its output to move, and what it ran is killed.
  {
    const r = await nested('stopped reader', 16, [fixture('l-prints-then-hangs.mjs')], {
      fileTimeout: 60_000,
      signals: [{ sig: 'SIGTERM', after: 500 }],
      pauseStdout: { from: 0, to: DEADLINE_MS * 2 },
    });
    check(r.mid.lPrinted, "stopped reader: l had not written its 400 KiB by the sample, so the abort met none of it");
    check(r.code === 143, `stopped reader: the runner exited ${r.code} (${r.sig}), not 143`);
    check(r.ms < r.mid.at + 500 + 8000, `stopped reader: the runner took ${r.ms} ms to end, ${r.ms - r.mid.at - 500} ms after SIGTERM, with its reader stopped`);
    // An abort with nothing queued ends on its first tick, so a run that ended sooner than the 2 s rule never
    // met l's output in its pipe, and proves nothing about the rule (round 10).
    check(r.ms - r.mid.at - 500 >= 1900, `stopped reader: the runner ended ${r.ms - r.mid.at - 500} ms after SIGTERM, before the 2 s rule could act, so it held none of l's output`);
  }

  // 11c. SIGTERM with a reader that is slow but never stops, 64 KiB a second on a pipe: the abort's
  //      400 KiB for l take six seconds, three times the 2 s rule, and all of them arrive (#268's gate
  //      adversary, round 7: they were cut, since Node hands the queued pieces over as one write). l
  //      ends while that drains: it is still named once, and the run prints no summary, the abort's
  //      line being the run's last word.
  {
    const r = await nested('steady reader', 21, [fixture('l-prints-then-hangs.mjs')], {
      fileTimeout: 60_000,
      prefix: ['python3', path.join(frontend, FIX, 'read-slowly-on-a-pipe.py'), String(64 * 1024)],
      signals: [{ sig: 'SIGTERM', after: 500 }],
    });
    check(r.mid.lPrinted, "steady reader: l had not written its 400 KiB by the sample, so the abort met none of it");
    check(r.code === 143, `steady reader: the runner exited ${r.code} (${r.sig}), not 143`);
    check(r.out.includes(`l: ${'y'.repeat(400 * 1024)}`), `steady reader: l's 400 KiB did not all arrive (${r.out.length} bytes did)`);
    check(r.ms - r.mid.at > 500 + 5000, `steady reader: the run ended ${r.ms - r.mid.at - 500} ms after SIGTERM, too soon for 400 KiB at 64 KiB a second, so the reader was not slow`);
    const named = r.out.match(new RegExp(`^✖ ${FIX}/l-prints-then-hangs\\.mjs`, 'gm')) ?? [];
    check(named.length === 1, `steady reader: l is named ${named.length} times, where the abort names it once and nothing after`);
    check(!/^ℹ files |^✖ failed: /m.test(r.out), 'steady reader: the aborted run printed a summary after the abort');
  }

  // 16. The queue stops at an abort: with one slot, l first and h waiting. SIGTERM while l runs, the
  //     reader paused, so the abort is still draining l's 400 KiB when l's slot frees: h must never
  //     start. l's copy has an absolute path, which sorts before the fixtures' relative ones.
  {
    const first = path.join(tmp, 'l-first.mjs');
    fs.copyFileSync(path.join(frontend, FIX, 'l-prints-then-hangs.mjs'), first);
    const r = await nested('queue', 17, [first, fixture('h-orphans-a-hidden-child.mjs')], {
      fileTimeout: 60_000,
      concurrency: 1,
      signals: [{ sig: 'SIGTERM', after: 500 }],
      pauseStdout: { from: 0, to: 1500 },
      watchMarks: ['H'],
      // l's output, not h's orphan: h is queued behind l and must never start.
      ready: ['lPrinted'],
    });
    check(r.mid.lPrinted, "queue: l had not written its 400 KiB by the sample, so the abort met none of it");
    check(r.code === 143, `queue: the runner exited ${r.code} (${r.sig}), not 143`);
    check(!r.seen.H, 'queue: h, waiting behind l, started after the abort');
    check(!/h-orphans-a-hidden-child/.test(r.out), 'queue: a line names h, which should never have started');
    // The abort was still draining l when l's slot freed only if it held l's output (round 10).
    check(r.out.includes(`l: ${'y'.repeat(400 * 1024)}`), "queue: l's 400 KiB did not arrive, so the abort held none of it while l's slot freed");
  }

  // 17. A slow terminal: j's 16 MiB report is written to it synchronously while h's helper lives and
  //     exits. The poll must go on between the report's pieces, or h's orphan is never seen.
  {
    const r = await nested('slow terminal', 18, ['h-orphans-a-hidden-child.mjs', 'j-prints-a-lot.mjs'].map(fixture), {
      prefix: ['python3', path.join(frontend, FIX, 'read-slowly-on-a-terminal.py'), String(4 * 1024 * 1024)],
    });
    check(r.mid.hOrphaned, "slow terminal: h's helper had not exited by the sample, so its sleep was not yet an orphan");
    check(r.code !== 0, `slow terminal: the run exited ${r.code}, with h never ending`);
    for (let i = 0; i < 10 && sleepsWith(r.marks.H).length; i++) await sleep(100);
    check(sleepsWith(r.marks.H).length === 0, "slow terminal: h's sleep is still running after the run");
  }

  // 18. Too few file descriptors (EMFILE): Node returns before it sets up a child's stdio. Each file
  //     that could not start is named; the run does not fail as the runner's own bug.
  //     The limit is two above what a fresh node holds once started: inside the range where Node starts
  //     and a spawn, with its pipes, cannot, which ran from one below that count to six above it,
  //     measured with io_uring and without (below it, Node cannot open the runner). A fixed 28 was the top of that range here, and where the
  //     kernel refuses io_uring (Docker's default seccomp profile) Node holds three fewer, and 28 let
  //     the first file start (#268's gate adversary, round 7).
  {
    const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('fs').readdirSync('/proc/self/fd').length))"], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const atStart = Number(probe.stdout);
    check(Number.isInteger(atStart) && atStart >= 8 && atStart <= 64, `EMFILE: a fresh node holds ${probe.stdout} descriptors, so no limit can be set from it`);
    const files = ['passes.mjs', 'g-ends-its-child-soon.mjs', 'k-passes-late.mjs'];
    const r = await nested('EMFILE', 19, files.map(fixture), { prefix: ['sh', '-c', `ulimit -n ${atStart + 2}; exec "$@"`, 'sh'] });
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

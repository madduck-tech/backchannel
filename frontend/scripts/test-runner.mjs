#!/usr/bin/env node
// `pnpm test`'s runner (#268): Node's own runner, one file at a time per slot, with a bound on each
// file. Measured on 2026-10-27: a file that never exited held CI's "Frontend unit tests" for 79 min
// in silence, until GitHub cancelled it. `--test-timeout` cannot be that bound. It times `test()`
// bodies inside the file's process, and 76 of the 89 files have none; nor does it reach a test
// blocked in a synchronous call, a child a timed-out test left behind, or a grandchild holding the
// file's output (Node 24.14.0's runner, read; v5 of #268 measured three of the four).
//
// So each file runs as its own `node --test <file>`, under `test-runner-watchdog.mjs`, which leads a
// process group of its own and kills it if this runner dies. What the file starts is
// found three ways, because each misses something:
// - its group, which a child started with `detached: true` leaves;
// - a marker in its environment, which a process can overwrite: Chrome rewrites its process title
//   over that memory (#268's gate adversary, measured);
// - its process tree, read from /proc every POLL_MS while the file runs and again before any kill,
//   which loses a child the moment its parent dies.
// When the bound runs out, all of it is killed, and anything still alive afterwards is named. A file
// that exits but leaves a process running fails too: on the gate's laptop nothing else would ever end
// that process.
//
//   node scripts/test-runner.mjs --file-timeout=<ms> [--concurrency=<n>] [--node-arg=<flag>]... <glob>...

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The environment variable that carries every marker a process inherited, space-separated. */
export const MARKS = 'BC_TEST_MARKS';
/** How long a file that exited may take for what it started to go, before it counts as left. */
const LEFTOVER_GRACE_MS = 2000;
/** How long the pipes of a file that exited may stay open before they are closed from this side. */
const DRAIN_MS = 500;
/** How often each running file's process tree is read. */
const POLL_MS = 500;
/**
 * The most of one file's output kept: its first OUTPUT_HEAD bytes, where an early error is, and its
 * last bytes up to OUTPUT_CAP, where a summary is. What lies between is dropped, and the report says
 * how much and where.
 */
const OUTPUT_CAP = 16 * 1024 * 1024;
const OUTPUT_HEAD = 1024 * 1024;
// The summary block each `node --test <file>` prints. This runner prints one for the whole run.
const NODE_SUMMARY = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9.]+$/;
const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-runner-watchdog.mjs');
// The node that runs each file's watchdog. The behaviour test points it at nothing, to take the path a
// spawn that fails takes, which a full process table or a moved binary also takes.
const NODE = process.env.BC_TEST_RUNNER_NODE || process.execPath;
// The behaviour test's way into the runner's own failure paths: `report` throws inside main, and
// `uncaught` throws outside it. Nothing else sets it.
const FAULT = process.env.BC_TEST_RUNNER_FAULT;

export function parseArgs(argv) {
  const opts = { fileTimeoutMs: 0, concurrency: 4, nodeArgs: [], patterns: [] };
  for (const arg of argv) {
    let m;
    if ((m = /^--file-timeout=([1-9][0-9]*)$/.exec(arg))) opts.fileTimeoutMs = Number(m[1]);
    else if ((m = /^--concurrency=([1-9][0-9]*)$/.exec(arg))) opts.concurrency = Number(m[1]);
    else if ((m = /^--node-arg=(.+)$/.exec(arg))) opts.nodeArgs.push(m[1]);
    else if (arg.startsWith('--')) throw new Error(`test-runner: unknown option ${arg}`);
    else opts.patterns.push(arg);
  }
  if (!opts.fileTimeoutMs) throw new Error('test-runner: --file-timeout=<ms> is required; a file with no bound is what #268 removed');
  if (!opts.patterns.length) throw new Error('test-runner: no file pattern');
  return opts;
}

/** The files Node's runner would run for these patterns: globbed from `cwd`, sorted as it sorts them. */
export function testFiles(patterns, cwd) {
  const found = new Set();
  for (const pattern of patterns) {
    for (const f of fs.globSync(pattern, { cwd, exclude: (p) => path.basename(String(p)) === 'node_modules' })) found.add(f);
  }
  return [...found].sort();
}

/**
 * Every process's parent, group, start time and state, from /proc, or null where there is none
 * (macOS): there a file's group and its own process are all that is killed. `procRoot` is a parameter
 * so the behaviour test can take that path on Linux.
 */
export function snapshot(procRoot = '/proc') {
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return null;
  }
  const procs = new Map();
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(path.join(procRoot, name, 'stat'), 'latin1');
    } catch {
      continue;
    }
    // `pid (comm) state ppid pgrp …`; comm may hold spaces and parentheses, so read after the last one.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    procs.set(Number(name), { state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), start: f[19] });
  }
  return procs;
}

export function descendants(procs, root) {
  const children = new Map();
  for (const [pid, p] of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const out = [];
  for (const queue = [...(children.get(root) ?? [])]; queue.length; ) {
    const pid = queue.shift();
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** The pids whose environment carries `token` among its markers. Empty where there is no /proc. */
export function markedPids(token, procRoot = '/proc') {
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const pids = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name) || Number(name) === process.pid) continue;
    let environ;
    try {
      environ = fs.readFileSync(path.join(procRoot, name, 'environ'), 'latin1');
    } catch {
      continue; // gone, or another user's
    }
    const entry = environ.split('\0').find((e) => e.startsWith(`${MARKS}=`));
    if (entry && entry.slice(MARKS.length + 1).split(' ').includes(token)) pids.push(Number(name));
  }
  return pids;
}

function commandOf(pid, procRoot) {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'latin1').split('\0').filter(Boolean).join(' ') || '(no command line)';
  } catch {
    return '(gone)';
  }
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OWN_PGID = snapshot()?.get(process.pid)?.pgid;

/**
 * Record what a running file has started, so a process whose parent dies is still known. Never after
 * the file has exited: its pid may belong to another process by then.
 */
function track(run, procs) {
  if (run.exited) return;
  for (const pid of descendants(procs, run.child.pid)) run.seen.set(pid, procs.get(pid).start);
}

/** What a file started that is still alive: its tree now, what was seen of it before, its markers. */
function startedBy(run, procRoot) {
  const procs = snapshot(procRoot);
  const alive = new Map();
  if (!procs) return { procs, alive };
  track(run, procs);
  const live = (pid) => procs.has(pid) && procs.get(pid).state !== 'Z';
  for (const [pid, start] of run.seen) if (live(pid) && procs.get(pid).start === start) alive.set(pid, start);
  for (const pid of markedPids(run.token, procRoot)) if (live(pid)) alive.set(pid, procs.get(pid).start);
  return { procs, alive };
}

/**
 * Kill everything a file started: its group, its own process (Windows has no groups), and every
 * process found by `startedBy`, with the group of each. Returns what was aimed at, so a survivor can
 * be named rather than reported killed.
 */
function killFile(run, procRoot) {
  const { procs, alive } = startedBy(run, procRoot);
  // The file's own pid and group only while it runs: once it has exited and been reaped, that number
  // may be another process's. Its group is still reached through any member found alive.
  const groups = new Set(run.exited ? [] : [run.child.pid]);
  for (const pid of alive.keys()) {
    const g = procs.get(pid).pgid;
    if (g > 1 && g !== OWN_PGID) groups.add(g);
  }
  for (const g of groups) signal(-g, 'SIGKILL');
  if (!run.exited) signal(run.child.pid, 'SIGKILL');
  for (const pid of alive.keys()) signal(pid, 'SIGKILL');
  return alive;
}

/** Of the processes aimed at, the ones still alive after up to `ms`. */
async function survivors(aimed, procRoot, ms) {
  for (const until = Date.now() + ms; ; await sleep(100)) {
    const procs = snapshot(procRoot);
    const left = procs ? [...aimed].filter(([pid, start]) => procs.get(pid)?.start === start && procs.get(pid).state !== 'Z').map(([pid]) => pid) : [];
    if (!left.length || Date.now() >= until) return left;
  }
}

function runFile(file, index, opts, running) {
  const token = `bc-test-${process.pid}-${index}`;
  const env = { ...process.env };
  // A `node --test` that inherits this from an enclosing test run prints "run() is being called
  // recursively within a test file. skipping running files." and exits 0 (measured 2026-10-30).
  delete env.NODE_TEST_CONTEXT;
  env[MARKS] = [process.env[MARKS], token].filter(Boolean).join(' ');
  const started = Date.now();
  const child = spawn(NODE, [WATCHDOG, ...opts.nodeArgs, '--test', file], {
    cwd: opts.cwd,
    env,
    detached: true,
    // stdin is the watchdog's: held open, never written, so it closes exactly when this runner dies.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  const run = { file, token, child, head: [], headBytes: 0, output, bytes: 0, dropped: 0, seen: new Map(), timedOut: false, aimed: null };
  // Held until the file ends, so a file's lines are never interleaved with another's. Capped: past
  // 512 MiB the joined string cannot be built, and a hung file was then named nowhere.
  const collect = (d) => {
    if (run.headBytes < OUTPUT_HEAD) {
      run.head.push(d);
      run.headBytes += d.length;
      return;
    }
    output.push(d);
    run.bytes += d.length;
    while (run.headBytes + run.bytes > OUTPUT_CAP && output.length > 1) {
      const gone = output.shift();
      run.bytes -= gone.length;
      run.dropped += gone.length;
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  running.add(run);
  const timer = setTimeout(() => {
    run.timedOut = true;
    run.aimed = killFile(run, opts.procRoot);
  }, opts.fileTimeoutMs);
  const closed = Promise.all([child.stdout, child.stderr].map((s) => new Promise((r) => s.once('close', r))));

  return new Promise((resolve) => {
    let spawnError = null;
    let finished = false;
    // A spawn that fails emits `error` and never `exit`: the file then ends here, as could not be
    // started. Before, it never ended, main never settled, and the run exited 0 (#268's gate
    // adversary, round 4, measured with a moved node binary and a task limit).
    child.once('error', (e) => {
      spawnError = e;
      // A child that never started has no pid; Node sets its exitCode to the errno (-2 for ENOENT).
      if (!child.pid) finish(null, null);
    });
    // On `exit`, not on the pipes, so something the file left behind cannot hold the run open. Node's
    // inner runner owns the file's own pipes, so nothing reaches these in practice; this is defence.
    child.once('exit', (code, sig) => finish(code, sig));
    async function finish(code, sig) {
      if (finished) return;
      finished = true;
      run.exited = true;
      clearTimeout(timer);
      const reasons = [];
      if (spawnError) reasons.push(`could not be started: ${spawnError.message}`);
      let aimed;
      if (spawnError && !child.pid) {
        aimed = new Map();
      } else if (run.timedOut) {
        aimed = new Map([...run.aimed, ...killFile(run, opts.procRoot)]);
        reasons.push(`still running after the ${opts.fileTimeoutMs} ms bound for one file`);
      } else {
        // What the file started and left running, given the grace a cleanup needs: named, then killed.
        const left = await survivors(startedBy(run, opts.procRoot).alive, opts.procRoot, LEFTOVER_GRACE_MS);
        if (left.length) {
          reasons.push(`exited and left ${left.length} process(es) running: ${left.map((pid) => `${pid} ${commandOf(pid, opts.procRoot)}`).join('; ')}`);
        }
        if (code !== 0) reasons.push(sig ? `ended by ${sig}` : `exited ${code}`);
        aimed = killFile(run, opts.procRoot);
      }
      const alive = await survivors(aimed, opts.procRoot, 1000);
      if (alive.length) reasons.push(`${alive.length} process(es) it started survived the kill: ${alive.map((pid) => `${pid} ${commandOf(pid, opts.procRoot)}`).join('; ')}`);
      else if (run.timedOut) reasons.push('everything found of it was killed');
      await Promise.race([closed, sleep(DRAIN_MS)]);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      running.delete(run);
      resolve({ file, ms: Date.now() - started, ok: reasons.length === 0, reasons, output: outputOf(run) });
    }
  });
}

function outputOf(run) {
  const head = Buffer.concat(run.head).toString('utf8');
  const tail = Buffer.concat(run.output).toString('utf8');
  return run.dropped ? `${head}\n… ${run.dropped} bytes of its output were dropped here\n${tail}` : head + tail;
}

function body(output) {
  return output
    .split('\n')
    .filter((l) => !NODE_SUMMARY.test(l))
    .join('\n')
    .trimEnd();
}

function report(result, write) {
  // An abort has the output from here on; a file that ends while it drains is not reported twice.
  if (active.aborting) return;
  if (FAULT === 'report') throw new Error('a fault injected into report()');
  if (FAULT === 'uncaught') {
    setTimeout(() => {
      throw new Error('a fault injected outside main');
    });
  }
  const text = body(result.output);
  if (text) write(`${text}\n`);
  write(result.ok ? `✔ ${result.file} — ${result.ms} ms\n` : `✖ ${result.file} — ${result.ms} ms: ${result.reasons.join('; ')}\n`);
}


// What an abort needs, whichever path reaches it: a signal, an output error, an exception, or main's
// own rejection.
const active = { running: new Set(), procRoot: '/proc', aborting: false };

/**
 * End this runner early. What it is running is killed first and reported after: a closed terminal
 * sends SIGHUP and then fails every write with EIO, a reader that went away (`| head -1`) fails it
 * with EPIPE, and a write placed before the kills threw and nothing was killed (round 2, measured
 * with a real pty). A SIGKILL cannot be handled here: each file's watchdog answers it.
 *
 * The report goes through the same streams as everything before it, so its lines keep their place,
 * and the runner exits once they have drained, or once nothing has moved for 2 s: a reader that has
 * stopped is waited for, one that is gone is not. Synchronous writes were tried and dropped: a 16 MiB
 * report written that way stopped the poll for as long as it took, and an orphan made meanwhile was
 * never seen (#268, round 5, measured).
 */
function abort(why, code, error) {
  if (active.aborting) return;
  active.aborting = true;
  const running = active.running;
  for (const run of running) killFile(run, active.procRoot);
  try {
    for (const run of running) {
      const text = body(outputOf(run));
      process.stdout.write(`${text ? `${text}\n` : ''}✖ ${run.file}: ${why}; what was found of it was killed\n`);
    }
    if (error) process.stderr.write(`test-runner: ${error.stack ?? error}\n`);
  } catch {
    // the terminal or the reader is gone
  }
  let pending = Infinity;
  let moved = Date.now();
  setInterval(() => {
    const now = process.stdout.writableLength + process.stderr.writableLength;
    if (now === 0) process.exit(code);
    if (now < pending) {
      pending = now;
      moved = Date.now();
    } else if (Date.now() - moved > 2000) {
      process.exit(code);
    }
  }, 20);
}

export async function main(argv, { cwd = process.cwd(), procRoot = process.env.BC_TEST_PROC_ROOT || '/proc', write = (s) => process.stdout.write(s) } = {}) {
  const opts = { ...parseArgs(argv), cwd, procRoot };
  const files = testFiles(opts.patterns, cwd);
  if (!files.length) {
    write(`✖ no file matches ${opts.patterns.join(' ')}\n`);
    return 1;
  }
  if (!snapshot(procRoot)) {
    write(`ℹ ${procRoot} cannot be read here: a file's processes outside its own group are neither found nor killed\n`);
  }
  const started = Date.now();
  const running = new Set();
  const results = [];
  const poll = setInterval(() => {
    const procs = snapshot(procRoot);
    if (procs) for (const run of running) track(run, procs);
  }, POLL_MS);
  poll.unref();
  active.running = running;
  active.procRoot = procRoot;
  // `on`, not `once`: a closed terminal sends SIGHUP twice, once from the terminal and once from its
  // shell, and with `once` the second took the default action halfway through the abort (#268's gate
  // adversary, round 3). A repeat while the abort runs is ignored by the abort itself.
  // The signals whose default ends a process and that a person or a tool sends: ^C, ^\\, a closed
  // terminal, `kill`, and SIGUSR2. Others (SIGUSR1 is Node's inspector) are left alone; the watchdog
  // answers a runner they end, except for what only this runner's poll knew.
  for (const [sig, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGQUIT', 131], ['SIGUSR2', 140], ['SIGTERM', 143]]) {
    process.on(sig, () => abort(`the runner received ${sig}`, code));
  }
  process.stdout.on('error', (e) => abort(`the runner's output failed (${e.code})`, 1));
  process.on('uncaughtException', (e) => abort('the runner failed while this file ran', 1, e));

  let next = 0;
  // Files start in sorted order, as Node's runner starts them, so a hang's report time follows from
  // the order: the first file that never exits starts by the time a healthy run would end.
  const slot = async () => {
    while (next < files.length) {
      const index = next++;
      const result = await runFile(files[index], index, opts, running);
      results.push(result);
      report(result, write);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, slot));
  clearInterval(poll);

  const failed = results.filter((r) => !r.ok);
  write(`ℹ files ${results.length}, passed ${results.length - failed.length}, failed ${failed.length}, ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  for (const r of failed) write(`✖ failed: ${r.file}\n`);
  return failed.length ? 1 : 0;
}

// Run when invoked as a script. The two sides are compared as resolved paths: `import.meta.url` is
// percent-encoded, so against a raw `argv[1]` a path with a space or a non-ASCII letter never matched,
// and `pnpm test` exited 0 having run nothing (#268's gate adversary, measured).
//
// The status is 1 until main has said otherwise, so a run whose loop drains without main settling
// cannot exit 0. A rejection goes through the abort, so a bug in the runner still kills what is running.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = 1;
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => abort('the runner failed while this file ran', 2, e)
  );
}

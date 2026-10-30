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
// The summary block each `node --test <file>` prints. This runner prints one for the whole run.
const NODE_SUMMARY = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9.]+$/;
const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-runner-watchdog.mjs');

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

function descendants(procs, root) {
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
  const groups = new Set([run.child.pid]);
  for (const pid of alive.keys()) {
    const g = procs.get(pid).pgid;
    if (g > 1 && g !== OWN_PGID) groups.add(g);
  }
  for (const g of groups) signal(-g, 'SIGKILL');
  signal(run.child.pid, 'SIGKILL');
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
  const child = spawn(process.execPath, [WATCHDOG, ...opts.nodeArgs, '--test', file], {
    cwd: opts.cwd,
    env,
    detached: true,
    // stdin is the watchdog's: held open, never written, so it closes exactly when this runner dies.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (d) => output.push(d));
  child.stderr.on('data', (d) => output.push(d));
  const run = { file, token, child, output, seen: new Map(), timedOut: false, aimed: null };
  running.add(run);
  const timer = setTimeout(() => {
    run.timedOut = true;
    run.aimed = killFile(run, opts.procRoot);
  }, opts.fileTimeoutMs);
  const closed = Promise.all([child.stdout, child.stderr].map((s) => new Promise((r) => s.once('close', r))));

  return new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (e) => (spawnError = e));
    // On `exit`, not on the pipes, so something the file left behind cannot hold the run open. Node's
    // inner runner owns the file's own pipes, so nothing reaches these in practice; this is defence.
    child.once('exit', async (code, sig) => {
      run.exited = true;
      clearTimeout(timer);
      const reasons = [];
      if (spawnError) reasons.push(`could not be started: ${spawnError.message}`);
      if (running.interrupted) return;
      let aimed;
      if (run.timedOut) {
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
      else if (run.timedOut) reasons.push('everything it started was killed');
      await Promise.race([closed, sleep(DRAIN_MS)]);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      running.delete(run);
      resolve({ file, ms: Date.now() - started, ok: reasons.length === 0, reasons, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

function body(output) {
  return output
    .split('\n')
    .filter((l) => !NODE_SUMMARY.test(l))
    .join('\n')
    .trimEnd();
}

function report(result, write) {
  const text = body(result.output);
  if (text) write(`${text}\n`);
  write(result.ok ? `✔ ${result.file} — ${result.ms} ms\n` : `✖ ${result.file} — ${result.ms} ms: ${result.reasons.join('; ')}\n`);
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
  // A terminal closed or a session dropped sends SIGHUP; Ctrl-C SIGINT. Each file in flight is named,
  // with what it printed, and killed. Written synchronously: on macOS a piped stdout is asynchronous,
  // and process.exit would drop it. A SIGKILL cannot be handled; each file's watchdog answers that.
  const interrupt = (sig) => {
    running.interrupted = true;
    for (const run of running) {
      const text = body(Buffer.concat(run.output).toString('utf8'));
      fs.writeSync(1, `${text ? `${text}\n` : ''}✖ ${run.file}: the runner received ${sig}; its processes were killed\n`);
      killFile(run, procRoot);
    }
    process.exit({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[sig]);
  };
  for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(sig, interrupt);

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
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
  );
}

#!/usr/bin/env node
// `pnpm test`'s runner (#268): Node's own runner, one file at a time per slot, with a bound on each
// file. Measured on 2026-10-27: a file that never exited held CI's "Frontend unit tests" for 79 min
// in silence, until GitHub cancelled it. `--test-timeout` cannot be that bound. It times `test()`
// bodies inside the file's process, and 76 of the 89 files have none; nor does it reach a test
// blocked in a synchronous call, a child a timed-out test left behind, or a grandchild holding the
// file's output (Node 24.14.0's runner, read; v5 of #268 measured three of the four).
//
// So each file runs as its own `node --test <file>`, in a process group of its own, with a marker in
// its environment. When the bound runs out, its group is killed and so is every process whose
// environment carries its marker. The marker reaches a grandchild started with `detached: true`,
// which the group does not. A file that exits but leaves a marked process running fails too: on the
// gate's laptop nothing else would ever end that process.
//
//   node scripts/test-runner.mjs --file-timeout=<ms> [--concurrency=<n>] [--node-arg=<flag>]... <glob>...

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The environment variable that carries every marker a process inherited, space-separated. */
export const MARKS = 'BC_TEST_MARKS';
/** How long a file that exited may take for its marked processes to go, before they count as left. */
const LEFTOVER_GRACE_MS = 2000;
/** How long the pipes of a file that exited may stay open before they are closed from this side. */
const DRAIN_MS = 500;
// The summary block each `node --test <file>` prints. This runner prints one for the whole run.
const NODE_SUMMARY = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9.]+$/;

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
 * The pids whose environment carries `token` among its markers, or null where there is no `/proc`
 * to read (macOS): there a file's group is all that is killed. `procRoot` is a parameter so the
 * behaviour test can take the macOS path on Linux.
 */
export function markedPids(token, procRoot = '/proc') {
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return null;
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
    return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'latin1').split('\0').filter(Boolean).join(' ');
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

/** Kill a file's process group, then every process carrying its marker. */
function killFile(run, procRoot) {
  signal(-run.child.pid, 'SIGKILL');
  for (const pid of markedPids(run.token, procRoot) ?? []) signal(pid, 'SIGKILL');
}

function runFile(file, index, opts, running) {
  const token = `bc-test-${process.pid}-${index}`;
  const env = { ...process.env };
  // A `node --test` that inherits this from an enclosing test run prints "run() is being called
  // recursively within a test file. skipping running files." and exits 0 (measured 2026-10-30).
  delete env.NODE_TEST_CONTEXT;
  env[MARKS] = [process.env[MARKS], token].filter(Boolean).join(' ');
  const started = Date.now();
  const child = spawn(process.execPath, [...opts.nodeArgs, '--test', file], {
    cwd: opts.cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (d) => output.push(d));
  child.stderr.on('data', (d) => output.push(d));
  const run = { file, token, child, timedOut: false };
  running.add(run);
  const timer = setTimeout(() => {
    run.timedOut = true;
    killFile(run, opts.procRoot);
  }, opts.fileTimeoutMs);
  const closed = Promise.all([child.stdout, child.stderr].map((s) => new Promise((r) => s.once('close', r))));

  return new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (e) => (spawnError = e));
    // On `exit`, not on the pipes: something the file left behind can hold them open.
    child.once('exit', async (code, sig) => {
      clearTimeout(timer);
      const reasons = [];
      if (spawnError) reasons.push(`could not be started: ${spawnError.message}`);
      if (run.timedOut) {
        reasons.push(`still running after the ${opts.fileTimeoutMs} ms bound for one file; its processes were killed`);
      } else if (!running.interrupted) {
        // A file that exited and left a marked process running: named, then killed.
        let left = markedPids(token, opts.procRoot) ?? [];
        for (const until = Date.now() + LEFTOVER_GRACE_MS; left.length && Date.now() < until; ) {
          await sleep(100);
          left = markedPids(token, opts.procRoot) ?? [];
        }
        if (left.length) {
          const named = left.map((pid) => `${pid} ${commandOf(pid, opts.procRoot)}`).join('; ');
          reasons.push(`exited and left ${left.length} process(es) running: ${named}`);
        }
        if (code !== 0) reasons.push(sig ? `ended by ${sig}` : `exited ${code}`);
      }
      killFile(run, opts.procRoot);
      await Promise.race([closed, sleep(DRAIN_MS)]);
      child.stdout.destroy();
      child.stderr.destroy();
      running.delete(run);
      resolve({ file, ms: Date.now() - started, ok: reasons.length === 0, reasons, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

function report(result, write) {
  const body = result.output
    .split('\n')
    .filter((l) => !NODE_SUMMARY.test(l))
    .join('\n')
    .trimEnd();
  if (body) write(`${body}\n`);
  write(result.ok ? `✔ ${result.file} — ${result.ms} ms\n` : `✖ ${result.file} — ${result.ms} ms: ${result.reasons.join('; ')}\n`);
}

export async function main(argv, { cwd = process.cwd(), procRoot = process.env.BC_TEST_PROC_ROOT || '/proc', write = (s) => process.stdout.write(s) } = {}) {
  const opts = { ...parseArgs(argv), cwd, procRoot };
  const files = testFiles(opts.patterns, cwd);
  if (!files.length) {
    write(`✖ no file matches ${opts.patterns.join(' ')}\n`);
    return 1;
  }
  const started = Date.now();
  const running = new Set();
  const results = [];
  const interrupt = (sig) => {
    running.interrupted = true;
    for (const run of running) {
      write(`✖ ${run.file}: the runner received ${sig}; its processes were killed\n`);
      killFile(run, procRoot);
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);

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

  const failed = results.filter((r) => !r.ok);
  write(`ℹ files ${results.length}, passed ${results.length - failed.length}, failed ${failed.length}, ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  for (const r of failed) write(`✖ failed: ${r.file}\n`);
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
  );
}

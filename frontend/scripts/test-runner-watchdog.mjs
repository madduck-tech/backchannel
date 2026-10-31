// What `scripts/test-runner.mjs` starts for each file (#268): `node --test <file>` under a watchdog. It
// leads the file's process group, runs the file, and passes its exit status back. If the runner dies,
// by any signal, SIGKILL included, the watchdog kills what the file started: its own process tree,
// every process carrying the file's marker, the group of each, and its own group last. Without it, a
// runner killed with its group left every file it was running orphaned, in sessions of their own
// (#268's gate adversary, measured). Unlike the runner it does not poll the tree, so a child already
// orphaned when the runner dies is found only by its marker.
//
// How it knows: its stdin is a pipe the runner holds open and never writes, so it reads end-of-file
// exactly when the runner is gone. Not `process.ppid`, which Node reads once at startup; and not a
// `--import` into `node --test`, which Node runs in the file's process only.
//
//   node scripts/test-runner-watchdog.mjs <node flags…> --test <file>

import { spawn } from 'node:child_process';
import os from 'node:os';
import { MARKS, descendants, markedPids, snapshot } from './test-runner.mjs';

const signal = (pid, sig) => {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
};

// The file's own marker is the last one this process inherited.
const token = (process.env[MARKS] ?? '').split(' ').filter(Boolean).pop();

function killAll() {
  const procs = snapshot();
  const found = new Set(procs ? descendants(procs, process.pid) : []);
  if (token) for (const pid of markedPids(token)) found.add(pid);
  const own = procs?.get(process.pid)?.pgid;
  const groups = new Set();
  for (const pid of found) {
    const g = procs?.get(pid)?.pgid;
    if (g > 1 && g !== own) groups.add(g);
  }
  for (const g of groups) signal(-g, 'SIGKILL');
  for (const pid of found) signal(pid, 'SIGKILL');
  signal(0, 'SIGKILL');
}
process.stdin.once('end', killAll);
process.stdin.once('error', killAll);
process.stdin.resume();

const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', (e) => {
  process.stderr.write(`test-runner-watchdog: could not start node: ${e.message}\n`);
  process.exit(1);
});
// A `node --test` ended by a signal reads as 128 + its number, never as the 0 process.exit(null) gives.
child.once('exit', (code, sig) => process.exit(sig ? 128 + (os.constants.signals[sig] ?? 0) : code));

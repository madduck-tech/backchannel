// What `scripts/test-runner.mjs` starts for each file (#268): `node --test <file>` under a watchdog. It
// leads the file's process group, runs the file, and passes its exit status back. If the runner dies,
// by any signal, SIGKILL included, the watchdog kills its own group, which is the file's. Without it, a
// runner killed with its group left every file it was running orphaned, in sessions of their own,
// where today's single `node --test` left only a detached grandchild (#268's gate adversary, measured).
//
// How it knows: its stdin is a pipe the runner holds open and never writes, so it reads end-of-file
// exactly when the runner is gone. Not `process.ppid`, which Node reads once at startup; and not a
// `--import` into `node --test`, which Node runs in the file's process only.
//
//   node scripts/test-runner-watchdog.mjs <node flags…> --test <file>

import { spawn } from 'node:child_process';

const killGroup = () => {
  try {
    process.kill(0, 'SIGKILL');
  } catch {
    // nothing left to kill
  }
};
process.stdin.once('end', killGroup);
process.stdin.once('error', killGroup);
process.stdin.resume();

const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', (e) => {
  process.stderr.write(`test-runner-watchdog: could not start node: ${e.message}\n`);
  process.exit(1);
});
child.once('exit', (code, sig) => process.exit(sig ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[sig] ?? 0) : code));

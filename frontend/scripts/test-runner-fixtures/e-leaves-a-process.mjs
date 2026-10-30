import { spawnSync } from 'node:child_process';

const mark = process.env.BC_HANG_MARK_E;
if (!mark) {
  console.error('BC_HANG_MARK_E is not set');
  process.exit(3);
}
// A daemon's shape: the shell backgrounds `sleep` and exits at once, so `sleep` is orphaned before
// anything can read it as this file's child. Only the marker it inherited says whose it is.
spawnSync('sh', ['-c', `sleep ${mark} >/dev/null 2>&1 &`], { stdio: 'ignore' });

import { spawnSync } from 'node:child_process';

const mark = process.env.BC_HANG_MARK_A;
if (!mark) {
  console.error('BC_HANG_MARK_A is not set');
  process.exit(3);
}
spawnSync('sleep', [mark], { stdio: 'ignore' });

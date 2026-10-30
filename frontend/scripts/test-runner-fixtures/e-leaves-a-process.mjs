import { spawn } from 'node:child_process';

const mark = process.env.BC_HANG_MARK_E;
if (!mark) {
  console.error('BC_HANG_MARK_E is not set');
  process.exit(3);
}
spawn('sleep', [mark], { detached: true, stdio: 'ignore' }).unref();

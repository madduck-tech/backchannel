import { spawn } from 'node:child_process';
import { test } from 'node:test';

const mark = process.env.BC_HANG_MARK_F;
if (!mark) {
  console.error('BC_HANG_MARK_F is not set');
  process.exit(3);
}
// Chrome's shape (browser.mjs:59): detached, so outside the file's group, and with no marker to read,
// because Chrome overwrites its environment with its process title. `env -i` stands in for that.
test('a detached child whose environment carries nothing', async () => {
  spawn('env', ['-i', 'sleep', mark], { detached: true, stdio: 'ignore' });
  await new Promise(() => {});
});

import { spawn } from 'node:child_process';
import { test } from 'node:test';

const mark = process.env.BC_HANG_MARK_C;
if (!mark) {
  console.error('BC_HANG_MARK_C is not set');
  process.exit(3);
}
test('a detached child kept ref-ed', async () => {
  spawn('sleep', [mark], { detached: true, stdio: 'ignore' });
  await new Promise(() => {});
});

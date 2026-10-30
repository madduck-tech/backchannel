import { spawn } from 'node:child_process';
import { test } from 'node:test';

const mark = process.env.BC_HANG_MARK_H;
if (!mark) {
  console.error('BC_HANG_MARK_H is not set');
  process.exit(3);
}
// A helper starts a sleep with no marker and exits 2 s later, while the file still runs: the sleep is
// orphaned before the bound, outside the file's group, so only what the runner saw of the tree while
// the helper lived says whose it is.
test('a hidden child its helper orphans', async () => {
  spawn('sh', ['-c', `env -i sleep ${mark} & sleep 2`], { detached: true, stdio: 'ignore' });
  await new Promise(() => {});
});

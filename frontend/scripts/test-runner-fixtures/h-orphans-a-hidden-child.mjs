import { spawn } from 'node:child_process';
import { test } from 'node:test';

const mark = process.env.BC_HANG_MARK_H;
const stamp = process.env.BC_HANG_STAMP_H;
if (!mark || !stamp) {
  console.error('BC_HANG_MARK_H or BC_HANG_STAMP_H is not set');
  process.exit(3);
}
// A helper starts a sleep with no marker and exits 1.2 s later, while the file still runs: the sleep is
// orphaned before the bound, outside the file's group, so only what the runner saw of the tree while
// the helper lived says whose it is. The helper writes the stamp as it exits, so a test can tell an
// orphan from a sleep whose helper is still there.
test('a hidden child its helper orphans', async () => {
  spawn('sh', ['-c', `env -i sleep ${mark} & sleep 1.2; : > "$1"`, 'sh', stamp], { detached: true, stdio: 'ignore' });
  await new Promise(() => {});
});

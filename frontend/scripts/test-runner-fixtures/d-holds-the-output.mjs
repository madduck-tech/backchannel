import { spawn } from 'node:child_process';
import fs from 'node:fs';

const mark = process.env.BC_HANG_MARK_D;
const stamp = process.env.BC_HANG_STAMP_D;
if (!mark || !stamp) {
  console.error('BC_HANG_MARK_D or BC_HANG_STAMP_D is not set');
  process.exit(3);
}
const child = spawn('sleep', [mark], { stdio: 'inherit' });
fs.writeFileSync(stamp, String(child.pid));
child.unref();

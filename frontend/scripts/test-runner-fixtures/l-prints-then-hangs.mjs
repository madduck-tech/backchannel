// 400 KiB of output, then a hang: what an abort has to write for it is several pipes' worth, so a
// reader that pauses fills the pipe and the write meets EAGAIN. Once the write is out, it writes
// BC_HANG_STAMP_L, so a test can tell an abort that met l's output from one that came before it.
import fs from 'node:fs';

process.stdout.write(`l: ${'y'.repeat(400 * 1024)}\n`, () => {
  if (process.env.BC_HANG_STAMP_L) fs.writeFileSync(process.env.BC_HANG_STAMP_L, '');
});
setInterval(() => {}, 1 << 30);

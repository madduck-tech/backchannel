// 400 KiB of output, then a hang: what an abort has to write for it is several pipes' worth, so a
// reader that pauses fills the pipe and the write meets EAGAIN. Once the write has been handed on, to the
// `node --test` the runner reads, it writes BC_HANG_STAMP_L, so a test can tell an abort that came after
// l's write from one that came before it; whether the runner then has all of it is held by each l case's
// own checks.
import fs from 'node:fs';

process.stdout.write(`l: ${'y'.repeat(400 * 1024)}\n`, (error) => {
  if (!error && process.env.BC_HANG_STAMP_L) fs.writeFileSync(process.env.BC_HANG_STAMP_L, '');
});
setInterval(() => {}, 1 << 30);

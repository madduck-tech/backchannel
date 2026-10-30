// 400 KiB of output, then a hang: what an abort has to write for it is several pipes' worth, so a
// reader that pauses fills the pipe and the write meets EAGAIN.
process.stdout.write(`l: ${'y'.repeat(400 * 1024)}\n`);
setInterval(() => {}, 1 << 30);

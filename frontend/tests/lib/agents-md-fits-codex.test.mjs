// Every chain of AGENTS.md files Codex reads fits under its 32 KiB cap. (#233, #250)
//
// Codex reads every AGENTS.md from the git root down to the directory it starts in, and cuts the
// concatenation at 32 KiB in total, silently: a 20 039-byte root and a 14 035-byte nested file, read
// from frontend/, kept 12 730 bytes of the nested one (measured on #233). What it cuts is the end,
// and the end of the root file is the testing rules. So for every directory holding an AGENTS.md,
// the sum of the chain from the root to it stays under 32 768 bytes, less a margin of one byte per
// line: a Windows checkout with core.autocrlf adds exactly that.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CAP = 32 * 1024;

test('every AGENTS.md chain fits under Codex\'s cap, with room for CRLF', () => {
  const files = execFileSync('git', ['-C', repo, 'ls-files', '--', 'AGENTS.md', '*/AGENTS.md'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(files.includes('AGENTS.md'), 'there is no root AGENTS.md');
  assert.ok(files.includes('frontend/AGENTS.md'), 'frontend/AGENTS.md is gone; this test lost its second chain');
  for (const f of files) {
    const dirs = path.dirname(f) === '.' ? [''] : ['', ...path.dirname(f).split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))];
    const chain = dirs.map((d) => (d ? `${d}/AGENTS.md` : 'AGENTS.md')).filter((c) => files.includes(c));
    const text = chain.map((c) => fs.readFileSync(path.join(repo, c), 'utf8').replace(/\r\n/g, '\n'));
    const bytes = text.reduce((n, s) => n + Buffer.byteLength(s), 0);
    const lines = text.reduce((n, s) => n + s.split('\n').length, 0);
    assert.ok(bytes + lines <= CAP,
      `${chain.join(' + ')} is ${bytes} bytes and ${lines} lines; Codex keeps ${CAP}, and a CRLF checkout adds a byte a line. Move something out of the always-loaded instructions.`);
  }
});

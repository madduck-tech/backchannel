// Every `.claude/…` path a tracked file cites still resolves. (#233, #250)
//
// The product owner kept .claude/ as the one source so that the paths already cited across the
// repository stay valid: 25 files cited 34 of them on 2026-10-27, four of them in accepted ADRs.
// A rename under .claude/ would break them silently, so each backticked `.claude/…` path in a
// tracked file must exist. A trailing `:<line>` is dropped, a `*` must match something, and a path
// built in code (`${…}`) or written as a pattern (`.claude/…`) is not a citation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('every backticked .claude/ path in a tracked file resolves', () => {
  const files = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const broken = []; let cited = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/`(\.claude\/[^`\s]*)`/g)) {
      const cite = m[1].replace(/:\d+(-\d+)?$/, '');
      if (cite.includes('${') || cite.includes('…')) continue;
      cited++;
      const ok = cite.includes('*')
        ? (() => { const dir = path.join(repo, path.dirname(cite)); const re = new RegExp(`^${path.basename(cite).replace(/[.+?^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
          return fs.existsSync(dir) && fs.readdirSync(dir).some((n) => re.test(n)); })()
        : fs.existsSync(path.join(repo, cite));
      if (!ok) broken.push(`${f}: \`${m[1]}\``);
    }
  }
  assert.ok(cited >= 30, `only ${cited} citations found; the census reads nothing`);
  assert.deepEqual(broken, [], `cited paths under .claude/ that do not exist:\n  ${broken.join('\n  ')}`);
});

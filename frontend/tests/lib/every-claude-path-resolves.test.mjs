// Every `.claude/…` and `.agents/…` path a tracked file cites still resolves, or is retired by an ADR. (#233, #250, #271)
//
// 25 files cited 34 `.claude/` paths on 2026-10-27, four of them in accepted ADRs, and a rename under
// .claude/ would break them silently. Since #271 (ADR 0033) .claude/ is generated from .agents/, and
// the two rules every session loads, .claude/rules/workflow.md and testing.md, moved into AGENTS.md.
// So each backticked `.claude/…` or `.agents/…` path in a tracked file must exist, or be in RETIRED, which admits it
// only in docs/decisions/: an accepted ADR is superseded, never rewritten, and everything else is
// re-pointed. A trailing `:<line>` is dropped, a `*` must match something, and a path built in code
// (`${…}`) or written as a pattern (`.claude/…`) is not a citation; `{a,b}` cites each.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// A path that no longer exists -> the ADR that retired it.
export const RETIRED = {
  '.claude/rules/workflow.md': 'ADR 0033',
  '.claude/rules/testing.md': 'ADR 0033',
};

// A `*` must match at least one entry of its directory.
function resolves(cite) {
  if (!cite.includes('*')) return fs.existsSync(path.join(repo, cite));
  const dir = path.join(repo, path.dirname(cite));
  const re = new RegExp(`^${path.basename(cite).replace(/[.+?^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return fs.existsSync(dir) && fs.readdirSync(dir).some((n) => re.test(n));
}

test('every backticked .claude/ and .agents/ path in a tracked file resolves', () => {
  const files = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const broken = []; let cited = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/`(\.(?:claude|agents)\/[^`\s]*)`/g)) {
      const cite = m[1].replace(/:\d+(-\d+)?$/, '');
      if (cite.includes('${') || cite.includes('…')) continue;
      // `{a,b}` is shell brace expansion: each alternative is cited.
      const braces = /\{([^{}]+)\}/.exec(cite);
      for (const one of braces ? braces[1].split(',').map((alt) => cite.replace(braces[0], alt)) : [cite]) {
        cited++;
        if (!resolves(one) && !(one in RETIRED && f.startsWith('docs/decisions/'))) broken.push(`${f}: \`${m[1]}\``);
      }
    }
  }
  assert.ok(cited >= 30, `only ${cited} citations found; the census reads nothing`);
  assert.deepEqual(broken, [], `cited paths under .claude/ or .agents/ that do not exist:\n  ${broken.join('\n  ')}`);
});

test('every retired path names the ADR that retired it, and no longer exists', () => {
  for (const [p, adr] of Object.entries(RETIRED)) {
    assert.match(adr, /^ADR \d{4}$/, `${p} is retired without an ADR`);
    assert.ok(!fs.existsSync(path.join(repo, p)), `${p} is retired but exists`);
  }
});

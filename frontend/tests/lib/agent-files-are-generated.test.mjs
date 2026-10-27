// What Codex and opencode read is generated from .claude/, and has not drifted. (#233, #249)
//
// `.claude/` is the one source (the product owner's decision of 2026-10-27), and every file another
// harness reads is generated from it by scripts/gen-agent-files.mjs, as a copy rather than a symlink,
// for Windows. scripts/agent-files.json names each generated file and its source. This holds the
// committed files to what the generator would write now, after normalizing line endings, and holds
// every file under a generated directory to the list, so a copy left behind is drift too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { drift, plan, LIST } = await import(path.join(repo, 'scripts', 'gen-agent-files.mjs'));

test('every generated file matches its source, and the list names exactly them', () => {
  const problems = drift(repo);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nRun: node scripts/gen-agent-files.mjs`);
});

test('the list names the three gopnik skills in .agents/skills/, each from .claude/skills/', () => {
  const { files } = JSON.parse(fs.readFileSync(path.join(repo, LIST), 'utf8'));
  for (const name of ['gopnik', 'gopnik-critic', 'gopnik-setup']) {
    assert.equal(files[`.agents/skills/${name}/SKILL.md`], `.claude/skills/${name}/SKILL.md`, `${name} is not delivered to .agents/skills/`);
  }
  assert.equal(Object.keys(files).length, plan(repo).size);
});

test('nothing is generated under frontend/, whose agent files belong to Next.js', () => {
  const { files } = JSON.parse(fs.readFileSync(path.join(repo, LIST), 'utf8'));
  const under = Object.keys(files).filter((f) => f.startsWith('frontend/'));
  assert.deepEqual(under, []);
});

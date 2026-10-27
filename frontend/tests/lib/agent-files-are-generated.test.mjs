// What Codex and opencode read is generated from .claude/, and has not drifted. (#233, #249)
//
// `.claude/` is the one source (the product owner's decision of 2026-10-27), and every file another
// harness reads is generated from it by scripts/gen-agent-files.mjs, as a copy rather than a symlink,
// for Windows. scripts/agent-files.json names each generated file and its source. The first test
// holds the committed files to what the generator would write now; the rest run the generator in a
// fixture repository, because the cases worth holding -- a CRLF checkout, a file somebody else put
// under .agents/, an ignored .DS_Store, a link -- must not be made in the real one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = path.join(repo, 'scripts', 'gen-agent-files.mjs');
const { drift, plan, LIST, AGENTS_SOURCES, AGENTS_END } = await import(GEN);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-'));
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));

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

test('the root AGENTS.md is CLAUDE.md\'s section and the two unscoped rules, and ends with its sentinel', () => {
  const { files } = JSON.parse(fs.readFileSync(path.join(repo, LIST), 'utf8'));
  assert.deepEqual(files['AGENTS.md'], AGENTS_SOURCES);
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  for (const rule of ['.claude/rules/workflow.md', '.claude/rules/testing.md']) {
    const last = fs.readFileSync(path.join(repo, rule), 'utf8').trimEnd().split('\n').at(-1);
    assert.ok(agents.includes(last), `AGENTS.md does not carry the last line of ${rule}`);
  }
  assert.ok(agents.trimEnd().endsWith(AGENTS_END), 'AGENTS.md does not end with its sentinel');
  assert.ok(!agents.includes('## Inherited codebase guide'), 'the inherited guide is back in the always-loaded instructions');
});

test('nothing is generated under frontend/, whose agent files belong to Next.js', () => {
  const { files } = JSON.parse(fs.readFileSync(path.join(repo, LIST), 'utf8'));
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith('frontend/')), []);
});

// A repository of its own: the generator, the list, both skill trees and .gitattributes, committed.
function fixture(name) {
  const r = path.join(base, name);
  for (const p of ['scripts/gen-agent-files.mjs', LIST, '.claude/skills', '.claude/rules', 'CLAUDE.md', 'AGENTS.md', '.agents', '.gitattributes']) {
    fs.cpSync(path.join(repo, p), path.join(r, p), { recursive: true });
  }
  const git = (...a) => spawnSync('git', ['-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'fixture');
  return { r, git, gen: (...a) => spawnSync('node', [path.join(r, 'scripts', 'gen-agent-files.mjs'), ...a], { encoding: 'utf8' }) };
}
const crlf = (p) => fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('a CRLF checkout of either tree is not drift', () => {
  for (const tree of ['.claude/skills', '.agents/skills']) {
    const { r } = fixture(`crlf-${tree.split('/')[0].slice(1)}`);
    for (const f of walk(path.join(r, tree))) crlf(f);
    assert.deepEqual(drift(r), [], `${tree} in CRLF read as drift`);
  }
});

test('a file under .agents/ that nothing generated is drift, and the generator refuses rather than delete it', () => {
  const { r, gen } = fixture('stray');
  const mine = path.join(r, '.agents', 'skills', 'mine', 'SKILL.md');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, '---\nname: mine\n---\nput here by npx skills add\n');
  assert.ok(drift(r).some((p) => p.startsWith('.agents/skills/mine/SKILL.md is not generated')), 'an unnamed file under .agents/ is not drift');
  const w = gen();
  assert.notEqual(w.status, 0, `the generator wrote over a file it did not write:\n${w.stdout}${w.stderr}`);
  assert.match(w.stderr, /\.agents\/skills\/mine\/SKILL\.md is under a generated directory, and nothing generated it/);
  assert.ok(fs.existsSync(mine), 'the generator deleted a file it never wrote');
});

test('a copy whose source is gone is removed, because the list named it', () => {
  const { r, gen } = fixture('gone');
  fs.rmSync(path.join(r, '.claude', 'skills', 'gopnik-setup'), { recursive: true });
  const w = gen();
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /removed \.agents\/skills\/gopnik-setup\/SKILL\.md, which its source no longer generates/);
  assert.ok(!fs.existsSync(path.join(r, '.agents', 'skills', 'gopnik-setup', 'SKILL.md')));
  assert.deepEqual(drift(r), []);
});

test('every skill under .claude/skills/ is a source, and an ignored file is not', () => {
  const { r } = fixture('sources');
  fs.mkdirSync(path.join(r, '.claude', 'skills', 'release-notes'));
  fs.writeFileSync(path.join(r, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
  fs.writeFileSync(path.join(r, '.gitignore'), '.DS_Store\n');
  fs.writeFileSync(path.join(r, '.claude', 'skills', 'gopnik', '.DS_Store'), 'finder');
  const files = plan(r);
  assert.ok(files.has('.agents/skills/release-notes/SKILL.md'), 'a new skill under .claude/skills/ would reach opencode and not Codex');
  assert.ok(![...files.keys()].some((f) => f.endsWith('.DS_Store')), 'an ignored file became a source');
});

test('a link under .agents/ is drift, whether it replaces a copy or stands alone', () => {
  const { r } = fixture('links');
  const copy = path.join(r, '.agents', 'skills', 'gopnik', 'SKILL.md');
  fs.rmSync(copy);
  fs.symlinkSync(path.join(r, '.claude', 'skills', 'gopnik', 'SKILL.md'), copy);
  fs.symlinkSync(path.join(r, '.claude', 'skills', 'gopnik'), path.join(r, '.agents', 'skills', 'helper'));
  const problems = drift(r);
  assert.ok(problems.includes('.agents/skills/gopnik/SKILL.md is a link; a generated file is a copy'), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('.agents/skills/helper is not generated')), problems.join('\n'));
});

test('--check reports drift when the checkout is reached through a link', () => {
  const { r } = fixture('via-link');
  fs.appendFileSync(path.join(r, '.agents', 'skills', 'gopnik', 'SKILL.md'), 'edited by hand\n');
  const link = path.join(base, 'via-link-alias');
  fs.symlinkSync(r, link);
  const c = spawnSync('node', [path.join(link, 'scripts', 'gen-agent-files.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(c.status, 1, `--check through a link exited ${c.status}:\n${c.stdout}${c.stderr}`);
  assert.match(c.stderr, /\.agents\/skills\/gopnik\/SKILL\.md differs/);
});

test('.gitattributes stores both skill trees with LF', () => {
  const attrs = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
  for (const tree of ['.claude/skills/**', '.agents/**']) assert.match(attrs, new RegExp(`^${tree.replace(/[.*]/g, '\\$&')} text=auto eol=lf$`, 'm'));
});

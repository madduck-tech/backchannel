// What every harness reads is generated from the harness-neutral sources, and has not drifted. (#271, ADR 0033)
//
// The sources are AGENTS.md, .agents/rules/, .agents/skills/ and .agents/commands/ (the product owner's
// decision of 2026-10-28, which reversed #233's). Claude Code reads none of .agents/ and, with Next.js's
// frontend/CLAUDE.md on its startup chain, no root AGENTS.md either, so scripts/gen-agent-files.mjs
// gives it copies: CLAUDE.md is AGENTS.md whole, .claude/ is .agents/ byte for byte. A copy, never an
// `@` import: the root's import did not reach a session started in frontend/, and an import in a
// scoped rule loads at session start (measured on 2.1.312, #271). The first tests hold the committed
// files; the rest run the generator in a fixture repository, because the cases worth holding -- a CRLF
// checkout, a hand edit, a file somebody else put under a generated directory, a link -- must not be
// made in the real one.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = path.join(repo, 'scripts', 'gen-agent-files.mjs');
const { drift, lint, plan, write, atTokens, LIST, AGENTS_END, MARKER, NOT_DELIVERED, scopedRules } = await import(GEN);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-'));
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
const read = (r, f) => fs.readFileSync(path.join(r, f), 'utf8').replace(/\r\n/g, '\n');

test('every generated file matches its source, and the list names exactly them', () => {
  const problems = drift(repo);
  assert.deepEqual(problems, [], `${problems.join('\n')}\n\nRun: node scripts/gen-agent-files.mjs`);
});

test('CLAUDE.md is AGENTS.md whole, under a generated header, and imports nothing', () => {
  const header = `<!-- ${MARKER} from AGENTS.md. Edit that and re-run it; never this file. -->\n\n`;
  assert.equal(read(repo, 'CLAUDE.md'), header + read(repo, 'AGENTS.md'));
  const { files } = JSON.parse(read(repo, LIST));
  assert.equal(files['CLAUDE.md'], 'AGENTS.md');
});

// Six literal strings, written here rather than read from the files that held them before #271, which
// are gone: reading the last line of AGENTS.md's testing section from AGENTS.md would prove nothing.
const KEPT = [
  '**No text injection into other applications without a verified caret anchor.**',
  'Do not add `enigo`, `rdev`, or a CGEventTap.',
  '  never implied. A readiness claim without a gopnik verdict is not made.',
  '- macOS and Windows are verified by CI builds only (ADR 0005). A verdict names them as not proven and\n  never implies them.',
];
const GONE = [
  ['## Inherited codebase guide', 'the inherited guide is back in the always-loaded instructions'],
  [/Co-Authored-By: Claude [A-Z]\w+ \d/, 'the instructions tell every harness to sign as one Claude model'],
];
test('AGENTS.md and CLAUDE.md keep the rules that must reach every session, and not what moved out', () => {
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const text = read(repo, f);
    for (const s of KEPT) assert.ok(text.includes(s), `${f} lost: ${s}`);
    for (const [s, why] of GONE) assert.ok(typeof s === 'string' ? !text.includes(s) : !s.test(text), `${f}: ${why}`);
  }
  assert.ok(read(repo, 'AGENTS.md').trimEnd().endsWith(AGENTS_END), 'AGENTS.md does not end with its sentinel');
});

test('an @path token is what Claude Code would import, and nothing else', () => {
  assert.deepEqual(atTokens('@x.md at the start'), ['@x.md']);
  assert.deepEqual(atTokens('read the notes, see @x.md for details'), ['@x.md']);
  assert.deepEqual(atTokens('mail noreply@anthropic.com, or `@x.md` in a span, or `actions/checkout@v5`'), []);
  assert.deepEqual(atTokens('```\n@x.md\n```\nafter'), []);
  for (const f of ['AGENTS.md', 'CLAUDE.md', ...fs.readdirSync(path.join(repo, '.agents/rules')).map((n) => `.agents/rules/${n}`), ...fs.readdirSync(path.join(repo, '.claude/rules')).map((n) => `.claude/rules/${n}`)]) {
    assert.deepEqual(atTokens(read(repo, f)), [], `${f} has an @path Claude Code would import`);
  }
});

test('the scoped rules are copied to .claude/rules/ with their paths, and AGENTS.md indexes each glob', () => {
  const rules = scopedRules(repo);
  assert.ok(rules.length >= 3, `only ${rules.length} scoped rules found`);
  const agents = read(repo, 'AGENTS.md');
  for (const [f, globs] of rules) {
    assert.ok(f.startsWith('.agents/rules/'), f);
    assert.equal(read(repo, f.replace('.agents/', '.claude/')), read(repo, f), `${f}'s copy differs`);
    const row = agents.split('\n').find((l) => l.startsWith(`| \`${f}\` |`));
    assert.ok(row, `${f} is not in the index`);
    for (const g of globs) assert.ok(row.includes(`\`${g}\``), `${f}'s row does not name ${g}`);
  }
  assert.ok(agents.includes('| `frontend/AGENTS.md` | `frontend/**`'), 'the index does not name frontend/AGENTS.md');
  assert.deepEqual(lint(repo), []);
});

test('the skills reach Claude Code as copies, and the gopnik three come from .agents/skills/', () => {
  const { files } = JSON.parse(read(repo, LIST));
  for (const name of ['gopnik', 'gopnik-critic', 'gopnik-setup']) {
    assert.equal(files[`.claude/skills/${name}/SKILL.md`], `.agents/skills/${name}/SKILL.md`, `${name} is not copied to .claude/skills/`);
    assert.ok(!(`.agents/skills/${name}/SKILL.md` in files), `${name} in .agents/skills/ is generated; it is a source`);
  }
  assert.equal(Object.keys(files).length, plan(repo).size);
});

test('the commands reach Claude Code as copies, Codex as skills and opencode as commands, with the issue number where each puts it', () => {
  const { files } = JSON.parse(read(repo, LIST));
  const r = (f) => read(repo, f);
  for (const name of ['critique', 'issue', 'work']) {
    assert.equal(files[`.claude/commands/${name}.md`], `.agents/commands/${name}.md`, `${name} is not a Claude Code command`);
    assert.equal(files[`.agents/skills/${name}/SKILL.md`], `.agents/commands/${name}.md`, `${name} is not a skill`);
    assert.equal(files[`.opencode/command/${name}.md`], `.agents/commands/${name}.md`, `${name} is not an opencode command`);
    assert.match(r(`.agents/skills/${name}/SKILL.md`), new RegExp(`^---\nname: ${name}\ndescription: .+\n---\n`), `${name}'s skill has no name and description`);
  }
  for (const name of ['critique', 'work']) {
    // In Codex `$issue` names the skill that opens GitHub issues.
    assert.ok(!r(`.agents/skills/${name}/SKILL.md`).includes('$issue'), `${name}'s skill still says $issue, which Codex reads as the issue skill`);
    assert.match(r(`.opencode/command/${name}.md`), /\*\*\$1\*\*/, `${name}'s opencode command does not put the argument where the command had it`);
    assert.ok(!r(`.opencode/command/${name}.md`).includes('$issue'), `${name}'s opencode command still says $issue`);
    // opencode's last placeholder takes every remaining word; a $2 after the number keeps $1 to one.
    assert.match(r(`.opencode/command/${name}.md`), /\$2\s*$/, `${name}'s opencode command ends without a $2, so $1 would take every word`);
    assert.ok(!fs.existsSync(path.join(repo, `.agents/skills/${name}/agents/openai.yaml`)), `${name} should stay implicitly invocable`);
  }
  assert.match(r('.agents/skills/issue/agents/openai.yaml'), /^policy:\n  allow_implicit_invocation: false$/m, 'Codex may invoke issue without being asked');
  const agents = r('AGENTS.md');
  assert.ok(agents.includes('`$work N` in Codex') && agents.includes('`/work N` in Claude Code and opencode'), 'AGENTS.md does not say how to start the cycle in each harness');
  assert.deepEqual(JSON.parse(r('opencode.json')).permission?.skill, { issue: 'ask' }, 'opencode does not ask before the issue skill, or asks before another');
  assert.deepEqual(files['opencode.json'], ['.agents/commands/issue.md'], 'opencode.json is not generated from the commands');
});

// What reaches each harness is judged by what the files contain, never by what the generator says it
// read (#251's adversary). A source reaches Claude Code when its copy is byte-equal (CLAUDE.md for
// AGENTS.md), Codex and opencode when they read it where it is (AGENTS.md, .agents/skills/), through
// the index (a scoped rule) or as a generated skill and command (a command).
function carried(f) {
  const r = (p) => (fs.existsSync(path.join(repo, p)) ? read(repo, p) : null);
  const agents = r('AGENTS.md') ?? '';
  if (f === 'AGENTS.md') return r('CLAUDE.md')?.endsWith(agents) ?? false;
  const copy = r(f.replace(/^\.agents\//, '.claude/')) === r(f);
  if (f.startsWith('.agents/rules/')) {
    const scoped = Object.fromEntries(scopedRules(repo));
    const row = agents.split('\n').find((l) => l.startsWith(`| \`${f}\` |`));
    return copy && !!row && (scoped[f] ?? []).every((g) => row.includes(`\`${g}\``));
  }
  if (f.startsWith('.agents/skills/')) return copy;
  if (f.startsWith('.agents/commands/')) {
    const name = path.basename(f, '.md');
    const description = /^description:\s*(.+)$/m.exec(r(f))?.[1];
    return copy && !!description && [`.agents/skills/${name}/SKILL.md`, `.opencode/command/${name}.md`].every((p) => (r(p) ?? '').includes(description));
  }
  return false;
}

test('every source reaches all three harnesses, or the not-delivered table says why, and not both', () => {
  const table = JSON.parse(read(repo, NOT_DELIVERED)).files;
  const { files } = JSON.parse(read(repo, LIST));
  const sources = ['AGENTS.md', ...execFileSync('git', ['-C', repo, 'ls-files', '--', '.agents'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)]
    .filter((f) => !(f in files));
  const missing = sources.filter((f) => !carried(f) && !(f in table));
  assert.deepEqual(missing, [], `sources whose content does not reach every harness, with no reason in ${NOT_DELIVERED}`);
  const stale = Object.keys(table).filter((f) => carried(f) || !sources.includes(f));
  assert.deepEqual(stale, [], `${NOT_DELIVERED} lists files that are carried, or that are not sources`);
  for (const [f, why] of Object.entries(table)) assert.ok(why.length > 20, `${f}: the table says not delivered, and not why`);
});

test('nothing is generated under frontend/, whose agent files belong to Next.js', () => {
  const { files } = JSON.parse(read(repo, LIST));
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith('frontend/')), []);
});

// A repository of its own: the generator, the list, the sources and every copy, committed.
function fixture(name) {
  const r = path.join(base, name);
  for (const p of ['scripts/gen-agent-files.mjs', LIST, NOT_DELIVERED, 'AGENTS.md', 'CLAUDE.md', '.agents', '.claude', 'frontend/AGENTS.md', '.opencode', 'opencode.json', '.gitattributes']) {
    fs.cpSync(path.join(repo, p), path.join(r, p), { recursive: true });
  }
  const git = (...a) => spawnSync('git', ['-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'fixture');
  return { r, git, gen: (...a) => spawnSync('node', [path.join(r, 'scripts', 'gen-agent-files.mjs'), ...a], { encoding: 'utf8' }) };
}
const crlf = (p) => fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const has = (problems, re) => problems.some((p) => re.test(p));

test('a hand edit to any copy is drift: CLAUDE.md, a rule, a skill, a command', () => {
  for (const f of ['CLAUDE.md', '.claude/rules/docs.md', '.claude/skills/gopnik/SKILL.md', '.claude/commands/work.md']) {
    const { r } = fixture(`edit-${f.replace(/[/.]/g, '_')}`);
    fs.appendFileSync(path.join(r, f), 'edited by hand\n');
    assert.ok(has(drift(r), new RegExp(`^${f.replace(/\./g, '\\.')} differs from`)), `a hand edit to ${f} is not drift:\n${drift(r).join('\n')}`);
  }
});

test('a source changed without regenerating is drift', () => {
  const { r } = fixture('stale');
  fs.writeFileSync(path.join(r, '.agents/rules/release.md'), '---\npaths:\n  - "release/**"\n---\n# Release rules\n');
  const problems = drift(r);
  assert.ok(has(problems, /^\.claude\/rules\/release\.md is missing/), problems.join('\n'));
  assert.ok(has(problems, /index lacks the row \| `\.agents\/rules\/release\.md` \|/), problems.join('\n'));
});

test('a file under a generated directory that nothing generated is drift, and the generator refuses rather than delete it', () => {
  for (const f of ['.claude/rules/mine.md', '.agents/skills/work/notes.md']) {
    const { r, gen } = fixture(`stray-${f.replace(/[/.]/g, '_')}`);
    fs.writeFileSync(path.join(r, f), 'put here by hand\n');
    assert.ok(has(drift(r), new RegExp(`^${f.replace(/\./g, '\\.')} is not generated`)), `${f} is not drift:\n${drift(r).join('\n')}`);
    const w = gen();
    assert.notEqual(w.status, 0, `the generator wrote over a file it did not write:\n${w.stdout}${w.stderr}`);
    assert.match(w.stderr, /is under a generated directory, and nothing generated it/);
    assert.ok(fs.existsSync(path.join(r, f)), 'the generator deleted a file it never wrote');
  }
});

test('a source skill named like a command is drift, never a second source', () => {
  const { r } = fixture('collision');
  fs.writeFileSync(path.join(r, '.agents/skills/work/EXTRA.md'), 'a hand-written skill file\n');
  assert.ok(has(drift(r), /^\.agents\/skills\/work\/EXTRA\.md is not generated/), drift(r).join('\n'));
  assert.ok(!plan(r).has('.claude/skills/work/EXTRA.md'), 'a command\'s skill directory became a source');
});

test('a command removed without regenerating is drift, and its skill is not taken for a source', () => {
  const { r, git, gen } = fixture('command-gone');
  git('rm', '-q', '.agents/commands/work.md');
  const problems = drift(r);
  assert.ok(has(problems, /^\.agents\/skills\/work\/SKILL\.md is not generated/), problems.join('\n'));
  assert.ok(![...plan(r).keys()].some((f) => f.startsWith('.claude/skills/work/')), 'the leftover command skill was copied as a source skill');
  const w = gen();
  assert.equal(w.status, 0, w.stderr);
  assert.ok(!fs.existsSync(path.join(r, '.agents/skills/work/SKILL.md')), 'the command\'s skill outlived the command');
  assert.deepEqual(drift(r), []);
});

test('a source skill that says it is generated is an error', () => {
  const { r } = fixture('marked');
  fs.mkdirSync(path.join(r, '.agents/skills/old'), { recursive: true });
  fs.writeFileSync(path.join(r, '.agents/skills/old/SKILL.md'), `---\nname: old\n---\n<!-- ${MARKER} from .agents/commands/old.md. -->\n`);
  assert.ok(has(lint(r), /^\.agents\/skills\/old\/SKILL\.md carries/), lint(r).join('\n'));
});

test('an @path, a rule without paths: and a stale index row are each an error', () => {
  const cases = [
    ['AGENTS.md', (t) => t.replace('# Backchannel: instructions for coding agents', '@notes.md\n\n# Backchannel: instructions for coding agents'), /AGENTS\.md has @notes\.md/],
    ['AGENTS.md', (t) => t.replace('Read the index every session.', 'Read the index every session, see @notes.md.'), /AGENTS\.md has @notes\.md/],
    ['.agents/rules/docs.md', (t) => t.replace(/^---\npaths:[\s\S]*?---\n/, ''), /docs\.md has no `paths:`/],
    ['.agents/rules/docs.md', (t) => t.replace('- "docs/**"', '- "documentation/**"'), /index lacks the row \| `\.agents\/rules\/docs\.md` \| `documentation\/\*\*`/],
    // The rule is named in code, so the census of cited paths does not read it as a citation.
    ['AGENTS.md', (t) => t.replace('| `frontend/AGENTS.md` |', `| \`.agents/rules/${'gone'}.md\` | \`gone/**\` |\n| \`frontend/AGENTS.md\` |`), /index has a row no scoped rule gives: \| `\.agents\/rules\/gone\.md`/],
    ['AGENTS.md', (t) => t.split('\n').filter((l) => !l.startsWith('| `frontend/AGENTS.md`')).join('\n'), /index lacks the row \| `frontend\/AGENTS\.md`/],
  ];
  cases.forEach(([f, edit, want], i) => {
    const { r } = fixture(`lint-${i}`);
    const before = read(r, f);
    const after = edit(before);
    assert.notEqual(after, before, `case ${i} changed nothing in ${f}; the anchor no longer matches`);
    fs.writeFileSync(path.join(r, f), after);
    assert.ok(has(lint(r), want), `case ${i}: ${want} not reported:\n${lint(r).join('\n')}`);
  });
});

test('a CRLF checkout of the sources or the copies is not drift', () => {
  for (const tree of ['.agents', '.claude']) {
    const { r } = fixture(`crlf-${tree.slice(1)}`);
    for (const f of walk(path.join(r, tree))) crlf(f);
    assert.deepEqual(drift(r), [], `${tree} in CRLF read as drift`);
  }
});

test('a copy whose source is gone is removed, because the list named it', () => {
  const { r, gen } = fixture('gone');
  fs.rmSync(path.join(r, '.agents', 'skills', 'gopnik-setup'), { recursive: true });
  const w = gen();
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /removed \.claude\/skills\/gopnik-setup\/SKILL\.md, which its source no longer generates/);
  assert.ok(!fs.existsSync(path.join(r, '.claude', 'skills', 'gopnik-setup', 'SKILL.md')));
  assert.deepEqual(drift(r), []);
});

test('every skill under .agents/skills/ that no command generates is a source, tracked or not, and an ignored file is not', () => {
  const { r } = fixture('sources');
  fs.mkdirSync(path.join(r, '.agents', 'skills', 'release-notes'));
  fs.writeFileSync(path.join(r, '.agents', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
  fs.writeFileSync(path.join(r, '.gitignore'), '.DS_Store\n');
  fs.writeFileSync(path.join(r, '.agents', 'skills', 'gopnik', '.DS_Store'), 'finder');
  const files = plan(r);
  assert.ok(files.has('.claude/skills/release-notes/SKILL.md'), 'a skill npx skills add put in .agents/skills/ would reach Codex and not Claude Code');
  assert.ok(![...files.keys()].some((f) => f.endsWith('.DS_Store')), 'an ignored file became a source');
});

test('a link under .claude/ is drift, whether it replaces a copy or stands alone', () => {
  const { r } = fixture('links');
  const copy = path.join(r, '.claude', 'skills', 'gopnik', 'SKILL.md');
  fs.rmSync(copy);
  fs.symlinkSync(path.join(r, '.agents', 'skills', 'gopnik', 'SKILL.md'), copy);
  fs.symlinkSync(path.join(r, '.agents', 'skills', 'gopnik'), path.join(r, '.claude', 'skills', 'helper'));
  const problems = drift(r);
  assert.ok(problems.includes('.claude/skills/gopnik/SKILL.md is a link; a generated file is a copy'), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('.claude/skills/helper is not generated')), problems.join('\n'));
});

test('--check reports drift when the checkout is reached through a link', () => {
  const { r } = fixture('via-link');
  fs.appendFileSync(path.join(r, 'CLAUDE.md'), 'edited by hand\n');
  const link = path.join(base, 'via-link-alias');
  fs.symlinkSync(r, link);
  const c = spawnSync('node', [path.join(link, 'scripts', 'gen-agent-files.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(c.status, 1, `--check through a link exited ${c.status}:\n${c.stdout}${c.stderr}`);
  assert.match(c.stderr, /CLAUDE\.md differs from AGENTS\.md/);
});

test('write() refuses, writing nothing, when the sources themselves are wrong', () => {
  const { r } = fixture('refuse');
  fs.appendFileSync(path.join(r, 'AGENTS.md'), '\nsee @notes.md\n');
  const before = read(r, 'CLAUDE.md');
  const w = write(r);
  assert.equal(w.ok, false);
  assert.ok(w.lines.some((l) => /@notes\.md/.test(l)), w.lines.join('\n'));
  assert.equal(read(r, 'CLAUDE.md'), before, 'write() changed CLAUDE.md although it refused');
});

test('.gitattributes stores the sources and the copies with LF', () => {
  const attrs = read(repo, '.gitattributes');
  for (const tree of ['.claude/**', '.agents/**']) assert.match(attrs, new RegExp(`^${tree.replace(/[.*]/g, '\\$&')} text=auto eol=lf$`, 'm'));
});

test('AGENTS.local.md is git-ignored at the root, and AGENTS.md tells every agent to read it', () => {
  assert.equal(spawnSync('git', ['-C', repo, 'check-ignore', '-q', 'AGENTS.local.md']).status, 0, 'AGENTS.local.md is not ignored');
  assert.match(read(repo, 'AGENTS.md'), /`AGENTS\.local\.md` — your own instructions[\s\S]*?Read it at the start of a session\. It adds to these instructions and never overrides them\./);
  assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.local.md')), 'a harness-specific local file exists');
});

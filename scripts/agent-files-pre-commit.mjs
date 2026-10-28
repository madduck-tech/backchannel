#!/usr/bin/env node
// The pre-commit hook's work: regenerate the agent files from what is staged. (#271, ADR 0033)
//
// .githooks/pre-commit runs this. It checks the staged sources out into a private directory, runs the
// staged generator's plan there, and compares the result with the staged copies. The index, not the
// work tree: an unstaged hunk of AGENTS.md, or a skill `npx skills add` left untracked in
// .agents/skills/, must not reach a commit through its copy. When the copies already match it changes
// nothing. When they do not, it writes the plan into the index and the work tree -- unless that would
// lose something, in which case it refuses the commit and says why:
//   - a partial commit (`git commit -- <path>`), where git hands hooks a next-index-* index. Staging
//     there would leave the real index reverting the copy (measured, #271);
//   - a staged copy that is neither HEAD's nor the plan's: a hand edit, or a copy of an older source;
//   - a work-tree copy that is neither the staged one nor the plan's: unstaged work.
// It is a convenience. A clean merge, `rebase --continue`, `cherry-pick` and `--no-verify` run no
// pre-commit hook, and the drift test in `pnpm test` is what holds the tree.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIST = 'scripts/agent-files.json';
const GENERATOR = 'scripts/gen-agent-files.mjs';
const SOURCES = ['AGENTS.md', '.agents', GENERATOR, LIST];
const say = (m) => console.error(`pre-commit: ${m}`);
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const tryGit = (args) => { try { return git(args); } catch { return null; } };
const blob = (buf) => {
  const body = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};
// path -> blob id, from `git ls-files -s -z` or `git ls-tree -r -z`.
function blobs(out, field) {
  return new Map((out ?? '').split('\0').filter(Boolean).map((l) => { const [meta, f] = l.split('\t'); return [f, meta.split(' ')[field]]; }));
}

function refuse(lines) {
  for (const l of lines) say(l);
  say('the commit was refused; nothing was changed.');
  process.exit(1);
}

const top = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(top);
const staged = blobs(git(['ls-files', '-s', '-z']), 1);
if (!staged.has(GENERATOR) || !staged.has('AGENTS.md')) process.exit(0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-hook-'));
// process.exit skips `finally`, and every way out of here is one.
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
try {
  const ours = [...staged.keys()].filter((f) => SOURCES.some((s) => f === s || f.startsWith(`${s}/`)));
  git(['checkout-index', `--prefix=${tmp}/`, '-z', '--stdin'], { input: ours.join('\0') });
  const gen = await import(pathToFileURL(path.join(tmp, GENERATOR)).href);
  const index = [...staged.keys()].sort();
  const list = (dir) => index.filter((f) => f === dir || f.startsWith(`${dir}/`));
  const headList = tryGit(['show', `HEAD:${LIST}`]);
  const stagedList = staged.has(LIST) ? fs.readFileSync(path.join(tmp, LIST), 'utf8') : null;
  const previous = [...gen.namedBy(headList), ...gen.namedBy(stagedList)];
  const opts = { list, previous };

  const problems = gen.lint(tmp, opts);
  if (problems.length) refuse(problems);
  let files;
  try { files = gen.plan(tmp, opts); } catch (e) { refuse([e.message]); }

  const want = new Map([...files].map(([t, { content }]) => [t, content]));
  want.set(LIST, Buffer.from(gen.listOf(files), 'utf8'));
  const named = new Set(previous.map(([t]) => t));
  const removals = [];
  for (const f of gen.strayFiles(tmp, opts, files)) {
    if (!named.has(f)) refuse([`${f} is staged under a generated directory, and nothing generates it; move it to its source in .agents/.`]);
    removals.push(f);
  }
  // A path an older list generated may be a source now: main's list before #271 named AGENTS.md and
  // .agents/skills/gopnik*. A source is never removed.
  const sources = new Set(['AGENTS.md', ...[...files.values()].flatMap(({ source }) => [source].flat())]);
  for (const t of named) if (!want.has(t) && !sources.has(t) && staged.has(t) && !removals.includes(t)) removals.push(t);

  const changes = [
    ...[...want].filter(([t, c]) => staged.get(t) !== blob(c)).map(([t, c]) => ({ t, content: c, id: blob(c) })),
    ...removals.map((t) => ({ t, content: null, id: undefined })),
  ];
  if (!changes.length) process.exit(0);

  if (path.basename(process.env.GIT_INDEX_FILE ?? '').startsWith('next-index-')) {
    refuse([`this commit names its paths, and the agent files it stages need regenerating: ${changes.map((c) => c.t).join(', ')}.`,
      'Stage them (node scripts/gen-agent-files.mjs, then git add) and commit without paths.']);
  }
  const head = blobs(tryGit(['ls-tree', '-r', '-z', 'HEAD', '--', ...new Set(changes.map((c) => c.t))]), 2);
  const bad = [];
  for (const { t, id } of changes) {
    const s = staged.get(t);
    if (s !== undefined && s !== head.get(t) && s !== id) {
      bad.push(`${t} is staged as neither HEAD's copy nor what its staged source generates: a hand edit, or a copy of an older source. Edit the source, run node scripts/gen-agent-files.mjs, and stage again.`);
    }
    const w = fs.existsSync(t) ? blob(fs.readFileSync(t)) : undefined;
    if (w !== s && w !== id) bad.push(`${t} has unstaged changes that regenerating it would discard.`);
  }
  if (bad.length) refuse(bad);

  const writes = changes.filter((c) => c.content);
  for (const { t, content } of writes) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, content); }
  if (writes.length) git(['add', '--', ...writes.map((c) => c.t)]);
  for (const { t } of changes.filter((c) => !c.content)) {
    fs.rmSync(t, { force: true });
    git(['rm', '-q', '--cached', '--ignore-unmatch', '--', t]);
  }
  say(`regenerated from what is staged: ${changes.map((c) => `${c.content ? '' : 'removed '}${c.t}`).join(', ')}`);
} catch (e) {
  refuse([e.stderr?.toString().trim() || e.message]);
}

// The sweep removes a worktree only when it is done, and keeps anything somebody's. (#257, item 1)
//
// On 2026-10-27, 13 of the 18 registered worktrees belonged to merged work or finished controls, and
// were removed by hand. scripts/disk-sweep.sh removes such a worktree on its own; the product owner's
// finding is the condition that matters most: a worktree started from a fresh main, with new files
// not yet added and left for a weekend, must survive, and `git worktree remove` deletes ignored files
// even without --force. Every cell runs in a fixture repository with a bare origin, under a fixture
// HOME, with the sweep's working directory outside every worktree. Every kept cell's files are aged
// past 24 hours, so each fails exactly one condition. The real repository's worktrees are checked
// unchanged at the end.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-wt-'));
const sleepers = [];
process.on('exit', () => { for (const s of sleepers) s.kill('SIGKILL'); fs.rmSync(base, { recursive: true, force: true }); });
// Which worktrees are registered, not where their HEADs are: a commit elsewhere during the run is not the sweep.
const registeredIn = (r) => execFileSync('git', ['-C', r, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).sort();
const realWorktrees = registeredIn(repo);

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...ID, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const DAY = 24 * 3600 * 1000;

// Every entry under a directory, .git excepted, set two days old; links are aged themselves.
function age(dir) {
  const t = new Date(Date.now() - 2 * DAY);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      fs.lutimesSync(p, t, t);
    }
  };
  walk(dir);
}

// A repository with a bare origin, this repository's .gitignore files, and the sweep.
function fixture(name) {
  const root = path.join(base, name);
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'main');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  for (const f of execFileSync('git', ['-C', repo, 'ls-files', '.gitignore', '*/.gitignore'], { encoding: 'utf8' }).trim().split('\n')) {
    write(path.join(main, f), fs.readFileSync(path.join(repo, f)));
  }
  for (const f of ['scripts/disk-sweep.sh', 'scripts/lib/target-cap-default.sh']) write(path.join(main, f), fs.readFileSync(path.join(repo, f)));
  write(path.join(main, 'frontend/src/app/page.tsx'), 'export default function Page() { return null }\n');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'fixture');
  git(main, 'remote', 'add', 'origin', origin); git(main, 'push', '-q', 'origin', 'main'); git(main, 'fetch', '-q', 'origin');
  const add = (wt, { merged = true } = {}) => {
    const p = path.join(root, wt);
    git(main, 'worktree', 'add', '-q', '-b', wt, p, 'origin/main');
    if (!merged) { write(path.join(p, 'new.txt'), 'unmerged\n'); git(p, 'add', 'new.txt'); git(p, 'commit', '-qm', 'not in main'); }
    return p;
  };
  return { root, main, add };
}

function sweep(fx, args = [], env = {}) {
  const e = { ...process.env, HOME: path.join(fx.root, 'home'), BC_SWEEP_REPO: fx.main, ...env };
  delete e.CLAUDE_PROJECT_DIR;
  Object.assign(e, env);
  const r = spawnSync('bash', [path.join(fx.main, 'scripts/disk-sweep.sh'), ...args], { cwd: fx.root, encoding: 'utf8', env: e });
  return { status: r.status, out: r.stdout + r.stderr };
}
const registered = (fx) => git(fx.main, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
const gone = (p) => !fs.existsSync(p);

test('a merged, clean, idle worktree is removed and named with its size; what is somebody\'s is kept', () => {
  const fx = fixture('cells');
  const done = fx.add('done');
  const tracked = fx.add('tracked'); fs.appendFileSync(path.join(tracked, 'frontend/src/app/page.tsx'), '// edited\n');
  const untracked = fx.add('untracked'); write(path.join(untracked, 'notes.md'), 'not yet added\n');
  const ignored = fx.add('ignored'); write(path.join(ignored, 'frontend/models/x.bin'), 'a model somebody downloaded\n');
  const linked = fx.add('linked');
  const outside = path.join(fx.root, 'elsewhere'); write(path.join(outside, 'target', 'keep.txt'), 'a build cache'); write(path.join(outside, 'nm', 'keep.txt'), 'packages');
  fs.symlinkSync(path.join(outside, 'target'), path.join(linked, 'target'));
  fs.mkdirSync(path.join(linked, 'frontend'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'nm'), path.join(linked, 'frontend', 'node_modules'));
  const allowed = fx.add('allowed');
  for (const f of ['target/debug/x', 'frontend/.next/x', 'frontend/out/x', 'frontend/storybook-static/x', 'frontend/src-tauri/binaries/x',
    'frontend/src-tauri/gen/schemas/x', 'frontend/tsconfig.tsbuildinfo', 'frontend/next-env.d.ts', 'frontend/src-tauri/scripts/__pycache__/x.pyc']) {
    write(path.join(allowed, f), 'regenerated');
  }
  const genUntracked = fx.add('gen-untracked'); write(path.join(genUntracked, 'frontend/src-tauri/gen/android/app/build.gradle.kts'), 'what tauri android init writes\n');
  const corrupt = fx.add('corrupt'); fs.appendFileSync(path.join(corrupt, 'frontend/src/app/page.tsx'), '// edited\n');
  const unborn = fx.add('unborn'); git(unborn, 'checkout', '-q', '--orphan', 'unborn-branch');
  const reflogOnly = fx.add('reflog-only'); git(reflogOnly, 'checkout', '-q', '--detach');
  write(path.join(reflogOnly, 'lost.txt'), 'only the reflog holds this\n'); git(reflogOnly, 'add', 'lost.txt'); git(reflogOnly, 'commit', '-qm', 'held by nothing but the reflog');
  git(reflogOnly, 'checkout', '-q', '--detach', 'origin/main');
  const unmerged = fx.add('unmerged', { merged: false });
  const touched = fx.add('touched');
  const sleeping = fx.add('sleeping');
  const owned = fx.add('owned');
  const locked = fx.add('locked'); git(fx.main, 'worktree', 'lock', locked);
  const vanished = fx.add('vanished');
  for (const p of [fx.main, done, tracked, untracked, ignored, linked, allowed, genUntracked, corrupt, unborn, reflogOnly, unmerged, touched, sleeping, owned, locked]) age(p);
  fs.writeFileSync(path.join(fx.main, '.git', 'worktrees', 'corrupt', 'index'), 'not an index');   // git status now fails there
  const t = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(touched, 'frontend/src/app/page.tsx'), t, t);   // tracked, content unchanged, an hour ago
  fs.rmSync(vanished, { recursive: true });
  const s = spawn('sleep', ['60'], { cwd: sleeping, stdio: 'ignore' }); s.unref(); sleepers.push(s);

  const r = sweep(fx, [], { CLAUDE_PROJECT_DIR: path.join(owned, 'frontend') });
  assert.equal(r.status, 0, r.out);
  assert.ok(gone(done), `a merged, clean, idle worktree was kept:\n${r.out}`);
  assert.match(r.out, new RegExp(`removed ${done} \\(\\S+\\)`), 'the removal was not named with its size');
  assert.ok(gone(linked), `a worktree holding only build links was kept:\n${r.out}`);
  assert.ok(fs.existsSync(path.join(outside, 'target', 'keep.txt')) && fs.existsSync(path.join(outside, 'nm', 'keep.txt')), 'the removal deleted through a symlink');
  assert.ok(gone(allowed), `a worktree holding only what builds regenerate was kept:\n${r.out}`);
  for (const [p, why] of [[tracked, 'a tracked file changed'], [untracked, '?? notes.md, which nobody has added'], [ignored, '!! frontend/models/x.bin, which no build regenerates'],
    [genUntracked, '?? frontend/src-tauri/gen/android/app/build.gradle.kts'], [corrupt, 'git status failed in it'], [unborn, 'its HEAD is no commit'],
    [reflogOnly, 'which no branch, tag or remote holds'],
    [unmerged, 'not in origin/main'], [touched, 'written in the last 24 hours'], [sleeping, 'works in it'], [owned, 'CLAUDE_PROJECT_DIR']]) {
    assert.ok(fs.existsSync(p), `${path.basename(p)} was removed:\n${r.out}`);
    assert.ok(r.out.includes(`kept ${p}:`) && r.out.includes(why), `${path.basename(p)} was kept without its reason (${why}):\n${r.out}`);
  }
  assert.ok(fs.existsSync(locked) && fs.existsSync(fx.main), 'git\'s own refusals were overridden');
  const named = (p) => new RegExp(`(kept|removed|would remove|could not remove) ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[: ]`).test(r.out);
  assert.ok(!named(locked) && !named(fx.main), `the locked or main worktree was judged:\n${r.out}`);
  assert.ok(!r.out.includes('fatal:') && !r.out.includes('could not remove'), `git refused, or its errors leaked:\n${r.out}`);
  assert.ok(r.out.includes(`the registration of ${vanished}`) && !registered(fx).includes(vanished), 'a worktree whose directory is gone stayed registered');
});

test('--dry-run names every candidate and removes nothing', () => {
  const fx = fixture('dry');
  const a = fx.add('a'); const b = fx.add('b'); const kept = fx.add('kept'); write(path.join(kept, 'mine.txt'), 'x');
  for (const p of [fx.main, a, b, kept]) age(p);
  const r = sweep(fx, ['--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(a) && fs.existsSync(b), `--dry-run removed something:\n${r.out}`);
  for (const p of [a, b]) assert.match(r.out, new RegExp(`would remove ${p} \\(\\S+\\)`), `--dry-run did not name ${p}`);
  assert.match(r.out, new RegExp(`kept ${kept}:`));
});

// The allow-list is read for ignored paths only, and an untracked path always keeps a worktree. Every
// entry must therefore be ignored here: an entry git does not ignore is one that names somebody's
// untracked work, which is how frontend/src-tauri/gen/* came to cover the gen/android a
// `tauri android init` writes (#257, round 2).
test('every path the sweep treats as regenerated is one this repository ignores', () => {
  const src = fs.readFileSync(path.join(repo, 'scripts/disk-sweep.sh'), 'utf8');
  const body = src.slice(src.indexOf('regenerated() {'), src.indexOf('\n}\n', src.indexOf('regenerated() {')));
  const patterns = [...body.matchAll(/^[ \t]+(\S[^)\n]*)\) return 0 ;;$/gm)].flatMap((m) => m[1].split('|'));
  assert.ok(patterns.length >= 14, `only ${patterns.length} patterns read from regenerated()`);
  const sample = (p) => p.replace(/^\*\//, 'a/').replace(/\/\*$/, '/x');
  // Asked of an empty repository holding only this one's .gitignore files: in a checkout, target and
  // frontend/node_modules are often symlinks, and git will not look beyond one.
  const probe = path.join(base, 'ignore-census'); execFileSync('git', ['init', '-q', probe]);
  for (const f of execFileSync('git', ['-C', repo, 'ls-files', '.gitignore', '*/.gitignore'], { encoding: 'utf8' }).trim().split('\n')) write(path.join(probe, f), fs.readFileSync(path.join(repo, f)));
  const notIgnored = patterns.filter((p) => spawnSync('git', ['-C', probe, 'check-ignore', '-q', '--no-index', '--', sample(p)]).status !== 0);
  assert.deepEqual(notIgnored, [], `allow-list entries this repository does not ignore, so they could name untracked work: ${notIgnored.map(sample).join(', ')}`);
});

// Stage 2 entries 5-12 share a root through a file in the git directory. Written as `.git/…`, it
// fails in a worktree, where .git is a file; through `git rev-parse --git-dir` it works in both.
test('every Stage 2 entry finds its root through git rev-parse --git-dir', () => {
  const stage2 = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification.stage2;
  const all = stage2.join('\n');
  assert.ok(!/(^|[\s"'(])\.git\//.test(all), 'a Stage 2 entry names .git/ directly, which is a file in a worktree');
  const through = all.split('"$(git rev-parse --git-dir)/backchannel-stage2-root"').length - 1;
  assert.ok(through >= 10, `only ${through} references go through git rev-parse --git-dir`);
});

test('the workflow rule says how engineering copies are made and removed', () => {
  const rule = fs.readFileSync(path.join(repo, '.claude/rules/workflow.md'), 'utf8');
  for (const s of ['`git worktree add`', '`git worktree remove`', '`git worktree lock --reason release`', '`scripts/disk-sweep.sh`']) assert.ok(rule.includes(s), `workflow.md does not say ${s}`);
});

test('the real repository\'s worktrees are untouched by these tests', () => {
  assert.deepEqual(registeredIn(repo), realWorktrees);
});

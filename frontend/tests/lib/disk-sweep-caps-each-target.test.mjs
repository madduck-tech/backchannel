// Each target/ is held under a cap by deleting whole directories, never what a build needs. (#257, item 2)
//
// Cargo never removes an artifact it no longer uses: on 2026-10-27 the main checkout's target/ was
// 29 GiB. Over the cap, scripts/disk-sweep.sh deletes every incremental/, then every AppImage but the
// newest, then -- only with --profiles -- whole profiles, least recently written first. It never
// touches a target without Cargo's CACHEDIR.TAG, a profile whose Cargo lock is held, the lock files,
// CACHEDIR.TAG, or the newest AppImage. A file-by-file step was rejected: deleting a build script's
// out/ file alone leaves Cargo trusting an output that is gone (#257, round 2). Every target here
// lives in the fixture's own directory, and that is asserted before each run.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-cap-'));
const holders = [];
process.on('exit', () => { for (const h of holders) h.kill('SIGKILL'); fs.rmSync(base, { recursive: true, force: true }); });

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...ID, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const KB = (n) => Buffer.alloc(n * 1024, 1);
const bytes = (p) => Number(execFileSync('du', ['-sxB1', p], { encoding: 'utf8' }).split('\t')[0]);
const DAY = 24 * 3600 * 1000;
const at = (p, daysAgo) => { const t = new Date(Date.now() - daysAgo * DAY); fs.utimesSync(p, t, t); };
const LOCKS = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'];

// A Cargo target/: a fresh debug profile, a release profile with two AppImages, and a stale Windows
// profile whose incremental/ is empty, written weeks ago.
function target(t, { tag = true } = {}) {
  if (tag) write(path.join(t, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n# cargo\n');
  for (const p of ['debug', 'release', 'x86_64-pc-windows-msvc/debug']) for (const l of LOCKS) write(path.join(t, p, l), '');
  write(path.join(t, 'debug/incremental/s1/x.bin'), KB(400));
  write(path.join(t, 'debug/deps/libx.rlib'), KB(200));
  write(path.join(t, 'release/deps/liby.rlib'), KB(200));
  write(path.join(t, 'release/bundle/appimage/old.AppImage'), KB(300)); write(path.join(t, 'release/bundle/appimage/old.AppImage.built-from'), 'aaaa\n');
  write(path.join(t, 'release/bundle/appimage/new.AppImage'), KB(300)); write(path.join(t, 'release/bundle/appimage/new.AppImage.built-from'), 'bbbb\n');
  fs.mkdirSync(path.join(t, 'x86_64-pc-windows-msvc/debug/incremental'), { recursive: true });
  write(path.join(t, 'x86_64-pc-windows-msvc/debug/deps/libz.rlib'), KB(200));
  at(path.join(t, 'release/bundle/appimage/old.AppImage'), 3);
  for (const f of ['debug/deps/libx.rlib', 'debug/incremental/s1/x.bin']) at(path.join(t, f), 0.01);
  at(path.join(t, 'release/deps/liby.rlib'), 1);
  at(path.join(t, 'x86_64-pc-windows-msvc/debug/deps/libz.rlib'), 40);
  return t;
}

// A repository whose main worktree holds the sweep, and whose target/ is built by `make`.
function fixture(name, make = (main) => target(path.join(main, 'target'))) {
  const root = path.join(base, name);
  const main = path.join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  for (const f of ['scripts/disk-sweep.sh', 'scripts/lib/target-cap-default.sh', '.gitignore']) write(path.join(main, f), fs.readFileSync(path.join(repo, f)));
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'fixture');
  git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  make(main, root);
  return { root, main };
}
function sweep(fx, cap, args = []) {
  for (const l of execFileSync('git', ['-C', fx.main, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')) {
    if (!l.startsWith('worktree ')) continue;
    const t = path.join(l.slice(9), 'target');
    if (fs.existsSync(t)) assert.ok(fs.realpathSync(t).startsWith(base), `a target outside the fixture: ${fs.realpathSync(t)}`);
  }
  const env = { ...process.env, HOME: path.join(fx.root, 'home'), BC_SWEEP_REPO: fx.main, BC_TARGET_CAP_BYTES: String(cap) };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync('bash', [path.join(fx.main, 'scripts/disk-sweep.sh'), ...args], { cwd: fx.root, encoding: 'utf8', env });
  return { status: r.status, out: r.stdout + r.stderr };
}
const has = (t, p) => fs.existsSync(path.join(t, p));

test('under the cap, a target is untouched', () => {
  const fx = fixture('under'); const t = path.join(fx.main, 'target');
  const r = sweep(fx, bytes(t) + 1);
  assert.equal(r.status, 0, r.out);
  assert.ok(has(t, 'debug/incremental/s1/x.bin') && has(t, 'release/bundle/appimage/old.AppImage'), `a target under its cap lost something:\n${r.out}`);
  assert.doesNotMatch(r.out, /removed/);
});

test('step 1 removes incremental/ and stops when that is enough', () => {
  const fx = fixture('step1'); const t = path.join(fx.main, 'target');
  const r = sweep(fx, bytes(t) - bytes(path.join(t, 'debug/incremental')) + 4096);
  assert.ok(!has(t, 'debug/incremental'), `incremental/ survived:\n${r.out}`);
  assert.match(r.out, new RegExp(`removed ${t}/debug/incremental \\(\\S+\\)`), 'the removal was not named with its size');
  assert.ok(has(t, 'release/bundle/appimage/old.AppImage') && has(t, 'debug/deps/libx.rlib'), `the sweep went past step 1 when step 1 was enough:\n${r.out}`);
});

test('step 2 removes every AppImage but the newest, each with its .built-from', () => {
  const fx = fixture('step2'); const t = path.join(fx.main, 'target');
  const r = sweep(fx, bytes(t) - bytes(path.join(t, 'debug/incremental')) - bytes(path.join(t, 'release/bundle/appimage/old.AppImage')) + 4096);
  assert.ok(!has(t, 'release/bundle/appimage/old.AppImage') && !has(t, 'release/bundle/appimage/old.AppImage.built-from'), `the old AppImage survived:\n${r.out}`);
  assert.ok(has(t, 'release/bundle/appimage/new.AppImage') && has(t, 'release/bundle/appimage/new.AppImage.built-from'), 'the newest AppImage was removed');
  assert.ok(has(t, 'debug/deps/libx.rlib') && has(t, 'release/deps/liby.rlib'), `a profile was emptied without --profiles:\n${r.out}`);
});

test('step 3 runs only under --profiles, empties the least recently written profile first, and keeps locks, the tag and the newest AppImage', () => {
  const fx = fixture('step3'); const t = path.join(fx.main, 'target');
  const without = sweep(fx, 0);
  assert.ok(has(t, 'x86_64-pc-windows-msvc/debug/deps/libz.rlib') && has(t, 'debug/deps/libx.rlib'), `profiles were emptied without --profiles:\n${without.out}`);
  const stale = path.join(t, 'x86_64-pc-windows-msvc/debug');
  const cap = bytes(t) - bytes(path.join(stale, 'deps')) + 4096;
  const r = sweep(fx, cap, ['--profiles']);
  assert.ok(!has(t, 'x86_64-pc-windows-msvc/debug/deps'), `the stale profile, whose incremental/ was emptied this run, was not emptied first:\n${r.out}`);
  assert.ok(has(t, 'debug/deps/libx.rlib') && has(t, 'release/deps/liby.rlib'), `a fresher profile was emptied before the stale one was enough:\n${r.out}`);
  const all = sweep(fx, 0, ['--profiles']);
  assert.equal(all.status, 0, all.out);
  for (const p of ['debug', 'release', 'x86_64-pc-windows-msvc/debug']) for (const l of LOCKS) assert.ok(has(t, `${p}/${l}`), `${p}/${l} was removed`);
  assert.ok(has(t, 'CACHEDIR.TAG'), 'CACHEDIR.TAG was removed');
  assert.ok(has(t, 'release/bundle/appimage/new.AppImage') && has(t, 'release/bundle/appimage/new.AppImage.built-from'), `step 3 removed the newest AppImage:\n${all.out}`);
  assert.ok(!has(t, 'debug/deps') && !has(t, 'release/deps'), `--profiles at a cap of 0 left a profile's artifacts:\n${all.out}`);
});

for (const lock of LOCKS) {
  test(`a profile whose ${lock} is held is not touched`, async () => {
    const fx = fixture(`held${lock}`); const t = path.join(fx.main, 'target');
    const h = spawn('flock', [path.join(t, 'debug', lock), 'sleep', '30'], { stdio: 'ignore' }); h.unref(); holders.push(h);
    for (let i = 0; i < 100 && spawnSync('flock', ['-n', path.join(t, 'debug', lock), 'true']).status === 0; i++) await new Promise((res) => setTimeout(res, 50));
    const r = sweep(fx, 0, ['--profiles']);
    h.kill('SIGKILL');
    assert.ok(has(t, 'debug/incremental/s1/x.bin') && has(t, 'debug/deps/libx.rlib'), `a profile whose ${lock} is held lost files:\n${r.out}`);
    assert.match(r.out, new RegExp(`left ${t}/debug alone: Cargo holds its lock`));
    assert.ok(!has(t, 'release/deps'), 'the other profiles were not capped');
  });
}

test('a target without Cargo\'s CACHEDIR.TAG is left alone', () => {
  const fx = fixture('untagged', (main) => target(path.join(main, 'target'), { tag: false })); const t = path.join(fx.main, 'target');
  const r = sweep(fx, 0, ['--profiles']);
  assert.ok(has(t, 'debug/incremental/s1/x.bin') && has(t, 'debug/deps/libx.rlib'), `an untagged target was cut:\n${r.out}`);
  assert.match(r.out, /left .* alone: it has no Cargo CACHEDIR.TAG/);
});

test('one target shared by two worktrees is measured once, and a target outside every worktree is capped', () => {
  const fx = fixture('shared', (main, root) => {
    target(path.join(root, 'outside-target'));
    fs.symlinkSync(path.join(root, 'outside-target'), path.join(main, 'target'));
    git(main, 'worktree', 'add', '-q', '--detach', path.join(root, 'second'), 'HEAD');
    fs.symlinkSync(path.join(root, 'outside-target'), path.join(root, 'second', 'target'));
  });
  const t = path.join(fx.root, 'outside-target');
  const dry = sweep(fx, 0, ['--dry-run']);
  const lines = dry.out.split('\n').filter((l) => l.includes(`would remove ${t}/debug/incremental `));
  assert.ok(lines.length >= 1, `a target outside every worktree was not planned at all:\n${dry.out}`);
  assert.equal(lines.length, 1, `one target linked from two worktrees was planned twice:\n${dry.out}`);
  const r = sweep(fx, bytes(t) - bytes(path.join(t, 'debug/incremental')) + 4096);
  assert.ok(!has(t, 'debug/incremental'), `a target outside every worktree was not capped:\n${r.out}`);
});

test('a symlink inside a target is removed as a link, never followed', () => {
  const fx = fixture('inner-link', (main, root) => {
    target(path.join(main, 'target'));
    write(path.join(root, 'precious', 'data.txt'), 'not the build\'s');
    fs.symlinkSync(path.join(root, 'precious'), path.join(main, 'target', 'debug', 'linked'));
  });
  const r = sweep(fx, 0, ['--profiles']);
  assert.ok(fs.existsSync(path.join(fx.root, 'precious', 'data.txt')), `the sweep followed a symlink out of the target:\n${r.out}`);
});

test('--dry-run prints the deletions with sizes and removes nothing', () => {
  const fx = fixture('dry'); const t = path.join(fx.main, 'target');
  const before = bytes(t);
  const r = sweep(fx, 0, ['--dry-run', '--profiles']);
  assert.equal(bytes(t), before, `--dry-run changed the target:\n${r.out}`);
  assert.match(r.out, new RegExp(`would remove ${t}/debug/incremental \\(\\S+\\)`));
  assert.match(r.out, new RegExp(`would remove ${t}/release/bundle/appimage/old.AppImage \\(\\S+\\)`));
});

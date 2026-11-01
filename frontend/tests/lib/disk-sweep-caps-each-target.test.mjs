// Each target/ is held under a cap by deleting whole directories, never what a build needs. (#257, item 2)
//
// Cargo never removes an artifact it no longer uses: on 2026-10-27 the main checkout's target/ was
// 29 GiB. Over the cap, scripts/disk-sweep.sh deletes every incremental/, then every AppImage but the
// newest, then -- only with --profiles -- whole profiles, least recently written first. It never
// touches a target without Cargo's CACHEDIR.TAG, a profile whose Cargo lock is held or that a process
// uses, the lock files, CACHEDIR.TAG, or the newest AppImage. A file-by-file step was rejected: deleting a build script's
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
// What cargo writes, byte for byte; the first line alone is the generic cache-directory signature.
const CARGO_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n# For information about cache directory tags see https://bford.info/cachedir/\n';
const PIPX_TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by pipx.\n';

// A Cargo target/: a fresh debug profile, a release profile with two AppImages, and a stale Windows
// profile whose incremental/ is empty, written weeks ago.
function target(t, { tag = CARGO_TAG } = {}) {
  if (tag) write(path.join(t, 'CACHEDIR.TAG'), tag);
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
function sweep(fx, cap, args = [], extraEnv = {}, cwd = fx.root) {
  for (const l of execFileSync('git', ['-C', fx.main, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')) {
    if (!l.startsWith('worktree ')) continue;
    const t = path.join(l.slice(9), 'target');
    if (fs.existsSync(t)) assert.ok(fs.realpathSync(t).startsWith(base), `a target outside the fixture: ${fs.realpathSync(t)}`);
  }
  const env = { ...process.env, HOME: path.join(fx.root, 'home'), BC_SWEEP_REPO: fx.main, BC_TARGET_CAP_BYTES: String(cap), ...extraEnv };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync('bash', [path.join(fx.main, 'scripts/disk-sweep.sh'), ...args], { cwd, encoding: 'utf8', env });
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
    // As Cargo does: .cargo-lock is held shared (measured on 2026-10-27), the other two exclusive.
    const h = spawn('flock', [...(lock === '.cargo-lock' ? ['-s'] : []), path.join(t, 'debug', lock), 'sleep', '30'], { stdio: 'ignore' }); h.unref(); holders.push(h);
    for (let i = 0; i < 100 && spawnSync('flock', ['-n', path.join(t, 'debug', lock), 'true']).status === 0; i++) await new Promise((res) => setTimeout(res, 50));
    const r = sweep(fx, 0, ['--profiles']);
    h.kill('SIGKILL');
    assert.ok(has(t, 'debug/incremental/s1/x.bin') && has(t, 'debug/deps/libx.rlib'), `a profile whose ${lock} is held lost files:\n${r.out}`);
    assert.match(r.out, new RegExp(`left ${t}/debug alone: Cargo holds its lock`));
    assert.ok(!has(t, 'release/deps'), 'the other profiles were not capped');
  });
}

// Cargo's line alone, with no signature, is not Cargo's tag either: without this cell, dropping the signature half
// of the check could not go red (#257, v10).
const CARGO_LINE_ALONE = '# This file is a cache directory tag created by cargo.\n';
for (const [what, tag] of [['no CACHEDIR.TAG', false], ['another tool\'s CACHEDIR.TAG', PIPX_TAG], ['Cargo\'s line alone', CARGO_LINE_ALONE]]) {
  test(`a target with ${what} is left alone`, () => {
    const fx = fixture(`untagged-${what.replace(/\W+/g, '-')}`, (main) => target(path.join(main, 'target'), { tag })); const t = path.join(fx.main, 'target');
    const r = sweep(fx, 0, ['--profiles']);
    assert.ok(has(t, 'debug/incremental/s1/x.bin') && has(t, 'debug/deps/libx.rlib'), `a target with ${what} was cut:\n${r.out}`);
    assert.match(r.out, /left .* alone: it has no Cargo CACHEDIR.TAG/);
  });
}

test('a path with a space is one path: nothing outside the target is touched', () => {
  write(path.join(base, 'sp', 'main', 'target', 'debug', 'precious.txt'), 'the word before the space names this directory');
  const fx = fixture('sp ace'); const t = path.join(fx.main, 'target');
  const r = sweep(fx, 0, ['--profiles']);
  assert.ok(fs.existsSync(path.join(base, 'sp', 'main', 'target', 'debug', 'precious.txt')), `the sweep split a path on its space and deleted outside the target:\n${r.out}`);
  assert.ok(!has(t, 'debug/deps') && !has(t, 'x86_64-pc-windows-msvc/debug/deps'), `the profiles under a path with a space were not capped:\n${r.out}`);
});

// Cargo holds no lock while `cargo test` runs a test binary or a bundler packs an AppImage.
test('a profile a process runs a file from, works in or holds a file open in is not touched', async () => {
  const fx = fixture('in-use'); const t = path.join(fx.main, 'target');
  const sleeper = path.join(t, 'debug/deps/sleeper'); fs.copyFileSync(execFileSync('which', ['sleep'], { encoding: 'utf8' }).trim(), sleeper); fs.chmodSync(sleeper, 0o755);
  const procs = [
    spawn(sleeper, ['30'], { stdio: 'ignore' }),
    spawn('sleep', ['30'], { cwd: path.join(t, 'x86_64-pc-windows-msvc/debug/deps'), stdio: 'ignore' }),
    spawn('bash', ['-c', 'exec 3<"$1"; exec sleep 30', 'holder', path.join(t, 'release/bundle/appimage/old.AppImage')], { stdio: 'ignore' }),
  ];
  for (const h of procs) { h.unref(); holders.push(h); }
  const pids = procs.map((h) => h.pid);
  for (let i = 0; i < 100; i++) {
    const ok = [() => fs.readlinkSync(`/proc/${pids[0]}/exe`) === sleeper, () => fs.readlinkSync(`/proc/${pids[1]}/cwd`).endsWith('/deps'),
      () => fs.readdirSync(`/proc/${pids[2]}/fd`).some((f) => { try { return fs.readlinkSync(`/proc/${pids[2]}/fd/${f}`).endsWith('old.AppImage'); } catch { return false; } })]
      .every((f) => { try { return f(); } catch { return false; } });
    if (ok) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const r = sweep(fx, 0, ['--profiles']);
  for (const h of procs) h.kill('SIGKILL');
  assert.ok(has(t, 'debug/deps/libx.rlib'), `a profile whose file a process runs was emptied:\n${r.out}`);
  assert.ok(has(t, 'x86_64-pc-windows-msvc/debug/deps/libz.rlib'), `a profile a process works in was emptied:\n${r.out}`);
  assert.ok(has(t, 'release/bundle/appimage/old.AppImage'), `an AppImage a process holds open was removed:\n${r.out}`);
  assert.ok(has(t, 'release/deps/liby.rlib'), `a profile a process holds a file open in was emptied:\n${r.out}`);
  for (const p of ['debug', 'x86_64-pc-windows-msvc/debug', 'release']) assert.match(r.out, new RegExp(`left ${t}/${p} alone: process \\d+ uses it`));
  assert.match(r.out, new RegExp(`left ${t}/release/bundle/appimage/old.AppImage alone: process \\d+ uses it`));
});

test('a removal that fails is said, and what is left is measured, not assumed', () => {
  const fx = fixture('rm-fails'); const t = path.join(fx.main, 'target');
  const stuck = path.join(t, 'x86_64-pc-windows-msvc/debug/deps/stuck'); write(path.join(stuck, 'f'), KB(100)); fs.chmodSync(stuck, 0o555);
  try {
    const r = sweep(fx, 0, ['--profiles']);
    assert.match(r.out, new RegExp(`could not remove all of ${t}/x86_64-pc-windows-msvc/debug/deps`), `a failed removal was reported as done:\n${r.out}`);
    assert.ok(has(t, 'x86_64-pc-windows-msvc/debug/deps/stuck/f'), 'the fixture could not make rm fail');
  } finally { fs.chmodSync(stuck, 0o755); }
});

// A hard-linked file frees nothing until its last path goes, so a run that counts what it deletes
// ends over the cap. The stale profile goes first and holds the only other path of a big file.
test('a real run measures what is left, so hard links do not leave it over the cap', () => {
  const fx = fixture('hardlink', (main) => {
    const t = target(path.join(main, 'target'));
    write(path.join(t, 'x86_64-pc-windows-msvc/debug/deps/big.bin'), KB(1000));
    fs.linkSync(path.join(t, 'x86_64-pc-windows-msvc/debug/deps/big.bin'), path.join(t, 'debug/deps/big-link.bin'));
    at(path.join(t, 'x86_64-pc-windows-msvc/debug/deps/big.bin'), 40);
  });
  const t = path.join(fx.main, 'target');
  const cap = bytes(t) - 1500 * 1024;
  const r = sweep(fx, cap, ['--profiles']);
  assert.ok(bytes(t) <= cap, `the run ended at ${bytes(t)} bytes against a cap of ${cap}:\n${r.out}`);
});

// What a dry run names is what a real run removes, at every cap. A second release profile's old
// AppImage goes in step 2 and its bundle/ again in step 3, where a dry run used to count it twice.
test('a dry run names exactly what a real run removes, at every cap', () => {
  const make = (main) => {
    const t = target(path.join(main, 'target'));
    for (const l of LOCKS) write(path.join(t, 'x86_64-unknown-linux-gnu/release', l), '');
    write(path.join(t, 'x86_64-unknown-linux-gnu/release/deps/libw.rlib'), KB(200));
    write(path.join(t, 'x86_64-unknown-linux-gnu/release/bundle/appimage/older.AppImage'), KB(300));
    at(path.join(t, 'x86_64-unknown-linux-gnu/release/deps/libw.rlib'), 20);
    at(path.join(t, 'x86_64-unknown-linux-gnu/release/bundle/appimage/older.AppImage'), 10);
  };
  const dryFx = fixture('dry-vs-real', make); const total = bytes(path.join(dryFx.main, 'target'));
  const names = (fx, out, verb) => out.split('\n').filter((l) => l.includes(`disk-sweep: ${verb} `)).map((l) => l.replace(fx.root, '<root>').replace(/ \([^)]*\)$/, '').replace(`disk-sweep: ${verb} `, ''));
  let compared = 0;
  for (let cap = total; cap >= 0; cap -= 100 * 1024) {
    const dry = sweep(dryFx, cap, ['--dry-run', '--profiles']);
    const realFx = fixture(`dry-vs-real-${cap}`, make);
    const real = sweep(realFx, cap, ['--profiles']);
    assert.deepEqual(names(dryFx, dry.out, 'would remove'), names(realFx, real.out, 'removed'), `at a cap of ${cap} the dry run and the real run disagree:\n${dry.out}\n---\n${real.out}`);
    compared++;
  }
  assert.ok(compared >= 20, `only ${compared} caps compared`);
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

// A target still over the cap is named, with what kept it there (#257, v10).
test('a target left over the cap is named, with its size and the reason', () => {
  const fx = fixture('stays'); const t = path.join(fx.main, 'target');
  const r = sweep(fx, 0);
  assert.match(r.out, new RegExp(`${t} stays over the cap at \\S+: .*profiles are emptied only under --profiles`), `a target over its cap was not named:\n${r.out}`);
});

// The lock is held while deleting: an rm that tries the profile's locks on every path it deletes never gets one.
test('the sweep holds the profile\'s Cargo locks while it deletes there', () => {
  const fx = fixture('held'); const t = path.join(fx.main, 'target');
  const shim = path.join(fx.root, 'shim'); fs.mkdirSync(shim);
  const log = path.join(fx.root, 'rm-log');
  fs.writeFileSync(path.join(shim, 'rm'), `#!/bin/bash
for a in "$@"; do case "$a" in -*) continue ;; esac
  for l in .cargo-lock .cargo-build-lock .cargo-artifact-lock; do
    d=$a; while [ "$d" != / ] && [ "$d" != . ]; do
      if [ -e "$d/$l" ]; then if flock -n "$d/$l" true; then echo "GOT $d/$l while deleting $a" >> ${JSON.stringify(log)}; else echo "held $d/$l" >> ${JSON.stringify(log)}; fi; break; fi
      d=$(dirname "$d")
    done
  done
done
exec /bin/rm "$@"
`, { mode: 0o755 });
  const r = sweep(fx, 0, ['--profiles'], { PATH: `${shim}:${process.env.PATH}` });
  const seen = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.match(seen, /held /, `the shim never ran inside a profile, so it shows nothing:\n${r.out}`);
  assert.doesNotMatch(seen, /GOT /, `the sweep deleted without holding the profile's lock:\n${seen}`);
});

// Under --profiles, a target another worktree links is not emptied while a process works in that worktree. The
// main worktree is not judged, nor the sweep's own (#257, v10). Today's layout: the target is a directory in the
// main worktree, linked from two others.
test('step 3 waits for a process in a linking worktree, and not for one in the main or the sweep\'s own', () => {
  const layout = (name) => fixture(name, (main, root) => {
    target(path.join(main, 'target'));
    for (const w of ['linkA', 'linkB']) { git(main, 'worktree', 'add', '-q', '--detach', path.join(root, w), 'HEAD'); fs.symlinkSync(path.join(main, 'target'), path.join(root, w, 'target')); }
  });
  const nap = (cwd) => { const h = spawn('sleep', ['30'], { cwd, stdio: 'ignore' }); h.unref(); holders.push(h); return h; };
  const emptied = (t) => !has(t, 'x86_64-pc-windows-msvc/debug/deps/libz.rlib');
  { const fx = layout('lay-main'); const t = path.join(fx.main, 'target'); const h = nap(fx.main);
    const r = sweep(fx, 0, ['--profiles']); h.kill('SIGKILL');
    assert.ok(emptied(t), `a process in the main worktree held step 3:\n${r.out}`); }
  { const fx = layout('lay-link'); const t = path.join(fx.main, 'target'); const h = nap(path.join(fx.root, 'linkA'));
    const r = sweep(fx, 0, ['--profiles']); h.kill('SIGKILL');
    assert.ok(!emptied(t), `a profile was emptied while a process worked in a linking worktree:\n${r.out}`);
    assert.match(r.out, new RegExp(`a process works in ${path.join(fx.root, 'linkA')}, which links this target`), r.out); }
  { const fx = layout('lay-own'); const t = path.join(fx.main, 'target'); const own = path.join(fx.root, 'linkB'); const h = nap(own);
    const r = sweep(fx, 0, ['--profiles'], {}, own); h.kill('SIGKILL');
    assert.ok(emptied(t), `a process in the sweep's own worktree held step 3:\n${r.out}`); }
  { const fx = layout('lay-empty'); const t = path.join(fx.main, 'target'); const empty = path.join(fx.root, 'empty-proc'); fs.mkdirSync(empty);
    const r = sweep(fx, 0, ['--profiles'], { BC_SWEEP_PROC: empty });
    assert.ok(!emptied(t), `a profile was emptied with an empty /proc:\n${r.out}`);
    assert.match(r.out, new RegExp(`no process is listed in ${empty}, so nothing shows ${path.join(fx.root, 'linkA')} idle`), r.out); }
});

// An empty process listing proves nothing is running, so steps 2 and 3 remove nothing they would judge in use.
test('with an empty /proc, no AppImage is removed and no profile emptied, and the reason names it', () => {
  const fx = fixture('empty-proc'); const t = path.join(fx.main, 'target');
  const empty = path.join(fx.root, 'empty-proc'); fs.mkdirSync(empty);
  const r = sweep(fx, 0, ['--profiles'], { BC_SWEEP_PROC: empty });
  assert.ok(has(t, 'release/bundle/appimage/old.AppImage') && has(t, 'x86_64-pc-windows-msvc/debug/deps/libz.rlib'), `something was removed with an empty /proc:\n${r.out}`);
  assert.match(r.out, new RegExp(`stays over the cap at \\S+: .*no process is listed in ${empty}`), r.out);
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

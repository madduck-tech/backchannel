// The gate refuses to run this machine out of disk. (#248)
//
// The machine the gate runs on is where the product owner records their meetings, and on 2026-10-27
// gate leftovers had filled it to 99%, 6.4 GB free, the morning of a meeting. `scripts/disk-floor.sh`
// fails below a floor on every filesystem the gate writes -- /tmp, the checkout's target/, the seed
// caches and the application's recording folder -- and says what is taking the space. It is Stage 1's
// second entry, Stage 2's fourth, and the prefix of every Stage 1 cargo entry, because the runner runs
// every entry whatever the last one returned. `seed_copy` (scripts/lib/kept-profile.sh) is the same
// floor inside a pass, at the copy that costs 5.2 GB.
//
// Every test runs from a fixture git checkout under a fixture HOME, so `git worktree list` names only
// the fixture and no test walks a real target/ or lists the real /tmp. `df` and `cp` are shimmed where
// a test needs a number or a failure the machine will not produce.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-floor-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

// A checkout of its own, holding a copy of the script as it is now, and a HOME whose recording folder
// is a fixture folder.
function checkout(name, { target = true } = {}) {
  const work = path.join(root, name);
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts', 'disk-floor.sh'), path.join(work, 'scripts', 'disk-floor.sh'));
  fs.mkdirSync(path.join(work, 'scripts', 'lib'));
  for (const f of ['lib/disk-floor-default.sh', 'disk-sweep.sh', 'lib/target-cap-default.sh']) fs.copyFileSync(path.join(repo, 'scripts', f), path.join(work, 'scripts', f));
  if (target) write(path.join(work, 'target', 'debug', 'incremental', 'blob'), Buffer.alloc(2_000_000));
  const g = (...a) => spawnSync('git', ['-C', work, ...a], { encoding: 'utf8' });
  g('init', '-q');
  const home = path.join(work, '..', `${name}-home`);
  const rec = path.join(home, 'meetings');
  fs.mkdirSync(rec, { recursive: true });
  write(path.join(home, '.local', 'share', 'tech.madduck.backchannel', 'recording_preferences.json'),
    JSON.stringify({ preferences: { save_folder: rec, auto_save: true } }));
  const list = path.join(root, `${name}-list`);
  write(path.join(list, 'the-largest-leftover', 'model.gguf'), Buffer.alloc(3_000_000));
  write(path.join(list, 'a-small-one.txt'), 'x');
  return { work, home, rec, list };
}
const bin = path.join(root, 'bin');
// `df` answering from SHIM_DF: "none" prints nothing, otherwise "<free bytes>" for every path, with
// SHIM_DF_LOW naming one path that gets 1000 bytes.
write(path.join(bin, 'df'), `#!/usr/bin/env bash
p="\${@: -1}"
[ "$SHIM_DF" = none ] && exit 0
printf 'Avail\\n'
if [ -n "\${SHIM_DF_LOW:-}" ] && [ "$p" = "$SHIM_DF_LOW" ]; then echo 1000; else echo "$SHIM_DF"; fi
`);
write(path.join(bin, 'cp'), '#!/bin/sh\necho "cp: No space left on device" >&2\nexit 1\n');
fs.chmodSync(path.join(bin, 'df'), 0o755); fs.chmodSync(path.join(bin, 'cp'), 0o755);
const shimmed = (names) => { const d = fs.mkdtempSync(path.join(root, 'path-')); for (const n of names) fs.symlinkSync(path.join(bin, n), path.join(d, n)); return d; };

function floor(fx, env = {}, args = []) {
  const r = spawnSync('bash', [path.join(fx.work, 'scripts', 'disk-floor.sh'), ...args], {
    cwd: fx.work, encoding: 'utf8',
    env: { ...process.env, HOME: fx.home, XDG_DATA_HOME: path.join(fx.home, '.local', 'share'), XDG_CONFIG_HOME: path.join(fx.home, '.config'),
      BC_DISK_FLOOR_LIST: fx.list, BC_DISK_FLOOR_GB: '0', ...env },
  });
  return { status: r.status, out: r.stderr + r.stdout };
}
const RAISED = { BC_DISK_FLOOR_GB: '1000000000' };

test('the floor at 0 passes, and lists nothing', () => {
  const fx = checkout('zero');
  const r = floor(fx);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /largest/);
});

test('above the free space it fails, and says what is taking the space and what is safe to delete', () => {
  const fx = checkout('raised');
  const r = floor(fx, RAISED);
  assert.notEqual(r.status, 0, `a floor above the free space passed:\n${r.out}`);
  assert.match(r.out, /the-largest-leftover/, 'the failure does not name the largest entry under the listed directory');
  assert.match(r.out, new RegExp(`\\d+\\.\\d GB  ${fs.realpathSync(path.join(fx.work, 'target'))}\\n`), "the failure does not size the checkout's target/");
  assert.match(r.out, /safe to delete, at the cost of a slower next build: target\/\*\/incremental, target\/release, and a shared worktree target\//);
});

test('--brief fails in one line, with no listing', () => {
  const r = floor(checkout('brief'), RAISED, ['--brief']);
  assert.notEqual(r.status, 0, `--brief passed above the free space:\n${r.out}`);
  assert.equal(r.out.trimEnd().split('\n').length, 1, r.out);
  assert.doesNotMatch(r.out, /largest|safe to delete/);
});

test('the recording folder is a filesystem of its own', () => {
  const fx = checkout('rec');
  const r = floor(fx, { BC_DISK_FLOOR_GB: '1', PATH: `${shimmed(['df'])}:${process.env.PATH}`, SHIM_DF: '999000000000', SHIM_DF_LOW: fx.rec });
  assert.notEqual(r.status, 0, `the recording folder had 1000 bytes free and the floor passed:\n${r.out}`);
  assert.match(r.out, new RegExp(`below the 1 GB floor: ${fx.rec}`));
});

test('a free space it cannot read is not enough', () => {
  const r = floor(checkout('blind'), { PATH: `${shimmed(['df'])}:${process.env.PATH}`, SHIM_DF: 'none' });
  assert.notEqual(r.status, 0, `df printed nothing and the floor passed:\n${r.out}`);
  assert.match(r.out, /cannot read the free space/);
});

test('a target/ not built yet is judged by its parent', () => {
  const r = floor(checkout('fresh', { target: false }));
  assert.equal(r.status, 0, `a fresh checkout failed the floor:\n${r.out}`);
});

// seed_copy, the floor inside a pass, in a pass's shape: say/die, then the line after the copy.
function seed(env, src, dst) {
  return spawnSync('bash', ['-c', `say() { printf 'pass: %s\\n' "$*" >&2; }; die() { say "$*"; exit 1; }
. "$1"; seed_copy "$2" "$3" || die "could not seed $3"; echo "the pass went on"`, 'x', path.join(repo, 'scripts', 'lib', 'kept-profile.sh'), src, dst],
  { encoding: 'utf8', env: { ...process.env, BC_DISK_FLOOR_GB: '0', ...env } });
}
function seedFixture(name) {
  const src = path.join(root, name, 'cache', 'models');
  write(path.join(src, 'a.gguf'), Buffer.alloc(5000));
  const app = path.join(root, name, 'profile', 'home', '.local', 'share', 'tech.madduck.backchannel');
  fs.mkdirSync(app, { recursive: true });
  return { src, app };
}

test('a seed that fits is copied', () => {
  const { src, app } = seedFixture('fits');
  const r = seed({}, src, `${app}/`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(app, 'models', 'a.gguf')).length, 5000);
  assert.match(r.stdout, /the pass went on/);
});

test('a seed bigger than the headroom is refused, with the bytes it needs, and nothing is copied', () => {
  const { src, app } = seedFixture('full');
  const r = seed({ PATH: `${shimmed(['df'])}:${process.env.PATH}`, SHIM_DF: '1000' }, src, `${app}/`);
  assert.notEqual(r.status, 0, `a 5000-byte seed into 1000 free bytes went ahead:\n${r.stderr}`);
  const need = r.stderr.match(/refusing to seed .*: it needs (\d+) bytes/);
  assert.ok(need && Number(need[1]) >= 5000, `the refusal does not name the bytes the seed needs:\n${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(app, 'models')), 'the refused copy copied something');
  assert.doesNotMatch(r.stdout, /the pass went on/);
});

test('a seed that fits the disk but not the floor is refused', () => {
  const { src, app } = seedFixture('floor');
  // 10 GB free and a 5000-byte seed: it fits, and it would leave less than a 20 GB floor.
  const r = seed({ PATH: `${shimmed(['df'])}:${process.env.PATH}`, SHIM_DF: '10000000000', BC_DISK_FLOOR_GB: '20' }, src, `${app}/`);
  assert.notEqual(r.status, 0, `a seed leaving 10 GB under a 20 GB floor went ahead:\n${r.stderr}`);
  assert.match(r.stderr, /of a 20000000000-byte floor/);
  assert.ok(!fs.existsSync(path.join(app, 'models')), 'the refused copy copied something');
});

test('a copy that fails stops the pass', () => {
  const { src, app } = seedFixture('cpfail');
  const r = seed({ PATH: `${shimmed(['cp'])}:${process.env.PATH}` }, src, `${app}/`);
  assert.notEqual(r.status, 0, `a failed copy returned success:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /the pass went on/, 'the line after a failed seed ran');
});

// The censuses: where the floor runs, and that no pass copies its seed around it.
test('the floor is Stage 1 entry 2 and Stage 2 entry 4, and fronts every Stage 1 cargo entry', () => {
  const { stage1, stage2 } = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification;
  // #257 adds --profiles here, and only here: the whole-profile step runs before any build.
  assert.equal(stage1[1], 'scripts/disk-floor.sh --profiles');
  assert.deepEqual([...stage1, ...stage2].filter((c) => c.includes('--profiles')), ['scripts/disk-floor.sh --profiles'], '--profiles is passed outside Stage 1 entry 2');
  assert.equal(stage2[3], 'scripts/disk-floor.sh');
  assert.match(stage2[2], /tauri build --bundles appimage/, 'the AppImage build is no longer entry 3');
  const cargo = stage1.filter((c) => c.includes('cargo '));
  assert.ok(cargo.length >= 13, `only ${cargo.length} cargo entries found`);
  for (const c of cargo) assert.ok(c.startsWith('scripts/disk-floor.sh --brief && '), `a Stage 1 cargo entry runs past a red floor:\n  ${c}`);
  for (const [f, needle] of [['.github/workflows/stage2-artifact.yml', 'Stage 2 starts at entry 4'], ['frontend/tests/lib/stage2-artifact-matches-the-gate.test.mjs', 'starts Stage 2 at entry 4']]) {
    assert.ok(fs.readFileSync(path.join(repo, f), 'utf8').includes(needle), `${f} still tells a person with a downloaded artifact to skip the floor`);
  }
});

test('the full floor sweeps first; --brief never does; without --profiles no profile goes (#257)', () => {
  const fx = checkout('swept');
  const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  const g = (...a) => spawnSync('git', ['-C', fx.work, ...ID, ...a], { encoding: 'utf8' });
  g('add', '-A'); g('commit', '-qm', 'fixture'); g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const wt = path.join(fx.work, '..', 'swept-done');
  g('worktree', 'add', '-q', '--detach', wt, 'HEAD');
  const old = new Date(Date.now() - 2 * 86400000);
  const age = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(d, e.name); if (e.isDirectory()) age(p); fs.lutimesSync(p, old, old); } };
  age(wt);
  // A Cargo target over a 1-byte cap, with incremental/ and a profile's artifacts.
  const t = path.join(fx.work, 'target');
  fs.writeFileSync(path.join(t, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  fs.writeFileSync(path.join(t, 'debug', '.cargo-lock'), '');
  fs.mkdirSync(path.join(t, 'debug', 'deps'), { recursive: true }); fs.writeFileSync(path.join(t, 'debug', 'deps', 'liba.rlib'), 'x');
  const brief = floor(fx, { BC_TARGET_CAP_BYTES: '1' }, ['--brief']);
  assert.ok(fs.existsSync(wt) && fs.existsSync(path.join(t, 'debug', 'incremental')), `--brief swept:\n${brief.out}`);
  const full = floor(fx, { BC_TARGET_CAP_BYTES: '1' });
  assert.ok(!fs.existsSync(wt), `the full floor did not sweep a worktree that is done:\n${full.out}`);
  assert.ok(!fs.existsSync(path.join(t, 'debug', 'incremental')), `the full floor did not cap the target:\n${full.out}`);
  assert.ok(fs.existsSync(path.join(t, 'debug', 'deps', 'liba.rlib')), `the floor emptied a profile without --profiles:\n${full.out}`);
});

test('the floor has one default, which the check and the seed copy both read', () => {
  const file = path.join(repo, 'scripts', 'lib', 'disk-floor-default.sh');
  assert.match(fs.readFileSync(file, 'utf8'), /^DISK_FLOOR_DEFAULT_GB=\d+$/m);
  for (const f of ['scripts/disk-floor.sh', 'scripts/lib/kept-profile.sh']) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.match(text, /disk-floor-default\.sh"/, `${f} does not source the default`);
    assert.doesNotMatch(text, /BC_DISK_FLOOR_GB:-\d/, `${f} carries a default of its own`);
    assert.match(text, /\$\{BC_DISK_FLOOR_GB:-\$DISK_FLOOR_DEFAULT_GB\}/, `${f} does not read the shared default`);
  }
});

test('no pass copies from the model cache except through seed_copy', () => {
  const dir = path.join(repo, 'scripts');
  let copies = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /^stage2-.*\.sh$/.test(n))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => {
      if (/seed_copy "\$CACHE\/models/.test(l)) copies++;
      // From the cache, not into it: stage2-record-check.sh snapshots a profile into an empty cache.
      assert.ok(!/\bcp\b(?:\s+-\S+)*\s+"\$CACHE\/models/.test(l), `${f}:${i + 1} copies its seed around the floor:\n  ${l.trim()}`);
    });
  }
  assert.equal(copies, 7, 'the seed copies the issue names are core, two-channel, ui-record, onboarding x3 and record');
});

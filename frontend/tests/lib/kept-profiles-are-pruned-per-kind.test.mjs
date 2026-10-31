// Kept Stage 2 profiles are pruned per kind, with a lock rather than a clock. (#248)
//
// Before it creates its profile, a pass removes the kept profiles of its own kind but the newest K,
// and strips the K it keeps (a-kept-profile-keeps-evidence-not-models.test.mjs). K is two, or the
// number of Stage 2 entries that run the pass, if more: with two, a gate run in which three onboarding
// modes failed deleted the first one's logs before the verdict was written, because every mode prunes
// its kind before it starts.
//
// A live profile is told from a kept one by `flock` on <profile>/.lock, held by the run for as long as
// it runs. A profile with no lock file, from before the lock or from a gopnik.json entry that spans
// several entries, is skipped while anything in it was written in the last hour -- judged by the
// newest file in the tree, because a directory's own mtime records only when it was created.
//
// Every fixture lives under its own root; no test here runs the prune against /tmp.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIB = path.join(repo, 'scripts', 'lib', 'kept-profile.sh');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-prune-'));
const holders = [];
// Each holder leads a process group of its own, and the group is what is killed. `flock` runs `sleep` as
// its child, so killing `flock` alone left `sleep 60` running for a minute after this file ended;
// `pnpm test`'s runner names a process a file leaves behind (#268), and found this one.
const killGroup = (h) => { try { process.kill(-h.pid, 'SIGKILL'); } catch { /* already gone */ } };
process.on('exit', () => { for (const h of holders) killGroup(h); fs.rmSync(base, { recursive: true, force: true }); });

const libEnv = (env, body, ...args) => spawnSync('bash', ['-c', `set -euo pipefail; say() { printf 'pass: %s\\n' "$*" >&2; }; . "$1"; shift; ${body}`, 'x', LIB, ...args],
  { encoding: 'utf8', env: { ...process.env, BC_KEEP_MODELS: '', ...env } });
const lib = (body, ...args) => libEnv({}, body, ...args);
const MIN = 60_000;

// A profile as a pass leaves it: a seeded model and a log, every file `ageMin` minutes old, and the
// directory itself `dirAgeMin` old. `lock: 'free'` leaves a lock file nobody holds; 'held' holds it.
function profile(root, name, { ageMin, dirAgeMin = ageMin, lock } = {}) {
  const d = path.join(root, name);
  const models = path.join(d, 'home', '.local', 'share', 'tech.madduck.backchannel', 'models');
  fs.mkdirSync(models, { recursive: true });
  const files = [path.join(models, 'm.gguf'), path.join(d, 'run.log')];
  fs.writeFileSync(files[0], 'model bytes');
  fs.writeFileSync(files[1], 'evidence');
  if (lock) { files.push(path.join(d, '.lock')); fs.writeFileSync(files[2], ''); }
  const t = new Date(Date.now() - ageMin * MIN);
  for (const f of files) fs.utimesSync(f, t, t);
  for (const dir of [models, path.dirname(models), path.join(d, 'home', '.local', 'share'), path.join(d, 'home', '.local'), path.join(d, 'home')]) fs.utimesSync(dir, t, t);
  const dt = new Date(Date.now() - dirAgeMin * MIN);
  fs.utimesSync(d, dt, dt);
  if (lock === 'held') {
    const h = spawn('flock', [path.join(d, '.lock'), 'sleep', '60'], { stdio: 'ignore', detached: true });
    h.unref(); // the holder is killed on exit; it must not keep the test process alive for a minute
    holders.push(h);
    for (let i = 0; i < 100 && spawnSync('flock', ['-n', path.join(d, '.lock'), 'true']).status === 0; i++) spawnSync('sleep', ['0.05']);
  }
  return d;
}
const exists = (p) => fs.existsSync(p);
const stripped = (d) => !exists(path.join(d, 'home', '.local', 'share', 'tech.madduck.backchannel', 'models', 'm.gguf')) && exists(path.join(d, 'kept-models.txt'));

// A gopnik.json of n entries running a pass, so K is taken from the file it is read from.
function gopnik(script, n) {
  const p = path.join(base, `gopnik-${script}-${n}.json`);
  fs.writeFileSync(p, JSON.stringify({ verification: { stage2: [
    'cargo build', ...Array.from({ length: n }, (_, i) => `scripts/${script} "$APP" mode-${i}`), `scripts/stage2-ui-${script}`,
  ] } }));
  return p;
}
const keepCount = (script, file) => lib('kept_profile_keep_count "$@"', script, file).stdout.trim();

test('K is two, or the number of Stage 2 entries running the pass', () => {
  assert.equal(keepCount('stage2-core-check.sh', gopnik('stage2-core-check.sh', 5)), '5', 'a fifth core entry did not raise K to five');
  assert.equal(keepCount('stage2-onboarding-check.sh', gopnik('stage2-onboarding-check.sh', 1)), '2');
  // By path, not by substring: stage2-record-check.sh is inside stage2-ui-record-check.sh.
  assert.equal(keepCount('stage2-record-check.sh', gopnik('stage2-ui-record-check.sh', 6)), '2');
  // And from the real gopnik.json, which is what the passes read.
  assert.equal(lib('kept_profile_keep_count stage2-onboarding-check.sh').stdout.trim(), '10');
  assert.equal(lib('kept_profile_keep_count stage2-core-check.sh').stdout.trim(), '4');
});

test('eleven failed onboarding modes leave ten profiles, stripped, and the oldest removed', () => {
  const root = fs.mkdtempSync(path.join(base, 'eleven-'));
  const all = Array.from({ length: 11 }, (_, i) => profile(root, `backchannel-onboarding.mode${String(i).padStart(2, '0')}`, { ageMin: 120 + i, lock: 'free' }));
  const r = lib('kept_profile_prune "$1" onboarding "$(kept_profile_keep_count stage2-onboarding-check.sh)"', root);
  assert.equal(r.status, 0, r.stderr);
  for (const d of all.slice(0, 10)) assert.ok(exists(d) && stripped(d), `${path.basename(d)} should remain, stripped`);
  assert.ok(!exists(all[10]), 'the oldest of eleven was kept');
  assert.match(r.stderr, new RegExp(`removed ${all[10]} \\(`), 'the prune did not name what it removed, with its size');
  assert.match(r.stderr, new RegExp(`stripped \\d+ bytes of models from ${all[0]}`), 'the prune did not name what it stripped');
});

test('what the prune never touches, and what it keeps', () => {
  const root = fs.mkdtempSync(path.join(base, 'cells-'));
  const newest = profile(root, 'backchannel-core.newest', { ageMin: 5, lock: 'free' });
  const second = profile(root, 'backchannel-core.second', { ageMin: 6, lock: 'free' });
  const old = profile(root, 'backchannel-core.oldest', { ageMin: 300, lock: 'free' });
  const locked = profile(root, 'backchannel-core.locked', { ageMin: 400, lock: 'held' });
  // Two hours old by its directory, but a file in it was written ten minutes ago, and it has no lock.
  const live = profile(root, 'backchannel-core.livenl', { ageMin: 10, dirAgeMin: 120 });
  const sibling = profile(root, 'backchannel-core-audio.sibl00', { ageMin: 500, lock: 'free' });
  const other = profile(root, 'backchannel-ui-check.other0', { ageMin: 500, lock: 'free' });
  const target = profile(root, 'elsewhere', { ageMin: 600, lock: 'free' });
  const link = path.join(root, 'backchannel-core.linked');
  fs.symlinkSync(target, link);
  // Old itself, so a prune that follows it would remove it rather than keep it as the newest.
  fs.lutimesSync(link, new Date(Date.now() - 700 * MIN), new Date(Date.now() - 700 * MIN));

  const r = lib('kept_profile_prune "$1" core 2', root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(newest) && exists(second), 'the newest two were removed');
  assert.ok(stripped(newest) && stripped(second), 'the two kept profiles keep their models');
  assert.ok(!exists(old), 'the prune removed nothing');
  assert.ok(exists(locked) && !stripped(locked), 'a profile whose lock is held was touched');
  assert.ok(exists(live) && !stripped(live), 'a profile written ten minutes ago, with an old directory and no lock, was touched');
  assert.ok(exists(sibling) && !stripped(sibling), 'a sibling kind sharing the prefix was touched');
  assert.ok(exists(other) && !stripped(other), 'another kind was touched');
  const isLink = (() => { try { return fs.lstatSync(link).isSymbolicLink(); } catch { return false; } })();
  assert.ok(isLink, 'a symlink named like a profile was removed');
  assert.ok(exists(path.join(target, 'run.log')) && !stripped(target), 'the prune followed a symlink');
});

test('BC_KEEP_MODELS=1 keeps the models of its own run, not of the profiles a prune keeps', () => {
  const root = fs.mkdtempSync(path.join(base, 'keep-'));
  const a = profile(root, 'backchannel-core.keepaa', { ageMin: 300, lock: 'free' });
  const b = profile(root, 'backchannel-core.keepbb', { ageMin: 200, lock: 'free' });
  const r = libEnv({ BC_KEEP_MODELS: '1' }, 'kept_profile_prune "$1" core 4', root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(stripped(a) && stripped(b), `a prune run under BC_KEEP_MODELS=1 left the profiles it keeps with their models:\n${r.stderr}`);
});

test('a profile is ranked by its own files, so a strip does not make it the newest', () => {
  const root = fs.mkdtempSync(path.join(base, 'rank-'));
  const oldest = profile(root, 'backchannel-core.rank30', { ageMin: 300, lock: 'free' });
  const middle = profile(root, 'backchannel-core.rank20', { ageMin: 200, lock: 'free' });
  const newest = profile(root, 'backchannel-core.rank10', { ageMin: 100, lock: 'free' });
  assert.equal(lib('kept_profile_prune "$1" core 3', root).status, 0);
  assert.ok([oldest, middle, newest].every(stripped), 'the first prune did not strip the three it keeps');
  const r = lib('kept_profile_prune "$1" core 2', root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(oldest), `the oldest profile survived a prune to two, ranked by when it was stripped:\n${r.stderr}`);
  assert.ok(exists(middle) && exists(newest), 'a prune to two removed one of the two newest');
});

test('kept_profile_lock holds a live profile against a concurrent prune', async () => {
  const root = fs.mkdtempSync(path.join(base, 'live-'));
  const live = profile(root, 'backchannel-core.live00', { ageMin: 300 });
  // The real function, in a shell that stays alive as a pass does, and says when it holds the lock.
  const holder = spawn('bash', ['-c', `say() { :; }; . "$1"; kept_profile_lock "$2" && echo locked; sleep 30`, 'x', LIB, live], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  holder.unref(); holders.push(holder);
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve(); });
    holder.on('exit', () => reject(new Error('kept_profile_lock did not take the lock')));
  });
  holder.stdout.destroy();
  const r = lib('kept_profile_prune "$1" core 0', root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(live) && !stripped(live), `a prune removed or stripped a profile whose run holds kept_profile_lock:\n${r.stderr}`);
});

test('a profile the prune cannot remove is named, and the pass goes on', () => {
  const root = fs.mkdtempSync(path.join(base, 'stuck-'));
  const stuck = profile(root, 'backchannel-core.stuck0', { ageMin: 500, lock: 'free' });
  const locked = path.join(stuck, 'home');
  fs.chmodSync(locked, 0o500);
  try {
    const r = lib('kept_profile_prune "$1" core 0; echo "the pass went on"', root);
    assert.equal(r.status, 0, `a failed removal stopped a set -e pass:\n${r.stderr}`);
    assert.match(r.stdout, /the pass went on/);
    assert.match(r.stderr, /could not remove .*backchannel-core\.stuck0/);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

// The census, under set equality: every kind a run creates with `mktemp -d /tmp/backchannel-` is a
// kind it prunes first, in scripts/ and in gopnik.json, and each prune's K is the one above.
test('every profile kind created is pruned first, with its K', () => {
  const sources = fs.readdirSync(path.join(repo, 'scripts')).filter((n) => n.endsWith('.sh')).map((n) => [`scripts/${n}`, fs.readFileSync(path.join(repo, 'scripts', n), 'utf8')]);
  const stage2 = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification.stage2;
  stage2.forEach((c, i) => sources.push([`gopnik.json stage2 entry ${i + 1}`, c]));
  const created = new Map(); const pruned = new Map();
  for (const [where, text] of sources) {
    for (const m of text.matchAll(/mktemp -d \/tmp\/backchannel-([a-z0-9-]+)\.XXXXXX/g)) created.set(m[1], where);
    for (const m of text.matchAll(/kept_profile_prune \/tmp ([a-z0-9-]+) ("\$\(kept_profile_keep_count ([^ )]+)\)"|\d+)/g)) {
      pruned.set(m[1], where);
      if (m[3]) assert.ok(where.endsWith(`/${m[3]}`), `${where} prunes ${m[1]} with the K of another pass, ${m[3]}`);
      else assert.equal(Number(m[2]), Math.max(2, stage2.filter((c) => c.includes(`/tmp/backchannel-${m[1]}.XXXXXX`)).length), `${where}: K for ${m[1]}`);
    }
  }
  assert.ok(created.size >= 7, `found only ${created.size} kinds; the census reads nothing`);
  assert.deepEqual([...pruned.keys()].sort(), [...created.keys()].sort(),
    'a kind is created without being pruned, or pruned without being created');
  for (const [where, text] of sources) {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/mktemp -d \/tmp\/backchannel-([a-z0-9-]+)\.XXXXXX/);
      if (!m) return;
      const before = lines.slice(Math.max(0, i - 2), i + 1).join('\n').split(m[0])[0];
      assert.ok(before.includes(`kept_profile_prune /tmp ${m[1]} `), `${where}:${i + 1} creates ${m[1]} without pruning it just before`);
      // stage2 (gopnik.json entry 5) spans entries 5-12 in separate shells, so nothing can hold a
      // lock for it; it is left to the one-hour rule, as #248 records.
      if (m[1] === 'stage2') return;
      const after = lines.slice(i, i + 3).join('\n').split(m[0])[1];
      assert.ok(/kept_profile_lock /.test(after), `${where}:${i + 1} creates ${m[1]} without holding kept_profile_lock on it`);
    });
  }
});

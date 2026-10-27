// A kept Stage 2 profile keeps its evidence and drops the model bytes. (#248)
//
// Every pass seeds its profile with models copied from a cache, 5.2 GB for stage2-core, and a pass
// that fails keeps the profile for inspection. Nothing removed one before systemd-tmpfiles' 30 days:
// on 2026-10-27, 38 kept profiles held 57 GB, and the product owner's disk was at 99% the morning of
// a meeting they were to record. `kept_profile_strip` (scripts/lib/kept-profile.sh) records every
// model file in `kept-models.txt` and deletes it; the logs, the driver log and the recording stay.
//
// It runs more than once on one profile -- the prune strips the profiles it keeps, and one pass runs
// several times in a row -- so the manifest is append-only, and a profile with nothing left to strip
// is not touched. The last test is the census: every pass that keeps its profile calls the step.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIB = path.join(repo, 'scripts', 'lib', 'kept-profile.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-strip-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function strip(profile, env = {}) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; say() { printf 'pass: %s\\n' "$*" >&2; }; . "$1"; kept_profile_strip "$2"`, 'x', LIB, profile],
    { encoding: 'utf8', env: { ...process.env, BC_KEEP_MODELS: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stderr;
}
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const ns = (p) => String(fs.statSync(p, { bigint: true }).mtimeNs);

// A cache, and a profile seeded from it the way a pass seeds one, plus what the app and the pass add.
function fixture(name) {
  const cache = path.join(root, name, 'cache', 'models');
  const profile = path.join(root, name, 'backchannel-core.abcdef');
  const app = path.join(profile, 'home', '.local', 'share', 'tech.madduck.backchannel');
  write(path.join(cache, 'seeded.gguf'), 'seeded model bytes');
  write(path.join(cache, 'touched.gguf'), 'touched model bytes');
  write(path.join(cache, 'summary', 'grown.gguf'), 'partial');
  fs.cpSync(cache, path.join(app, 'models'), { recursive: true, preserveTimestamps: true });
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(cache, 'seeded.gguf'), old, old);
  fs.utimesSync(path.join(app, 'models', 'seeded.gguf'), old, old);
  fs.utimesSync(path.join(app, 'models', 'touched.gguf'), new Date(), new Date());
  fs.appendFileSync(path.join(app, 'models', 'summary', 'grown.gguf'), ' and the rest of a download');
  write(path.join(profile, 'home', '.local', 'share', 'com.conversationaly.ai', 'models', 'older-build.gguf'), 'an older identifier');
  write(path.join(app, 'logs', 'app.log'), 'the application log');
  write(path.join(profile, 'rec', 'checkpoint.wav'), 'RIFF');
  write(path.join(profile, 'tauri-driver.log'), 'the driver log');
  const models = [
    'home/.local/share/com.conversationaly.ai/models/older-build.gguf',
    'home/.local/share/tech.madduck.backchannel/models/seeded.gguf',
    'home/.local/share/tech.madduck.backchannel/models/summary/grown.gguf',
    'home/.local/share/tech.madduck.backchannel/models/touched.gguf',
  ];
  const before = Object.fromEntries(models.map((m) => [m, { size: fs.statSync(path.join(profile, m)).size, mtime: ns(path.join(profile, m)) }]));
  return { profile, app, models, before };
}

test('the step records every model file, deletes it, keeps the evidence, and never rewrites its record', () => {
  const { profile, app, models, before } = fixture('runs');
  const manifest = path.join(profile, 'kept-models.txt');

  const said = strip(profile);
  for (const m of models) assert.ok(!fs.existsSync(path.join(profile, m)), `${m} is still in the kept profile`);
  for (const kept of [path.join(app, 'logs', 'app.log'), path.join(profile, 'rec', 'checkpoint.wav'), path.join(profile, 'tauri-driver.log')]) {
    assert.ok(fs.existsSync(kept), `${kept} is evidence and was deleted`);
  }
  assert.ok(fs.existsSync(manifest), 'no kept-models.txt was written');
  const first = fs.readFileSync(manifest, 'utf8');
  const rows = first.trimEnd().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows.map((r) => r[0]), models, 'the manifest does not list every model file the profile held');
  for (const [rel, size, mtime, sum] of rows) {
    assert.equal(Number(size), before[rel].size, `${rel}: wrong size`);
    assert.equal(mtime.replace('.', '').replace(/^0+/, ''), before[rel].mtime, `${rel}: the mtime is not the file's, in nanoseconds`);
    assert.match(sum, /^[0-9a-f]{64}$/, `${rel}: no sha256`);
  }
  assert.match(said, /stripped \d+ bytes of models from /, 'the step did not say what it freed');

  strip(profile);
  assert.equal(fs.readFileSync(manifest, 'utf8'), first, 'a second run over a stripped profile changed its record');

  write(path.join(app, 'models', 'later.gguf'), 'a model the next run downloaded');
  strip(profile);
  const third = fs.readFileSync(manifest, 'utf8');
  assert.ok(third.startsWith(first), 'the third run rewrote what the first one recorded');
  assert.match(third.slice(first.length), /^home\/\.local\/share\/tech\.madduck\.backchannel\/models\/later\.gguf\t/, 'the new file was not appended');
  assert.ok(!fs.existsSync(path.join(app, 'models', 'later.gguf')));
});

test('BC_KEEP_MODELS=1 keeps every model, writes no manifest, and says so', () => {
  const { profile, models } = fixture('keep');
  const said = strip(profile, { BC_KEEP_MODELS: '1' });
  for (const m of models) assert.ok(fs.existsSync(path.join(profile, m)), `${m} was removed under BC_KEEP_MODELS=1`);
  assert.ok(!fs.existsSync(path.join(profile, 'kept-models.txt')), 'a manifest was written under BC_KEEP_MODELS=1');
  assert.match(said, /BC_KEEP_MODELS=1/);
});

// The census. A keep branch is the line that prints "profile kept"; the step is called on that line
// or the one before it, so a new pass that keeps a profile and forgets the step goes red here.
test('every pass that keeps its profile strips it', () => {
  const dir = path.join(repo, 'scripts');
  const keeping = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => /^stage2-.*\.sh$/.test(n)).sort()) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/profile kept/.test(l)) return;
      keeping.add(f);
      assert.ok(/kept_profile_strip /.test(l) || /kept_profile_strip /.test(lines[i - 1] ?? ''),
        `${f}:${i + 1} keeps its profile without kept_profile_strip:\n  ${l.trim()}`);
    });
  }
  assert.deepEqual([...keeping].sort(), [
    'stage2-core-check.sh', 'stage2-onboarding-check.sh', 'stage2-two-channel-check.sh',
    'stage2-ui-check.sh', 'stage2-ui-record-check.sh',
  ], 'the passes that keep a profile changed; this list is what the issue names');
});

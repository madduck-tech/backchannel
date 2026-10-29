// vendor/pulseaudio is the published crate, changed in two files and no others. (#243, ADR 0033)
//
// The fork exists to send a 256-byte cookie. Anything else that drifted from the published crate --
// an edit made while debugging, a file lost to the crate's own .gitignore, which hides its Cargo.lock
// -- would ship in the audio path unreviewed. PUBLISHED.sha256 holds every file of
// pulseaudio-0.3.1.crate as published; this holds the tree to it. The tree is what git tracks, not
// what is on disk: this repository's .gitignore hides *.wav and .vscode, and three of the crate's
// files would have stayed on the disk they were extracted to and never reached a clone.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vendor', 'pulseaudio');
const CHANGED = ['src/client.rs', 'src/lib.rs'];
const OURS = ['BACKCHANNEL.md', 'PUBLISHED.sha256'];
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('every file but the two changed ones is the published crate\'s, byte for byte', () => {
  const published = new Map(fs.readFileSync(path.join(vendor, 'PUBLISHED.sha256'), 'utf8').split('\n')
    .filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => [l.slice(66), l.slice(0, 64)]));
  assert.ok(published.size >= 60, `PUBLISHED.sha256 lists only ${published.size} files`);
  const onDisk = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: vendor, encoding: 'utf8' }).split('\0').filter((f) => f && !OURS.includes(f)).sort();
  assert.deepEqual(onDisk, [...published.keys()].sort(), 'git does not track exactly the published crate\'s files under vendor/pulseaudio');
  const drifted = onDisk.filter((f) => !CHANGED.includes(f) && sha(path.join(vendor, f)) !== published.get(f));
  assert.deepEqual(drifted, [], `files that differ from the published crate though ADR 0033 changes none of them`);
  for (const f of CHANGED) assert.notEqual(sha(path.join(vendor, f)), published.get(f), `${f} is the published file: the patch is gone`);
  // The two forked files are pinned in BACKCHANNEL.md: a change to the cookie code changes them on purpose.
  const notes = fs.readFileSync(path.join(vendor, 'BACKCHANNEL.md'), 'utf8');
  for (const f of CHANGED) {
    const m = notes.match(new RegExp('- `' + f.replace('.', '\\.') + '` `([0-9a-f]{64})`'));
    assert.ok(m, `BACKCHANNEL.md pins no sha256 for ${f}`);
    assert.equal(sha(path.join(vendor, f)), m[1], `${f} is not the forked file BACKCHANNEL.md records`);
  }
});

test('the workspace patches crates.io with the fork, and does not make it a member', () => {
  const root = fs.readFileSync(path.join(vendor, '..', '..', 'Cargo.toml'), 'utf8');
  assert.match(root, /^\[patch\.crates-io\]\npulseaudio = \{ path = "vendor\/pulseaudio" \}$/m);
  assert.match(root, /^exclude = \["vendor\/pulseaudio"\]$/m);
  const lock = fs.readFileSync(path.join(vendor, '..', '..', 'Cargo.lock'), 'utf8');
  // Every pulseaudio in the lock, not the first: a cpal that moved to another version would take it from
  // the registry beside the fork, and the fork would serve only the tests (the gate adversary, round 1).
  const entries = lock.split('\n[[package]]\n').filter((b) => b.startsWith('name = "pulseaudio"\n'));
  assert.equal(entries.length, 1, `Cargo.lock holds ${entries.length} pulseaudio packages`);
  const entry = entries[0];
  assert.match(entry, /^version = "0\.3\.1"$/m);
  assert.doesNotMatch(entry, /^source = /m, 'Cargo.lock resolves pulseaudio from a registry, not the fork');
});

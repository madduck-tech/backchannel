// The release workflow produces what the product owner asked for: a pre-release of Backchannel for
// macOS, Windows and Linux, tagged at the commit it built, with a checksum for every file (#229).
//
// `release.yml` had never run in this repository. It was upstream's, and four of its choices were
// wrong for Backchannel in ways no run would have flagged: Linux was left out, the release was not a
// pre-release, it was named after upstream, and its tag was cut at publish from whatever `main` was
// then. A fifth was silent: tauri-action uploads a `.app.tar.gz` the checksum filter did not match,
// so one asset shipped with nothing to verify it by. Each is asserted here, against the file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const release = fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
const build = fs.readFileSync(path.join(repo, '.github', 'workflows', 'build.yml'), 'utf8');

// The `createRelease` call inside the github-script step, which a YAML reader keeps as text anyway.
const createRelease = /createRelease\(\{([\s\S]*?)\}\)/.exec(release)?.[1] ?? '';

test('the release is built for macOS, Windows and Linux', () => {
  const include = /matrix:\s*\n\s*include:\s*\n((?:\s+-[\s\S]*?)(?=\n\s{4}uses:))/.exec(release)?.[1] ?? '';
  const targets = [...include.matchAll(/target:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(targets, ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
  assert.match(include, /platform:\s*"ubuntu-24\.04"/, 'Linux is built where stage2-artifact.yml builds the verified AppImage');
});

test('it is a draft pre-release named Backchannel, tagged at the commit it built', () => {
  assert.ok(createRelease, 'no createRelease call found in release.yml');
  assert.match(createRelease, /^\s*draft:\s*true,/m);
  assert.match(createRelease, /^\s*prerelease:\s*true,/m);
  assert.match(createRelease, /^\s*target_commitish:\s*context\.sha,/m, 'without it the tag is cut at publish, from a commit nobody built');
  assert.match(createRelease, /^\s*name:\s*`Backchannel v/m);
});

test('every file tauri-action uploads is checksummed', () => {
  const filter = /select\(\.name \| test\("(.+?)"\)\)/.exec(release)?.[1];
  assert.ok(filter, 'no checksum filter found in release.yml');
  // jq's string escapes, undone once: `\\.` in the file is `\.` in the regex jq runs.
  const re = new RegExp(filter.replace(/\\\\/g, '\\'));
  const assets = [
    'Backchannel_0.1.0_aarch64.dmg',
    'Backchannel_aarch64.app.tar.gz',
    'Backchannel_0.1.0_x64-setup.exe',
    'Backchannel_0.1.0_x64_en-US.msi',
    'Backchannel_0.1.0_amd64.AppImage',
    'Backchannel_0.1.0_amd64.deb',
  ];
  assert.deepEqual(assets.filter((a) => !re.test(a)), [], `assets the checksum filter ${re} misses`);
  assert.ok(!re.test('SHA256SUMS'), 'the checksum file must not checksum itself');
});

test('a release leg does not repack the AppImage after uploading it', () => {
  const step = /- name: Remove libwayland-client\.so from AppImage[\s\S]*?\n\s*if:\s*(.+)/.exec(build)?.[1] ?? '';
  assert.match(step, /inputs\.release-id == ''/, 'a failed repack after the upload would skip SHA256SUMS');
});

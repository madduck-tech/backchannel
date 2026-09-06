// Updater artifacts may not be produced for an updater identity this fork does not own.
//
// #4. `tauri.conf.json` had `createUpdaterArtifacts: true` and a pubkey, so `tauri build` demanded
// `TAURI_SIGNING_PRIVATE_KEY` for nsis/msi/deb/rpm/appimage and for the macOS `Updater` bundle. This
// repository has no secrets at all (`gh api …/actions/secrets` → `total_count=0`), and a missing
// variable and an empty one fail alike, so the Windows and macOS bundles could not be built. Both
// legs of run 34024203537 died on the same line:
//
//     failed to decode secret key: incorrect updater private key password: Missing comment in secret key
//
// The obvious fix — extend #3's `--no-sign` past Linux — is wrong: `--no-sign` also skips *platform*
// code signing (`tauri-bundler/.../macos/app.rs:115`), and `bundle.macOS.signingIdentity` is `"-"`,
// so macOS ad-hoc signing happens today and an unsigned bundle is refused on Apple Silicon.
// Turning the artifacts off instead never reaches the signing code at all:
// `tauri-cli/interface/rust.rs:855` makes `updater_enabled` false, so `updater_settings` is `None`,
// so `bundle.rs:231` returns before the key lookup at `:277`.
//
// **This check is not a pin on `false`.** It holds the coupling that matters: artifacts may be
// produced only once the endpoints they would be advertised through belong to this fork. Today they
// point at `bykof/conversationaly` — upstream — which is #79, and turning artifacts back on while
// that is still true would produce signed artifacts for someone else's release feed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const FORK = '/madduck-tech/backchannel/';
const artifacts = config.bundle?.createUpdaterArtifacts;
const endpoints = config.plugins?.updater?.endpoints ?? [];

// `createUpdaterArtifacts` is tri-state in tauri 2: `false`, `true`, or a string for the v1
// compatible zip. Anything that is not literally `false` enables the updater path
// (`rust.rs:855` compares against `Updater::Bool(false)`), so that is the test.
const artifactsEnabled = artifacts !== false;

const foreign = endpoints.filter((url) => {
  try {
    return !new URL(url).pathname.startsWith(FORK);
  } catch {
    return true; // an unparseable endpoint is not this fork's
  }
});

assert.ok(
  !artifactsEnabled || foreign.length === 0,
  'updater artifacts are enabled while the updater endpoint does not belong to this fork.\n' +
    `  createUpdaterArtifacts: ${JSON.stringify(artifacts)}\n` +
    `  endpoints outside ${FORK}:\n    ${foreign.join('\n    ') || '(none)'}\n\n` +
    '  Producing signed updater artifacts for a feed this fork does not control is worse than\n' +
    '  producing none. Move the endpoint and the pubkey to this fork first (#79), then enable\n' +
    '  the artifacts and give the repository a TAURI_SIGNING_PRIVATE_KEY — without one the\n' +
    '  Windows and macOS bundles fail outright (#4).'
);

// The state this repository is actually in, asserted so that *changing* it is a deliberate act
// rather than a side effect of editing a neighbouring key.
assert.equal(
  artifactsEnabled,
  false,
  'this fork owns no updater identity yet, so it must produce no updater artifacts'
);
assert.ok(
  foreign.length > 0,
  'the endpoint now belongs to this fork — #79 is resolved, and the first assertion above has ' +
    'become the only one that matters. Delete this one and enable the artifacts deliberately.'
);

console.log(
  `ok - updater artifacts off, ${endpoints.length} endpoint(s) still outside ${FORK} (#79): ` +
    `${foreign.join(', ')}`
);

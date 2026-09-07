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

const FORK_ORIGIN = 'https://github.com';
const FORK_PATH = '/madduck-tech/backchannel/';
const artifacts = config.bundle?.createUpdaterArtifacts;
const updater = config.plugins?.updater;
const endpoints = updater?.endpoints ?? [];
const pubkey = updater?.pubkey ?? '';

// `createUpdaterArtifacts` is tri-state in tauri 2: `false`, `true`, or a string for the v1
// compatible zip. Anything that is not literally `false` enables the updater path
// (`rust.rs:855` compares against `Updater::Bool(false)`), so that is the test.
const artifactsEnabled = artifacts !== false;

// **Origin as well as path, and #79 is why.** The first version checked only
// `new URL(url).pathname.startsWith(FORK)`, which is host-blind: measured, it accepts
// `https://evil.example.com/madduck-tech/backchannel/latest.json` and
// `http://10.0.0.1/madduck-tech/backchannel/latest.json`. A path prefix is not an identity.
const foreign = endpoints.filter((url) => {
  try {
    const u = new URL(url);
    return u.origin !== FORK_ORIGIN || !u.pathname.startsWith(FORK_PATH);
  } catch {
    return true; // an unparseable endpoint is not this fork's
  }
});

// --- 1: unconditional. The app must not reach a feed this fork does not own -----------------------
//
// #4 made this conditional on `createUpdaterArtifacts`, which held the *publishing* side: do not
// sign artifacts for someone else's feed. It said nothing about *consuming* one. So the check was
// green while the application polled upstream's release feed on every launch and trusted upstream's
// key -- a green test beside a live defect, which is the shape this repository refuses. #79.
assert.deepEqual(
  foreign,
  [],
  'the application would fetch an update from a feed this fork does not own.\n' +
    `  endpoints not under ${FORK_ORIGIN}${FORK_PATH}:\n    ${foreign.join('\n    ')}\n\n` +
    '  `check()` compares only the platform key (`get_urls`, updater.rs:568-598); nothing compares\n' +
    '  the app identifier, product name or bundle identity. A manifest carrying the right platform\n' +
    '  key and a signature under the configured pubkey is accepted whoever published it.'
);

// --- 2: the key, asserted positively --------------------------------------------------------------
//
// Not "the pubkey is not upstream's" -- that is a denylist of one, and it passes for any *other*
// foreign key. The fork either owns no updater identity (empty) or owns its own, and there is no
// third acceptable state. Upstream's key is named so a paste-back is caught by name rather than by
// inequality.
const UPSTREAM_KEY_ID = '4FECE404B2F95298';
const decoded = pubkey ? Buffer.from(pubkey, 'base64').toString('utf8') : '';
assert.ok(
  !decoded.includes(UPSTREAM_KEY_ID),
  `the updater pubkey is upstream's (minisign key ${UPSTREAM_KEY_ID}). A signature from upstream\n` +
    '  would then verify against it, and the update would install whoever published it.'
);
assert.ok(
  pubkey === '' || endpoints.length > 0,
  'a pubkey is configured with no endpoints. Either is defensible alone; together they mean a key\n' +
    '  is being carried for a feed that does not exist, which is how the wrong one gets re-used.'
);

// --- 3: the state this repository is in, so changing it is deliberate ------------------------------
//
// The tripwire that stood here -- `assert.ok(foreign.length > 0)`, asserting #79 was still broken --
// is **deleted**, as its own message instructed. It was a state-pin, and the state changed.
assert.equal(
  artifactsEnabled,
  false,
  'this fork owns no updater identity yet, so it must produce no updater artifacts.\n' +
    '  Enabling them needs an endpoint under this fork, a pubkey this fork owns, and a\n' +
    '  TAURI_SIGNING_PRIVATE_KEY in the repository -- without one the Windows and macOS bundles\n' +
    '  fail outright (#4).'
);

console.log(
  `ok - updater identity: ${endpoints.length} endpoint(s), all under ${FORK_ORIGIN}${FORK_PATH}; ` +
    `pubkey ${pubkey ? 'set and not upstream\'s' : 'empty'}; artifacts off`
);

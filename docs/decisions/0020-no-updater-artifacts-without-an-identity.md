# 0020. No updater artifacts until this fork owns an updater identity

- **Date:** 2026-09-06
- **Status:** Accepted

## Context

Dated facts, each read from source or measured on the day.

- `frontend/src-tauri/tauri.conf.json` was inherited from upstream with
  `bundle.createUpdaterArtifacts: true`, `plugins.updater.pubkey` set to upstream's minisign public
  key, and `plugins.updater.endpoints` pointing at
  `https://github.com/bykof/conversationaly/releases/latest/download/latest.json`.
- The repository has no secrets: `gh api repos/madduck-tech/backchannel/actions/secrets` returns
  `{"total_count":0,"secrets":[]}`, likewise organization secrets and environments, with `admin:
  true`, so the zeros are real.
- With updater artifacts enabled and a pubkey present, `tauri build` requires
  `TAURI_SIGNING_PRIVATE_KEY` for `nsis`, `msi`, `deb`, `rpm`, `appimage` and for the macOS
  `Updater` bundle. An unset variable and an empty one fail alike.
- Measured 2026-09-06, run 34024203537 (`build-devtest.yml`): **both** the macOS and the Windows legs
  failed at `Build Tauri app (unsigned)` with
  `failed to decode secret key: incorrect updater private key password: Missing comment in secret key`.
  The Windows leg reached that step only because #6 had just fixed the sidecar build ahead of it.
- #3 had already worked around this on Linux by passing `--no-sign`, gated to `*ubuntu*`, and
  recorded why it went no further: on macOS and Windows `--no-sign` also skips *platform* code
  signing.
- That reasoning holds and was re-verified: `tauri-bundler/.../macos/app.rs:115` skips codesign under
  `--no-sign`, and `bundle.macOS.signingIdentity` is `"-"`, so `keychain(Some("-"))` returns `Some`
  and ad-hoc signing happens today. An unsigned bundle is refused by the OS on Apple Silicon.
- On Windows `--no-sign` costs nothing today: `can_sign()` is true only because a `signCommand` is
  configured, and that command — `frontend/src-tauri/scripts/sign-windows.ps1` — exits 0 with
  "Skipping signing" when `DIGICERT_KEYPAIR_ALIAS` is unset, which it is.
- The endpoint and pubkey are a second, separate defect: the shipped application registers
  `tauri_plugin_updater` (`frontend/src-tauri/src/lib.rs:421`) and checks upstream's feed
  automatically on launch. That is #79 and this ADR does not decide it.

## Decision

1. **`bundle.createUpdaterArtifacts` is `false`.** The fork produces no updater artifacts and no
   `.sig` files on any platform.
2. **The mechanism is chosen deliberately over `--no-sign`.** `tauri-cli/interface/rust.rs:855`
   computes `updater_enabled = create_updater_artifacts != Updater::Bool(false)`; when it is false
   `updater_settings` is `None`, `tauri-bundler/settings.rs:1306` returns `None`, and
   `tauri-cli/bundle.rs:231` returns before the `TAURI_SIGNING_PRIVATE_KEY` lookup at `:277`. No
   signing code is reached at all, so macOS ad-hoc signing is untouched. Extending `--no-sign` past
   Linux would have removed it.
3. **Artifacts may be re-enabled only together with an endpoint this fork controls.** Producing
   signed artifacts advertised through a feed the fork does not own is worse than producing none.
   `frontend/tests/lib/updater-identity.test.mjs` holds that coupling: artifacts may be enabled only
   when every `plugins.updater.endpoints` URL is under `/madduck-tech/backchannel/`.
4. **The application keeps the updater plugin compiled in and registered.** This ADR changes what is
   *built*, not what the app does at runtime. The runtime pointer at upstream is #79's to remove.
5. **This is not a decision about whether Backchannel has an updater.** It records that it has none
   *yet*, and that the wrong one stops being produced while the right one is chosen. That choice is
   the product owner's (ADR 0014).

## Consequences

- The Windows and macOS bundles can be built again. `release.yml`'s step summary no longer claims
  `.sig` files or a `latest.json` are produced; `release.yml:169` already tolerated a missing
  `latest.json` and now reports its absence honestly.
- `stage2-artifact.yml:95,118` and `gopnik.json:24` already passed
  `createUpdaterArtifacts:false` through `--config`, so every Stage 2 artifact has been built this
  way already. Those overrides become redundant and are left in place: they also pin
  `beforeBuildCommand`, and a config override that agrees with the config is not a defect.
- A user of a released build gets no in-app update path. Nothing has been released, so no user is
  losing one — but this is the reason the deferred question below is not optional.
- `scripts/generate-update-manifest-github.js` generates a manifest pointing at upstream and is
  referenced by nothing. It is dead either way; #79 covers it.
- Re-enabling requires three things together, and the test names them: the endpoint and pubkey moved
  to this fork, a `TAURI_SIGNING_PRIVATE_KEY` in the repository, and this ADR superseded.

## Deferred question

**Does Backchannel have an updater, and on what endpoint and key?** Product-owner call (ADR 0014).
Until it is answered the app ships without one, and #79 must still remove the runtime pointer at
upstream — that pointer is live regardless of what this ADR does to the build.

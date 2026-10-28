# 0033 — The PulseAudio cookie is computed in memory, by a fork of the `pulseaudio` crate patched at the workspace root

Date: 2026-10-28
Status: accepted

## Context

The CI-built Linux AppImage falls back to ALSA, and so records no system audio, when the home directory holds no PulseAudio cookie of 256 bytes (#243).
- **The `pulseaudio` crate (0.3.1)** reads `$PULSE_COOKIE`, `$HOME/.config/pulse/cookie` and `$HOME/.pulse-cookie`, and sends whatever it reads. When it reads nothing, it sends an empty cookie.
- **PipeWire's pulse server** accepts any 256 bytes and refuses every other length.
- **cpal 0.18.1** calls `pulseaudio::Client::from_env` itself, so the application cannot hand it a cookie.
- **Local builds escaped by accident.** They bundle libcanberra, whose pulse driver loads libpulse, and libpulse writes a cookie before the Rust client connects.

#243 requires the cookie sent to be exactly 256 bytes:
- the first 256 bytes of the first cookie file found, in libpulse's order;
- or, when no file holds 256 bytes, a value held in memory.

It also requires that the audio host write nothing to the user's home, and that this ADR decide where the change lives. The issue named three routes.

## Decision

1. **A fork of `pulseaudio` 0.3.1 lives at `vendor/pulseaudio`, and the root `Cargo.toml` patches crates.io with it.**
   - It is the published crate, unmodified, except:
     - `COOKIE_LENGTH`, `cookie_from_env` and `cookie_from(pulse_cookie, xdg_config_home, home)`, which return a 256-byte `Vec<u8>`;
     - `#![allow(unused_assignments)]`, for 12 assignments rustc 1.98 flags in the protocol files. The registry build hid them under `--cap-lints`; the protocol files stay as published;
     - `Client::from_env` sends that value.
   - `vendor/pulseaudio/BACKCHANNEL.md` records the published crate's sha256 and the diff. `PUBLISHED.sha256` holds every published file, and `vendor-is-the-published-crate.test.mjs` holds the tree to it.
2. **The fork is not a workspace member.** Its own tests, examples and ten dev-dependencies stay out of `Cargo.lock` and out of Stage 1.
   - The cookie tests live in the application crate, against `pulseaudio::cookie_from`. They need no sound server, and Stage 1's `cargo test --workspace` runs them. The wiring test, which reaches the real server with an empty `HOME`, is `#[ignore]`d and run by name in Stage 1.
   - `RUSTFLAGS="-D warnings"` reaches the fork, as it reaches any path dependency, and Stage 1's check entry holds it to compiling clean. Clippy lints only workspace members and does not reach it.
3. **Nothing reads or writes an environment variable for this.** The cookie never leaves the process except in the AUTH it is sent with, and no file is written anywhere.

## Why not the other two routes

- **`PULSE_COOKIE` pointing at a file the app writes.**
  - The variable would reach every child process. That includes WebKit's web process, which WebKitGTK spawns itself, and whose libpulse opens that path read-write with create.
  - #243 requires that it not reach children. Removing it after the host is built is not safe while threads run (`setenv` and `unsetenv` race `getenv`). It would also break the PulseAudio host's 10-second retry, which re-reads the variable.
- **Upstream** (colinmarc/pulseaudio-rs#20):
  - it writes a cookie to disk;
  - it ignores `XDG_CONFIG_HOME`;
  - it still sends a short existing file as is.

  That fails three parts of #243. When upstream ships a fix that meets #243, the fork is dropped.

## What this supersedes

- **The root `Cargo.toml`'s comment** "No `[patch.crates-io]` here on purpose" was about two git patches.
  - One pointed at a deleted fork.
  - The other would have swapped the audio backend for one no build had run.
- **Neither applies here.** This patch is a path in the repository, the same version the lock already pins, with one function changed. The comment is rewritten to say so.

## Consequences

- **The fork is pinned.** A cpal upgrade that needs `pulseaudio` 0.3.2 or later fails to resolve until the fork moves with it. That failure is loud, and it is the point: whoever upgrades rereads this ADR.
- **The fork carries the crate's MIT licence** beside its source, and `THIRD-PARTY-NOTICES.md` names it.
- **The gate's own launch could not see this defect.** On the development machine, GTK loads libcanberra, whose libpulse writes a cookie into the fresh home before the app builds its host. Stage 2 entry 5 therefore makes `$S2/home/.config/pulse` unwritable, and entry 11 asserts the PulseAudio host with no cookie anywhere (`scripts/stage2-pulse-host-check.sh`). A local build is now judged as a CI build would be.

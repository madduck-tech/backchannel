# This is a fork

`vendor/pulseaudio` is the `pulseaudio` crate 0.3.1 as published on crates.io, by Colin Marc, under the MIT licence in `LICENSE.md`. Backchannel patches it in at the workspace root (`Cargo.toml`, `[patch.crates-io]`). ADR 0033 records why, and #243 is the issue.

- **Source:** https://crates.io/api/v1/crates/pulseaudio/0.3.1/download. Its sha256, `d70623bd7967a9ca4c2ae0e807fc380b291f98480fc037042305ec643a4d3373`, is the checksum `Cargo.lock` pinned before the patch.
- **Extracted** with `tar -xzf … --strip-components=1`. Every file is kept, including the crate's own `Cargo.lock`, which its `.gitignore` would have hidden.
- **What changed, and nothing else:**
  - `src/lib.rs` gains `COOKIE_LENGTH`, `cookie_from_env` and `cookie_from`. The cookie is always 256 bytes: the first 256 bytes of the first readable file, in libpulse's order (`$PULSE_COOKIE`, then `$XDG_CONFIG_HOME/pulse/cookie` or `$HOME/.config/pulse/cookie`, then `$HOME/.pulse-cookie`), when that file holds as many, and zero bytes otherwise.
  - `src/lib.rs` also carries `#![allow(unused_assignments)]`. rustc 1.98 flags 12 assignments in the protocol files, which the registry build hid under `--cap-lints` and `-D warnings` reaches in a path dependency. The protocol files stay as published.
  - `src/client.rs`'s `Client::from_env` sends that cookie. The published crate sent the file it found as it was, and an empty cookie when it found none. PipeWire's pulse server refuses both.
  - This file, and `PUBLISHED.sha256`, the sha256 of every file in the published crate.
- **`frontend/src-tauri/tests` holds nothing for it.** The cookie tests live in `frontend/src-tauri/src/audio/devices/host.rs` (`mod pulse_cookie`), against `pulseaudio::cookie_from`. `vendor-is-the-published-crate.test.mjs` holds every other file to the published crate's sha256.

**Drop the fork** when upstream releases a client that meets #243 (colinmarc/pulseaudio-rs#20 does not yet), or when cpal moves off 0.3.1. That move fails to resolve while this patch pins the version.

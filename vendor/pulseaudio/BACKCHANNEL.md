# This is a fork

`vendor/pulseaudio` is the `pulseaudio` crate 0.3.1 as published on crates.io, by Colin Marc, under the MIT licence in `LICENSE.md`. Backchannel patches it in at the workspace root (`Cargo.toml`, `[patch.crates-io]`). ADR 0034 records why, and #243 is the issue.

- **Source:** https://crates.io/api/v1/crates/pulseaudio/0.3.1/download. Its sha256, `d70623bd7967a9ca4c2ae0e807fc380b291f98480fc037042305ec643a4d3373`, is the checksum `Cargo.lock` pinned before the patch.
- **Extracted** with `tar -xzf … --strip-components=1`. Every file is kept, including the crate's own `Cargo.lock`, which its `.gitignore` would have hidden.
- **What changed, and nothing else:**
  - `src/lib.rs` gains `COOKIE_LENGTH`, `cookie_from_env`, `cookie_from` and `read_regular`. The cookie is always 256 bytes: the first 256 bytes of the first regular file that can be read, in libpulse's order (`$PULSE_COOKIE`, then `$XDG_CONFIG_HOME/pulse/cookie` or `$HOME/.config/pulse/cookie`, then `$HOME/.pulse-cookie`), when that file holds as many, and zero bytes otherwise. A directory, a FIFO or `/dev/zero` is passed over, and at most 256 bytes are read.
  - `src/lib.rs` also puts `#[allow(unused_assignments)]` on `pub mod protocol;`. rustc 1.98 flags 12 assignments in `protocol/command/{playback,record}_stream.rs`, which the registry build hid under `--cap-lints` and `-D warnings` reaches in a path dependency. They are a real decode bug of the published crate: a decoded stream command loses `early_requests`, `passthrough` and `fail_on_suspend`. A client only encodes those commands, so nothing here is affected. The protocol files stay as published.
  - `src/client.rs`'s `Client::from_env` sends that cookie. The published crate sent the file it found as it was, and an empty cookie when it found none. PipeWire's pulse server refuses both.
  - This file, and `PUBLISHED.sha256`, the sha256 of every file in the published crate.
- **The two changed files are pinned** (`vendor-is-the-published-crate.test.mjs`): a change to either changes these, on purpose.
  - `src/lib.rs` `ff90c6f1dccb4b6a1410b39964cafc3f4a089e47baa7936ea14c6803df98da1c`
  - `src/client.rs` `9aefc30f927fa65b1977913c0c37cbc955abcab66b5d8047ffedec7ca87b3b4b`
- **`frontend/src-tauri/tests` holds nothing for it.** The cookie tests live in `frontend/src-tauri/src/audio/devices/host.rs` (`mod pulse_cookie`), against `pulseaudio::cookie_from`. `vendor-is-the-published-crate.test.mjs` holds every other file to the published crate's sha256.

**Drop the fork** when upstream releases a client that meets #243 (colinmarc/pulseaudio-rs#20 does not yet). If cpal moves off 0.3.1, cargo does not refuse: a compatible bump leaves the patch unused with a warning, and an incompatible one takes the registry crate silently. `vendor-is-the-published-crate.test.mjs` fails then, because `Cargo.lock` holds a `pulseaudio` that is not the fork.

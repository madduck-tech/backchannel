# 0034 — A control channel in the binary drives recordings for the experiment's verification

Date: 2026-10-29
Status: accepted. It applies on `exp/virtual-audio` only. It amends the virtual audio experiment plan's step 2, which said "No product code"; ADR 0033 records that plan's other decisions.

## Context

- **No person-free way to record on macOS.** On 2026-10-29 every run of #275's precondition check needed the product owner to press **Start recording** and **Stop** and to choose the backend in Settings. The agent only played the phrases and read the artifacts.
- **Neither UI driver this repository has runs on macOS.** `tauri-driver` has no WKWebView support; Tauri documents WebDriver for Linux and Windows (taken on trust from that documentation). `orca-ide` reads AT-SPI, which is Linux only.
- **Three criteria need many runs that a person cannot click through.** A3 is a 60-minute duplex run, A14 is at least 30 on-demand starts, and A5 is repeated latency measurements. Step 2's protocol freeze also needs every oracle shown red and then green.
- **A channel already exists.** `tauri-plugin-single-instance` 2.4.3 is registered (`lib.rs:405-416`). On macOS the running app listens on `/tmp/tech_madduck_backchannel_si.sock`. A second launch of the binary sends its `std::env::args()` there and exits 0 (`platform_impl/macos.rs:25-35, 60-71, 88`). Until now the callback only focused the window.
- **The product owner decided on 2026-10-29, in conversation:** the instrument lives in the application binary, with the plan amended and this ADR. The product owner chose it over a separate accessibility-API driver, which would have kept product code out of step 2 and covered the UI, but is slower and more fragile.

## Decision

1. **The control channel is the single-instance callback, nothing new.**
   - A forwarded `--control <command> --control-id <id> …` runs one of four commands: `start --mic <name> --system <name> [--meeting <name>]`, `stop`, `status` and `set-backend --backend <id>`.
   - Any other forwarded arguments keep today's behaviour.
   - A control request does not focus the window.
2. **It records only through the commands the buttons invoke.**
   - These are `crate::start_recording_with_devices_and_meeting` and `crate::stop_recording` (`lib.rs`), and `set_audio_backend`.
   - It reads `audio::recording_commands` only through `is_recording` and `get_meeting_folder_path`.
   - It builds no recording manager, pipeline or stream of its own.
   - A source census in `control.rs` holds all of this.
3. **The opt-in is the running app's own launch flag, `--control-enabled`.**
   - It is read once from that process's arguments. Forwarded arguments never enable it, and there is no environment variable.
   - Any process of the same user can write to the socket. The flag is therefore the whole boundary, and a launch without it refuses every control request.
4. **Results are one JSON line per command,** appended under a lock to `control-results.jsonl` in the app data directory and keyed by the caller's id.
   - Commands are spawned, never awaited on the socket's accept loop.
   - `status` reports a phase rather than `IS_RECORDING`, the backend, the devices the recording opened (read from the meeting's `metadata.json`), the executable and the revision it was built from.
5. **The revision is embedded at build time.**
   - `BACKCHANNEL_BUILT_FROM` is embedded by `scripts/macos-control.sh build`, which refuses a dirty tree.
   - The caller looks for that hash inside the executable that owns the socket before it sends anything. A file inside the bundle would break its signature.
   - Every build shares the socket, the main checkout's included, so this check is required.
6. **It is a verification instrument, not a product mode.**
   - Every verdict that uses it names what it does not exercise: every UI surface, the onboarding gate, the frontend's model check and title, and the meeting's database row. Only the frontend saves that row, so a meeting started through the control channel is missing from the meeting list.
   - Whether the channel survives into `main` is decided at the merge of `exp/virtual-audio`, not here.

## Consequences

- **More runs, less coverage.** Audio runs no longer need a person, and the UI is still covered by nothing on macOS. A pass that uses this channel is never cited for a UI claim.
- **A new local surface.** Any process of the same user can, with the opt-in on, start a recording through the socket. The opt-in is off unless the launch asks for it, and only `scripts/macos-control.sh launch` asks.
- **`set-backend` writes the real preferences.** A run records the backend first and restores it at the end.
- **TCC grants follow the ad-hoc signature.** Whether they survive a rebuild is measured by #281's test 8. If they do not, every run at a new revision needs a person to accept a prompt once.

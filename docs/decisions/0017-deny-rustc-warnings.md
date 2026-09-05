# ADR 0017: rustc warnings are denied, and the deny is held in place

Date: 2026-09-05

Status: accepted. Supersedes the clause in [ADR 0016](0016-quality-cycle-tests-and-red-first.md) that recorded "no lint runs in CI" as an
  accepted absence, for Rust only. The JavaScript half of that clause stands until #35 lands.

## Context

Dated facts, each with the command that produced it, measured on `f393ada`.

1. `.github/workflows/test.yml` is the only workflow with `on: pull_request`, and it has no branch
   filter. It runs `cargo test --workspace` on every pull request. rustc therefore reported warnings
   into the log of every pull request this repository has ever had, and nothing failed on any of them.

2. `cargo check --workspace --all-targets --message-format short 2>&1 | grep -E "^(frontend|llama-helper).*: warning:" | sort -u | wc -l`
   → **18**, exit 0. `--all-targets` is not optional: seven of the eighteen are inside `#[cfg(test)]`
   and invisible to a plain `cargo check`.

   That count is cache-state-dependent, and an earlier draft of #34 published **17** because of it —
   a run whose build script was not recompiled omits `build.rs`'s warning, and
   `cargo test --workspace --no-run` gives a *different* 17 because it replays `llama-helper`'s
   diagnostic in long form. State the cache state, or measure from a fresh target directory.

3. **The deny is not the check.** Before this change,
   `RUSTFLAGS="-D warnings" cargo check --workspace --all-targets` exited 101 having surfaced **2 of
   18**: `frontend/src-tauri/build.rs:58` (`unexpected_cfgs`) killed the build script, so
   `conversationaly` — where sixteen of the eighteen lived — was never checked at all. Which two
   surfaced varied with scheduling. The obvious remedy would have reported success at eliminating
   two warnings and left sixteen unreachable.

4. **Six of the sixteen were platform-conditional, and deleting them would have broken a platform
   this repository cannot build.** `fallback.rs`'s three "unused" imports are used only by
   `get_safe_recording_devices_macos`, which is `#[cfg(target_os = "macos")]`;
   `recording_preferences.rs:127`'s "needless" `mut` is needed by the macOS block below it;
   `hardware_detector.rs`'s "dead" `has_windows_vulkan_loader` is called from a
   `#[cfg(target_os = "windows")]` probe. `cargo fix` would have removed all of them. ADR 0005 says
   macOS and Windows are written blind here; a linter's suggestion is not exempt from that.

5. Two of the eighteen were not style. `system_audio_commands.rs:123` asserted
   `device_list.len() >= 0` — `>= 0` on a `usize`, true for every input forever — and the same test's
   `Err` arm printed and passed, so it could not fail on either branch. `decoder.rs` carried `#[test]`
   twice. ADR 0016 exists because a control that silently does nothing reads as a pass; rustc had been
   pointing at one on every pull request.

## Decision

1. **rustc's default lints are denied**, by a step of its own:
   `RUSTFLAGS="-D warnings" cargo check --workspace --all-targets`, in `test.yml` and in
   `gopnik.json` stage 1. A separate step because a lint failure and a test failure must not look the
   same in a log.

2. **`RUSTFLAGS` is set on that step, never at workflow or job `env:` level.** A later clippy step
   (#36) would otherwise inherit it and turn all 109 of its warnings into errors at once, which would
   make a staged adoption impossible.

3. **A warning is fixed, or allowed with a reason at the narrowest scope that works.** Three allows
   were added and all three are conditional on a platform or on `cfg(test)`; none silences a defect.
   `#[cfg_attr(not(target_os = "macos"), allow(unused_mut))]` is the shape: it says which platform the
   code is for, and it keeps the lint live everywhere else.

4. **The deny is held by a check that can go red on all six ways of neutering it** —
   `frontend/tests/lib/lint-step-is-enforced.test.mjs`: the step deleted; `continue-on-error` on the
   step; `continue-on-error` on the **job**; `if` at either level; `|| true` in the command;
   `pull_request` removed from `on:`. A substring check passes five of those six, which is why this
   one parses. The reader it parses with (`workflow-yaml.mjs`) is hand-rolled — there is no YAML
   parser in this repository and adding a dependency for four assertions is a permanent cost — and it
   is therefore itself under test (`workflow-yaml.test.mjs`). **A hand-rolled parser nobody tests is
   worse than the substring matching it replaces.**

5. **Accepted cost, named rather than hidden**: `dtolnay/rust-toolchain@stable` is unpinned and there
   is no `rust-toolchain.toml`, so a future rustc that adds or widens a default lint turns `main` red
   with no code change. `build.rs`'s `unexpected_cfgs` is a lint rustc turned on by itself, so the
   precedent is already in this tree. If it becomes a nuisance the answer is to pin the toolchain, not
   to delete the deny — a warning nobody is forced to read is a warning nobody reads, which is exactly
   what the eighteen were.

## Consequences

- 18 → 0. Both commands exit 0; the deny now reaches `conversationaly`, proven by introducing a
  warning there and watching it fail rather than by the exit code alone.
- `assert!(len() >= 0)` is gone, and so is the `Err` arm that passed. The mapping it was really about
  is a unit test with no hardware (`readable_names` in `audio/capture/system.rs`); the part that needs
  a machine is `#[ignore]`d and named in `gopnik.json` stage 1, which is a scope item, not a freebie —
  `ignored-tests-are-run.test.mjs` fails without it.
- A device whose name cannot be read is now **counted and logged** instead of silently vanishing from
  the picker. It was indistinguishable from a device the machine does not have, which is the shape
  of #10.
- `summary/templates/defaults.rs` held **three** hardcoded copies of the same two-entry registry with
  nothing checking they agreed; the dead function rustc reported was one of them. The other two now
  derive from it. Deleting the dead one, which is what the warning literally suggests, would have left
  the two that can still drift.
- `CLAUDE.md` claimed macOS enables "Metal + CoreML". `coreml` was dropped as a feature (see
  `frontend/src-tauri/Cargo.toml`), which is why `build.rs` was reporting `unexpected_cfgs` at all.
  Corrected in the same change.
- **Not bought**: JavaScript is still unlinted (#35), clippy is still unadopted (#36 — 111 findings
  across 52 files), and `cargo fmt` is not run. Naming them here so their absence stays a decision,
  which is the form ADR 0016 chose and this ADR keeps.

# ADR 0018: clippy is adopted, and every allow says what it would cost to fix

Date: 2026-09-05

Status: accepted. Completes the lint contour ADR 0017 opened: rustc (ADR 0017), eslint (#35), and
clippy here. ADR 0016's "no lint runs in CI" clause is now superseded in full.

## Context

Dated facts, each with the command that produced it.

1. `cargo clippy` had never run in this repository's CI, its gate, or any script anyone invokes.
   Not for lack of the tool: `clippy 0.1.96` is installed, and
   `.claude/skills/gopnik-setup/gopnik_setup.py:62` **offers** `("cargo clippy --quiet", None)` as a
   candidate Stage 1 check. It was offered and not taken.

2. The first run, measured on `079c832` (after ADR 0017's fixes) with
   `cargo clippy --workspace --all-targets --message-format json` counted by `code.code` and
   deduplicated by (code, file, line): **91 findings, 31 distinct lints, 44 files**, exit 0 with the
   two deny-by-default lints allowed.

   An earlier draft of #36 said 111 across 52 and called it "a lower bound that cannot be settled
   until #34 lands". Both were wrong: the difference was rustc's own lints, which clippy also
   reports and ADR 0017 had already fixed, and the complete distribution was obtainable the whole
   time with one flag pair. The by-lint-code distribution — which is what a policy decision actually
   needs — had genuinely never been produced, because `--message-format short` prints no lint names
   and grouping its text merges unrelated lints into junk buckets.

3. Of the 91, **46 were machine-applicable** (`cargo clippy --fix`), and the 269-test suite passed
   unchanged afterwards.

## Three findings that were not style

**`clippy::inherent_to_string_shadow_display` — `audio/capture/backend_config.rs`.** An inherent
`to_string()` shadowed the type's own `Display`, and the two returned **different strings on
purpose**: `"screencapturekit"` is the id written to `recording_preferences.json` and parsed back by
`from_string`; `"ScreenCaptureKit"` is the human label. While the shadow stood, a call site reading
`X.to_string()` could not be told by eye which of the two it got — and two call sites in
`recording_preferences.rs` were writing `id: X.to_string()`, correct **only** by the shadow. Renaming
the inherent method to `id()` made them silently wrong, which is how the defect became visible.
**No test covered those lines.** The lint found them; nothing else in this repository would have.

**`clippy::should_implement_trait` on the same type was one keystroke from a stack overflow.**
`impl Default for AudioCaptureBackend { fn default() -> Self { Self::default() } }` terminated only
because Rust prefers an inherent method to a trait one. The lint's own suggestion — rename the
inherent `default()` — would have turned that line into unbounded recursion, with nothing in the
type system to say so. The inherent method is now `for_platform()` and `Default` names what it calls.

**`clippy::await_holding_lock` — `audio/recording_commands.rs`.** A `std::sync::MutexGuard` on
`RECORDING_MANAGER` held across `.await`: any task that yields there blocks every other thread
touching the recording manager, and deadlocks outright if the awaited future needs the same lock.
It is **not reachable today** — the command is registered and invoked from the frontend zero times,
one of the dead commands #17's census counted, and its doc comment reads *"Useful for UI 'Retry'
button"*. That makes it worse to leave, not better: it is a trap that will be found by a feature
rather than by a test.

## One finding where the lint is wrong

`clippy::neg_cmp_op_on_partial_ord` — `audio/diarization.rs` guards with `if !(end_s > start_s)`.
Clippy suggests `end_s <= start_s`. For `NaN` the first is **true** (rejects it) and the second is
**false** (lets it through into the speaker-overlap arithmetic). Taking the suggestion would have
introduced a defect. Allowed with that reason written next to it.

This is the argument for why a clippy adoption is not a mechanical pass, in one line.

## Decision

1. **Clippy is denied**: `cargo clippy --workspace --all-targets -- -D warnings`, a step of its own
   in `.github/workflows/test.yml` and in `gopnik.json` stage 1.

2. **The policy lives in `[workspace.lints.clippy]` in the root `Cargo.toml`**, and members opt in
   with `[lints] workspace = true`. Not through `RUSTFLAGS`: that changes every unit's fingerprint,
   so a second flag set would recompile the whole dependency tree on every cache-cold CI run and
   could not share the existing `swatinem/rust-cache` key. This is also why ADR 0017 kept its
   `RUSTFLAGS` on one step rather than at job level — a clippy step would otherwise inherit it.

3. **Seven lints are allowed workspace-wide, and every allow says what fixing it would cost.** An
   adoption that allows more than it fixes is a decision and must read as one:

   | lint | n | why allowed |
   |---|---|---|
   | `ptr_arg` | 11 | changes signatures across eleven call graphs in the audio path |
   | `too_many_arguments` | 8 | needs parameter structs — a design change; four were already `#[allow]`ed individually |
   | `module_inception` | 7 | module renames and every path referencing them, for no behavioural gain |
   | `should_implement_trait` | 3 | the remaining three are naming; the fourth was the `Default` trap above and is fixed |
   | `type_complexity` | 2 | wants a type alias; cosmetic |
   | `enum_variant_names` | 1 | renaming changes `llama-helper`'s JSON-line protocol, which the app speaks |
   | `neg_cmp_op_on_partial_ord` | 1 | **the lint is wrong here** — see above |

   **32 allowed, 59 fixed.** Stated as a ratio because the alternative — allowing 91 and declaring
   victory — would produce an identical green check.

4. **The three lint steps are held by one check.** `lint-step-is-enforced.test.mjs` now covers rustc,
   eslint and clippy, and goes red on the step being deleted, `continue-on-error` or `if` at step or
   job level, `|| true` in the command, `pull_request` removed from `on:`, and `gopnik.json` stage 1
   dropping any of them.

## Consequences

- 91 → 0. `cargo clippy --workspace --all-targets -- -D warnings` exits 0, as does ADR 0017's rustc
  deny and `pnpm lint`. 269 Rust tests and 31 JS tests pass.
- Two new tests cover what the shadow was hiding: `the_stored_id_round_trips_and_is_not_the_display_label`
  and `every_backend_id_parses_back_to_its_backend`. Both go red when a call site takes `Display`
  instead of `id()` — the exact silent failure the rename exposed.
- `get_audio_backend_info`'s non-macOS branch hardcoded `"screencapturekit"` / `"ScreenCaptureKit"` —
  a **fourth** copy of strings the enum owns, on the only platform this repository runs. It now reads
  off the enum. Same disease as the three template registries ADR 0017 collapsed.
- **Accepted cost, the same one ADR 0017 named**: the toolchain is `@stable` and unpinned, so a
  clippy release that adds or widens a lint turns `main` red with no code change. Clippy moves faster
  than rustc here, so this is likelier than it was for ADR 0017. The remedy is unchanged: pin the
  toolchain, do not delete the deny.
- **Not bought**: `cargo fmt` and `prettier` are still not run — a formatter touches every file and
  is a different argument. The eleven eslint rules #35 switched off are still off (#38). The seven
  clippy lints above are still off, and turning one back on is a unit of work, not a chore.

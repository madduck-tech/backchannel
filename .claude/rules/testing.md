# Testing rules (always loaded)

Normative source: `docs/development-workflow.md` § The quality cycle. Decision: ADR 0016.

Every rule below exists because it was broken in this repository and the break was measured. Where a
rule is machine-enforced the enforcing check is named; where it rests on honesty it says so, because
mixing the two is how a rule becomes decoration.

## What ships with a change

*Every rule in this section rests on honesty: no tool reads a pull request body. They hold because the
critic and the gate are run, not because anything fails when they are broken.*

- **A change that executes ships with a test that fails without it.** Not "is covered" — a test
  demonstrated red on the unfixed code. A bug is **red-first**: write the failing test, paste its
  failure output in the pull request, then fix it. A feature ships with a negative control: break the
  behaviour deliberately, show the test going red, restore.
- **Show the control, do not assert it.** Paste the mutation and the output. Twice on 2026-09-04 a
  control silently did nothing and read as a pass — once because two string replacements cancelled
  out, once because `open(path, 'w')` truncated the file before throwing, so the test ran against an
  empty component. A control that does nothing is indistinguishable from a check that passes.
- **A call that returns success is not evidence it did anything.** Measured on 2026-09-04: with
  the application's window minimized, a W3C Element Click returns `{"value":null}` — the WebDriver
  success response — and the page does not change. The accessibility driver does the same on a
  settings tab: `ok: true`, nothing delivered. So assert the state after an interaction, never the
  interaction's own return value. Same class as a control that silently does nothing.
- **Mutate by line number or by an anchor you re-read.** Both silent controls above came from
  anchors that did not match what was in the file.
- **State the count of controls when a check has more than one condition.** Three checks with five
  conditions owe five controls; saying three lets two go quietly unmet.

## What a test must not be

- **A test nothing runs is not a test.** `#[ignore]` is legitimate for hardware, but every ignored
  test is either selected by name in `gopnik.json` stage 1 or listed with a reason in
  `frontend/tests/lib/ignored-tests-are-run.test.mjs`. *Machine-enforced by that test, both
  directions, including a stale excuse.* This has bitten twice: `cpal_capture_round_trip` "was
  written, ignored, and therefore did not catch #9", and both tests added by #13 were run by nothing
  until a critic compared the config against the source.
- **A test the runner's glob does not match is not a test.** `pnpm test` globs
  `tests/**/*.test.mjs`; anything else under `tests/` is a helper and must be named as one.
  *Machine-enforced by the same test.*
- **A test that passes with the code mutated is scaffolding.** When a test needs stubs, the control
  table is what separates it from a test of its own stubs. *Honesty-based — the two bullets above it
  are machine-enforced and this one is not, which is why it says so.*

## What a claim must carry

*Honesty-based, all of it. Nothing enforces any of the three.*

- **Verify against the artifact, not the intent to produce it.** After editing an issue, a file or a
  config, re-read the published thing and check. On 2026-09-04 two of six edits reported as applied
  were absent, and one was absent again on the retry. Honesty-based; nothing enforces it.
- **Every number carries the operation that produced it.** "37 of 161 commands" is reproducible;
  "four dead paths" was wrong by an order of magnitude. A count whose matching rule is unstated is not
  a measurement — whole-identifier matching gives 37 where substring matching gives 35.
- **Mark what nobody held.** A verdict names what was measured, what was read from source, and what
  was taken on trust. "Read from source, never run" is an acceptable state; presenting it as measured
  is not.

## Coverage this repository does not have, and does not pretend to

Named here so their absence is a decision rather than a silence:

- **Rust warnings are denied in CI as of ADR 0017** (`RUSTFLAGS="-D warnings" cargo check --workspace
  --all-targets`, a step of its own in `test.yml` and in `gopnik.json` stage 1). So an unused import
  in Rust is caught. **JavaScript is linted as of #35** (`pnpm lint`, `eslint src --max-warnings=0`)
  — but eleven rules the tree violates are switched off with their counts and reasons, and
  `no-unused-vars` is one of them, so an unused TypeScript import is *still* a way a reachability
  check can be turned green without fixing anything. That is #38, one rule per pull request.
- `--max-warnings=0` is not optional for eslint. It exits 0 on warnings, so a rule set to `warn`
  reports and passes — the same reported-and-ignored shape the rustc deny was raised to fix.
- `-D warnings` reaches a crate only if everything before it compiles. `build.rs`'s `unexpected_cfgs`
  made the deny report 2 of 18 for as long as it existed, and the sixteen it never reached were
  invisible to the very command meant to surface them. When adding a deny, prove it reaches the code
  by introducing a warning there and watching it fail — a deny that exits non-zero for some other
  reason looks exactly like one that works.
- Stage 2's **accessibility-tree** driver reaches only top-level push buttons; a `page tab` exposes no
  action to it. Not a limit of the application: a `tauri-driver` WebDriver session drives the settings
  tabs and the device pickers against the bundled AppImage in about ten seconds (measured 2026-09-04).
  Putting that in the gate is #20; until it lands, anything behind a tab is undriven **by the gate**.
- macOS and Windows are verified by CI builds only (ADR 0005). A verdict names them as not proven and
  never implies them.

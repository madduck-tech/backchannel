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

## What a check must reach (ADR 0022)

*Measured on 2026-09-08: every mechanism in this repository was working, and each was pointed
somewhere other than the change. Stage 1 was 57 of 57, Stage 2 runtime 7 of 7, and the product owner
found six defects by hand in the flow that had just merged.*

- **A denominator must reach the code a change touches.** `src/contexts/` sat outside
  `COMPONENT_ROOTS` -- seven providers, rendered by zero tests, unable to enter a backlog or go red --
  and the defect lived in one of them. Extending the rule is part of the fix, not a follow-up.
  *Machine-enforced by `no-invisible-component.test.mjs` under set equality.*
- **A check may not be pointed at the change by the change.** `gopnik.json:30` asserted a heading and
  a button that `009b37d` had deleted, and `bfa8d3a` rewrote the assertion to what it had just
  written. If a commit edits a gate assertion guarding behaviour it also edits, the verdict says so
  and states what the assertion said before. *Honesty-based.*
- **A pass that seeds away the screens under test proves nothing about them.** Both UI-driving passes
  seed `onboarding-status.json`, for cost, which is legitimate -- and so neither could see first run.
  Every pass that seeds states which surfaces it therefore cannot observe.
  `scripts/stage2-onboarding-check.sh` is the one that cannot skip first run.
- **A check must not accept the default when the defect is a hardcoded default.** The download named
  `DEFAULT_TRANSCRIBE_MODEL` directly, so any check taking the default asserted the single value the
  broken path got right by accident.
- **A requirement given in conversation is not a requirement until it is in the repository.** "Remove
  the sort control" stayed in chat; the controls moved behind a button and
  `onboarding-choices.test.mjs:118-119` now asserts that button must exist. An unrecorded requirement
  cannot be checked and can be inverted into an assertion enforcing what was rejected. *Honesty-based.*
- **A screen without a committed, approved prototype is not implemented.** Prototypes live in
  `design/prototypes/`, not a session directory. #111 shipped four onboarding screens and the
  repository can produce an approval for none. *Honesty-based; stop and ask.*

## What a pass must vary (#157)

*Honesty-based, and it is the rule the machine-enforced ones cannot reach: a pass that drives the
real flow, end to end, against the real artifact, and takes the default value of every input it
offers.*

- **A pass that only ever takes defaults covers one path, and the verdict says so.** Measured
  2026-09-10: `stage2-onboarding-check.sh` had two modes and both left the summariser on
  `builtin-ai`. For eight days it walked first run with the one provider whose behaviour was correct,
  while choosing any of the other five downloaded 2709.8 MB of a local model nobody would use. One
  other value of one input was all it needed.
- **Name the inputs the pass leaves alone.** Not "this pass covers onboarding" but "this pass covers
  onboarding with the default summariser, the default window and no seeded models". A reader can then
  see the hole; "covers onboarding" hides it.
- **An absence is not a result without a positive sentinel from the same run.** `remote` mode asserts
  `models/summary` stays empty, which is indistinguishable from a run that never started — so the
  transcription model arriving in that same run is what makes the emptiness mean something. The first
  version of that oracle reported 469 372 646 bytes "fetched" that were the seed itself.

## What an instruction becomes (ADR 0023)

*Honesty-based. Nothing parses an issue, and the rule exists because the machine-enforced ones did
not reach this.*

- **An instruction that removes, hides or forbids something ships with a test that fails while the
  thing is present.** Not a test that the replacement exists -- those are different assertions, and
  only one of them can be satisfied by moving the thing somewhere else. Measured 2026-09-08: the
  instruction was to remove the model catalogue's sort and filter controls; they were moved behind a
  button, `Sort by` is still live at `TranscriptionModelManager.tsx:342`, and
  `onboarding-choices.test.mjs` then **required that button**.
- **A test may not assert an arrangement the product owner rejected.** When an instruction and an
  existing assertion conflict, the assertion is wrong by definition and is deleted in the same change
  that records the instruction -- even where the implementation cannot follow yet.
- **The assertion is owed when the instruction is recorded, not when the design lands.** Where the
  implementation is blocked -- on an approved prototype, say -- the issue names the assertion as owed.
  An instruction with neither an assertion nor a written debt is one nobody is holding.

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

- **Rust is linted in CI as of ADR 0017 (rustc) and ADR 0018 (clippy)** (`RUSTFLAGS="-D warnings" cargo check --workspace
  --all-targets` and `cargo clippy --workspace --all-targets -- -D warnings`, each a step of its own
  in `test.yml` and in `gopnik.json` stage 1). So an unused import
  in Rust is caught. **JavaScript is linted as of #35** (`pnpm lint`, `eslint src --max-warnings=0`)
  — but eleven rules the tree violates are switched off with their counts and reasons, and
  `no-unused-vars` is one of them, so an unused TypeScript import is *still* a way a reachability
  check can be turned green without fixing anything. That is #38, one rule per pull request.
- **A lint's suggestion is not exempt from judgement.** ADR 0018 records one clippy lint that was
  wrong (`neg_cmp_op_on_partial_ord` on a NaN guard — the suggested rewrite lets NaN through) and one
  whose suggested rename would have produced unbounded recursion. ADR 0017 records six rustc warnings
  whose obvious fix would have deleted macOS and Windows code paths. Read what the fix does, not what
  the tool proposes.
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

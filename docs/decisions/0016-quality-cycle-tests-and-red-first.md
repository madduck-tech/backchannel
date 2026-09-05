# ADR 0016: The quality cycle — a change ships with the test that would have caught it

Date: 2026-09-04
Status: accepted (extends ADR 0013's cycle; supersedes nothing). Its "no lint runs in CI" clause is superseded **for Rust** by [ADR 0017](0017-deny-rustc-warnings.md) on 2026-09-05; the JavaScript half of that clause stands until #35. The body below is left as written.

## Context

ADR 0013 gave every change a cycle: issue → critic → implementation → gopnik gate → pull request. The
gate asks whether the work does what is claimed. Nothing in it asked whether a **future** change would
be caught, and the day of 2026-09-04 measured what that costs.

Facts from that day, each reproducible:

- **37 of 161 registered Tauri commands** are invoked from nowhere in the frontend, matching each
  name against `invoke` string literals under `frontend/src`, and **14 components** are unreachable by
  import from any Next entry file — the figure `component-reachability.test.mjs` prints. It is 20 if
  the six vendored `src/components/ui/**` files that check excludes by rule are counted; both numbers
  are true of different questions, which is why the rule is stated beside them. None of it failed
  anything.
- **`builtin_ai_get_models_directory`** was invoked from the frontend and existed nowhere in the
  repository — a call that would reject at runtime. Fixed the same day in `06cd668`; recorded here in
  the past tense because it is evidence, not an open defect. It was found by inverting a check that had until then run
  in one direction only.
- **Four mutations of the device picker** — stripping a suffix inside one handler, swapping the two
  handlers, swapping the two device arrays, merging them — passed `node --test`, `tsc --noEmit` and
  every reachability check. One of them is invisible to a person as well: the option label is the
  device name while the value carries the suffix.
- **Two tests added the same day were run by no gate command**, and `gopnik.json`'s own note already
  recorded the first occurrence of that: `cpal_capture_round_trip` "was written, ignored, and
  therefore did not catch #9".
- **Two negative controls silently did nothing and read as passes** — one because two string
  replacements cancelled out, one because `open(path, 'w')` truncated the file before throwing, so the
  test ran against an empty component.
- **Two of six edits reported as applied were absent from the published artifact**, and one was absent
  again on the retry, caught only by grepping the published text rather than trusting the intent.

Every one of these was found by an adversary, not by a rule. The rules that would have forbidden them
were loaded and known.

## Decision

1. **A change that executes ships with a test that fails without it.** Not "is covered": a test
   demonstrated red on the code as it was. A bug is **red-first** — the failing test, its output
   pasted, then the fix. A feature ships with a negative control: break the behaviour, show red,
   restore.
2. **The control is shown, not asserted.** The mutation and the failure output go in the pull request.
   A control that does nothing is indistinguishable from a check that passes, and both known instances
   came from an anchor that did not match the file — so mutate by line number, or re-read the anchor.
3. **When a check has several conditions, the number of controls is stated.** Three checks with five
   conditions owe five controls.
4. **A test nothing runs is not a test**, and this is machine-enforced rather than asked for.
   `frontend/tests/lib/ignored-tests-are-run.test.mjs` fails when an `#[ignore]`d Rust test is neither
   selected by name in `gopnik.json` stage 1 nor excused with a reason, when an excuse goes stale, and
   when a file under `tests/` would not match the runner's glob.
5. **Reachability is machine-enforced in both directions.** `command-reachability`, `modal-reachability`
   and `component-reachability` (#17) — those three, not every check in the suite — hold their
   allowlists under **set equality**, so wiring a thing up, deleting it, or adding a new unreached one
   all force an edit. Matching is on `invoke` string literals rather than bare identifiers, which
   narrows the ways a name can be counted as used. It does **not** immunise them: a commented-out
   `invoke('name')` still moves the set, the check goes STALE, and the cheapest way to resolve that is
   to delete the allowlist entry and its reason. Comments are not stripped. That is a known hole, and
   closing it needs a lint step this repository does not have.
6. **Claims are verified against the artifact, not the intent.** After editing an issue, a file or a
   config, re-read the published thing. This one rests on honesty; nothing enforces it.
7. **Every number carries the operation that produced it**, including its matching rule. Whole-identifier
   matching gives 37 where substring matching gives 35, and a count whose rule is unstated is not a
   measurement.
8. **A verdict marks what nobody held.** Measured, read-from-source, and taken-on-trust are three
   different states. "Read from source, never run" is acceptable; presenting it as measured is not.

## Consequences

- The gate gains a required element: the control table. Nothing mechanically refuses a verdict
  without one — no tool parses a verdict — so this rests on the same honesty as decisions 1 to 3 and 6
  to 8, and it is recorded in `gopnik.json` because that is the file the gate is configured from.
- **This ADR adds one automatic check**: a test the gate does not run, or a file the runner's glob
  would skip. The other three classes — an unreferenced command, an unreachable component or modal,
  and a device picker that mishandles what it is given — began failing when #17 and #19 merged earlier
  the same day, not here. The table in `docs/development-workflow.md` lists all of them together
  because a reader needs the whole set, not because this change created them.
- Cost: every executable change is slower by the time it takes to break the thing on purpose and paste
  the output. That is the accepted price, and it is the same trade ADR 0013 already made for the gate.
- What this does **not** buy, named so the absence is a decision: no lint runs in CI, so an unused
  import can still turn a reachability check green; the gate's accessibility-tree driver reaches only
  top-level buttons, so anything behind a settings tab is undriven **by the gate** — a WebDriver
  session reaches it in about ten seconds, and putting that in the gate is #20; and the class *"a
  backend fabricates a value a correct component renders"* is owned by no issue and caught by
  nothing.
- The mechanical half of this ADR is worth more than the honest half, and the honest half is worth
  writing down anyway: on the day above, the rules that were loaded and known caught none of the six
  failures, and an adversary caught all of them.

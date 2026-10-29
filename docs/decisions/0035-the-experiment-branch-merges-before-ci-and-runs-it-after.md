# 0035 — The experiment branch merges on the local gate and runs CI after the merge

Date: 2026-10-29
Status: accepted. Amends, for pull requests into `exp/virtual-audio` only, decision 3 of
[ADR 0033](0033-the-virtual-audio-experiment-is-built-on-macos.md) and the "merged once CI is green"
step of `CONTRIBUTING.md`. Nothing changes for `main`. The pull request that merges
`exp/virtual-audio` into `main` (ADR 0033 decision 4) is excluded and follows the normal cycle. Like ADR 0034, it is committed on `exp/virtual-audio` only and
reaches `main` only with that merge, as a record of how the branch was built.

## Context

- **CI runs only on `pull_request` and `workflow_dispatch`.** This is true of `test.yml` and
  `stage2-artifact.yml`, read from source on 2026-10-29. A push to `exp/virtual-audio` runs nothing.
- **Waiting for CI is the slowest step of a work item on the experiment branch.** PR #288 (#281),
  measured on 2026-10-29:
  - Frontend and Rust suites: 33 min 23 s.
  - Windows compiles: 36 min 40 s.
  - macOS compiles: 22 min 25 s.
  - AppImage for Stage 2: 20 min 12 s.
- **None of these jobs runs the experiment's code.** Its runtime verification happens on the
  development Mac: local Stage 1 and the macOS instrument (ADR 0033 decisions 1 and 5, ADR 0034). CI
  adds only the compile on Windows, the compile on macOS and the Linux suites.
- **CI has caught a real defect on this branch.** On #275, `Windows compiles` failed: a source census
  found no `"\n}\n"` in a file checked out with CRLF line endings. Nothing local reproduced it until it
  was replayed by converting the file to CRLF. So deferring CI defers a class of findings; it does
  not remove the class.
- **The product owner decided on 2026-10-29, in conversation:** shorten the cycle by running CI late,
  **for development inside `exp/virtual-audio` only**. After the experiment is merged into `main`, the
  process is the one the ADRs describe.

## Decision

1. **A pull request into `exp/virtual-audio` is merged on a `READY` verdict without waiting for CI.**
   Every other step of the cycle stays:
   - the issue, and the critic on it;
   - the Stage 0 matrix;
   - local Stage 1 on the development Mac;
   - the macOS instrument;
   - the `gopnik` verdict on the issue, with `Refs #N`;
   - the issue closed by hand.

   The verdict says that CI had not run when it was written. It does not imply that Linux or Windows
   compiles.
2. **After each such merge, engineering runs CI on `exp/virtual-audio` by `workflow_dispatch`:**
   `test.yml`, plus `stage2-artifact.yml` when the merge touched what the AppImage builds.
   - The run's result is posted to the work item's issue.
   - A red run **blocks the next merge into `exp/virtual-audio`** until a fix through the same cycle
     makes it green.
   - So a defect that only CI sees is found at most one work item late.
3. **A run that cannot start does not count as green.** A runner that is not acquired, or a dispatch
   that fails, is recorded as not run, and the next merge waits for a run that completes.
4. **The merge into `main` is unchanged.** The pull request from `exp/virtual-audio` into `main` waits
   for CI like any other pull request into `main`. Its verdict reruns everything on the merge result,
   as ADR 0033 already requires. This ADR's exception ends with that merge.

## Consequences

- **A work item takes roughly 35 minutes less wall-clock time,** and engineering no longer polls CI
  before merging.
- **The experiment branch can be red between two merges.** Anyone who branches from it in that window
  starts from a revision CI has not passed. Decision 2's blocking rule bounds this to one work item.
- **A CI-only defect is fixed by a separate pull request** rather than before the merge that
  introduced it. The history shows the break and the fix as two changes.
- **The Linux suites still run on every work item,** after the merge instead of before it. The Linux
  Stage 2 gap the product owner accepted on 2026-10-28 (plan, "Linux Stage 2") is unchanged.

# 0022 — A check that skips the change is not evidence

Date: 2026-09-08
Status: accepted

## Context

On 2026-09-08 the product owner walked first-run onboarding and found six defects in a flow merged
that morning (#111, PR #129). The gate had passed it: Stage 1 green (57 of 57 JS, 313 Rust, three
linters), Stage 2 runtime 7 of 7, Stage 2 audio 4 of 4.

An adversarial review of the first diagnosis (#130, verdict in that issue) overturned it and
established the following, each re-run independently before acceptance:

1. **The load-bearing defect lived outside the coverage denominator.**
   `COMPONENT_ROOTS` was `['src/components/', 'src/app/_components/']`, so all seven files in
   `src/contexts/` — 665 lines and 9 `invoke()` calls in `OnboardingContext.tsx` alone — were
   rendered by zero tests and could not enter a backlog, be named unreachable, or go red.

2. **The tests written for the change agreed with the defect.** `onboarding-choices.test.mjs`
   section 5, titled *"both answers travel to complete_onboarding"*, is a regex over the source text
   of the file the bug is in. It passes and will keep passing, because the choice does reach
   `complete_onboarding` — forty lines below the `invoke` that ignored it. And
   `first-run-step.test.mjs:65` stubs `startBackgroundDownloads`, the function holding the defect,
   with `async () => {}`.

3. **A requirement that stayed in conversation became its opposite in a test.** The instruction was
   to remove the catalogue's sort and filter controls. They were moved behind a button, and
   `onboarding-choices.test.mjs:118-119` now asserts that button **must exist**. The requirement was
   recorded nowhere in the repository, so nothing could be checked against it.

4. **A gate assertion was live and false for two commits, then rewritten by the change it guarded.**
   At `009b37d`, `gopnik.json:30` asserted `'heading Welcome to'` and `'push button Get Started'`,
   both deleted by that same commit, which did not touch `gopnik.json`. `bfa8d3a` rewrote the
   assertion to the new screen's strings. Whether it went red and was ignored or Stage 2 was not run
   is undetermined; no gate log for `009b37d` exists.

5. **Both UI-driving passes require first run to be skipped.** `stage2-record-check.sh:85` and
   `stage2-ui-check.sh:89-90` seed `onboarding-status.json`. The reason is cost — 4.3 GB otherwise —
   and is stated in the scripts.

6. **No onboarding prototype is committed.** `design/prototypes/` holds 112, 114, 118 and
   overlay-hint. Three prototype passes covering the transcription, summariser and download screens
   existed in a session scratchpad and were never committed, so no approval is recoverable.

The common shape: every mechanism was working, and each was pointed somewhere other than the change.
The verdict then reported the green numbers, all of them true, none of them about the screens that
had been rewritten.

ADR 0016 already requires a test shown red. It does not require that the test, or the gate, reach the
thing that changed.

## Decision

1. **A denominator must reach the code a change touches.** `src/contexts/` joins `COMPONENT_ROOTS`.
   More generally: when a defect is found in a directory no coverage rule names, extending the rule is
   part of the fix, not a follow-up.

2. **A check may not be pointed at the change by the change.** If a commit edits a gate assertion that
   guards behaviour it also edits, the verdict says so explicitly and states what the assertion said
   before. Silently re-aiming a check at what was just written is not verification.

3. **A pass that seeds away the screens under test proves nothing about them.** Seeding for cost stays
   legitimate, and every pass that does it states which surfaces it therefore cannot observe.
   `scripts/stage2-onboarding-check.sh` exists so first run has one pass that cannot skip it, and it
   chooses a **non-default** option, because a check that accepts the default asserts the one value a
   hardcoded path gets right by accident.

4. **A requirement given in conversation is not a requirement until it is in the repository.** Product
   instructions that change behaviour are written into the issue before implementation. An
   unrecorded requirement cannot be checked, and — measured here — can be inverted into an assertion
   that enforces what was rejected.

5. **A screen without a committed, approved prototype is not implemented.** Prototypes live in
   `design/prototypes/`, not in a session directory. If there is no committed prototype for a screen a
   change would add or rewrite, that is a stop-and-ask, not an implementation detail.

6. **A verdict names what nobody held, and whether the checks it cites touched the change.** The #111
   verdict did carry a "What nobody held" section and named the geometry gap — and the change was
   merged anyway. So the requirement is extended: a verdict that cites a green pass states whether
   that pass reached the changed surfaces, and a gap that is named is a gap that blocks until the
   product owner or an issue accepts it.

Decisions 1-3 are machine-enforced: by `no-invisible-component.test.mjs` under set equality, by the
new pass being in `gopnik.json`, and by `gate-click-failure-is-a-failure.test.mjs`. Decisions 4-6 rest
on honesty, and are marked so here because `.claude/rules/testing.md` is right that mixing the two is
how a rule becomes decoration. Every rule broken on 2026-09-07 and 2026-09-08 was an honesty-based
one.

## Consequences

- The component denominator went from 79 to 86. Six providers arrive without a test and are held in
  `CONTEXTS_ADMITTED`, closed the way `BACKLOG` is. `FLOOR` moved from 11 to the measured 20, which
  had eight components of slack it could have lost in silence.
- Stage 2 gains a pass that downloads a 34 MB model on every run. That is the price of having any
  check enter first run at all, and it was chosen over a 4.3 GB one.
- Design work slows at the point where a screen has no committed prototype. That is the intended
  effect: #111 shipped four onboarding screens and the repository can produce an approval for none.
- Decision 6 will block merges that today would pass. The #111 verdict is the worked example: it
  named the gap correctly and shipped, and the product owner found the consequence by hand.

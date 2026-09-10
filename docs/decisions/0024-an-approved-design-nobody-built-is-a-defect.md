# 0024 — An approved design nobody built is a defect, and "out of scope" is an issue or it is nothing

Date: 2026-09-10
Status: accepted

## Context

Between 2026-09-08 and 2026-09-10 the product owner walked first run by hand three times and found
ten defects. Every one was found while the harness was green, and the harness is not small: 57 checks
in stage 1, seven UI-driving passes in stage 2, five reachability censuses. #157 enumerates the ten
and asks which measure would have caught which.

Two of the ten are not harness gaps at all. They are what this ADR is about.

**A committed, approved prototype that nothing implements is invisible.** ADR 0022 decision 5 says a
screen without a committed prototype is not implemented. The inverse had no rule. So
`onboarding-download.html` and `onboarding-summariser.html` sat in `main` from 2026-09-08 with
baselines beside them, compared only against captures of themselves, while the screens they describe
stayed as they were inherited from the fork. `prototypes-match-their-baseline.test.mjs` was green
throughout, correctly: it compares a prototype to itself.

**And "out of scope" produced nothing.** #138 excluded both, in its own body, with reasons a critic
accepted — the summariser's shell touches `OnboardingContainer`, which five steps import; the
download screen's design is a redesign rather than a repair. Both exclusions were right about scope.
**Neither produced an issue.** The work existed nowhere for three weeks, and engineering reported
"four of the six defects fixed" without saying that two of the four were repairs inside screens whose
approved design was never built. The issue that named the gap, #154, was filed on 2026-09-10, after
the product owner asked where the design had gone.

The two failures compound: the first makes an unbuilt design invisible to the machine, the second
makes it invisible to the tracker.

## Decision

1. **A prototype in `design/prototypes/` is a claim that the screen it describes exists.** Every
   committed prototype names, in its own file, the implementation it is the design for — or records
   that it is not implemented yet and the issue that will implement it. A prototype naming neither is
   red.

2. **An approved design and its implementation are compared, not each one against itself.** How is
   left to the check that does it; what is not: `prototypes-match-their-baseline.test.mjs` comparing
   a prototype to a capture of itself is not evidence about any screen, and a verdict may not cite it
   as such.

3. **"Out of scope" produces an issue in the same action, or the scope did not change — the work was
   dropped.** An exclusion in an issue body, a verdict, or a pull request carries the number of the
   issue that holds what was excluded. Writing the exclusion and not the issue is how three weeks
   passed.

4. **A report names what was not done as plainly as what was.** "Four of six defects fixed" was true
   and misleading in the same sentence. Where a fix lands inside something that is itself unfinished,
   the report says so.

5. **The ten defects of #157 are this ADR's evidence and its test.** A measure proposed here is
   judged by how many of the ten it would have caught, published as a table, with the prediction
   recorded before the measurement.

## Consequences

- A prototype can no longer be committed and forgotten: it either points at an implementation or at
  the issue that owes one.
- Decisions 3 and 4 are honesty-based and say so. Nothing parses a pull request body. They exist
  because the machine-enforced rules did not reach this and the same failure happened twice —
  ADR 0023 records the first, where an instruction produced no assertion; this is the second, where
  an exclusion produced no issue.
- Decision 2 does not prescribe a mechanism, deliberately. #138 rejected the obvious one — adding
  implementations to the prototype baseline comparison — because that comparison is index-keyed over
  one document and the screens have neither the node count nor the order nor the text, and because
  capturing a React screen as its own target pins a guess and calls it the approved design.
- The cost of decision 1 is a line in seven files today and one per prototype after.

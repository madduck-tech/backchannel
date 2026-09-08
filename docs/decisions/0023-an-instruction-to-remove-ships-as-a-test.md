# 0023 — An instruction to remove something ships as a test that fails while it is there

Date: 2026-09-08
Status: accepted
Supersedes part of: ADR 0022 decision 4

## Context

ADR 0022 decision 4 requires a product instruction to be written into the repository before
implementation. It does **not** require it to become an assertion, and the difference is not academic
— it is what happened on 2026-09-08.

The instruction was to remove the model catalogue's sort and filter controls. They were moved behind
a button instead. Measured on `ceb57a1`:

```
$ sed -n '118,119p' frontend/tests/lib/onboarding-choices.test.mjs
  const all = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('86'));
  assert.ok(all, 'but it must be one button away, for the person who came looking for one model');

$ grep -n "Sort by" frontend/src/components/TranscriptionModelManager.tsx
342:          <span className="text-sm text-ink-muted">Sort by</span>
```

So the controls are still live, and a test now **requires the button that hides them**. Recording the
requirement would not have stopped this. The test was written by the same person who chose the
arrangement, and it agreed with them.

This is the third instance of one shape. #130 recorded the other two: a test that regexes the source
of the file the defect is in, and four tests that stub the function the defect is in. Each was written
after the code, by its author, and each agreed.

## Decision

1. **An instruction that removes, hides, or forbids something ships with a test that fails while the
   thing is present.** Not a test that the replacement exists — a test that the removed thing is
   gone. The two are different assertions and only one of them can be satisfied by moving the thing.

2. **A test may not assert an arrangement the product owner rejected.** When an instruction and an
   existing assertion conflict, the assertion is wrong by definition and is deleted in the same change
   that records the instruction — even when the implementation cannot follow yet.

3. **The assertion is owed at the moment the instruction is recorded, not when the design lands.**
   Where the implementation is blocked — on an approved prototype, say — the issue names the assertion
   as owed. An instruction with neither an assertion nor a written debt is an instruction nobody is
   holding.

Decisions 1 and 3 rest on honesty; nothing parses an issue. Decision 2 is enforced only to the extent
that someone reads the diff. Said plainly, because ADR 0022 is about a repository whose honesty-based
rules failed while its machine-enforced ones held, and adding three more honest ones without saying so
would be the same mistake one level up.

## Consequences

- `onboarding-choices.test.mjs:118-119` is deleted under decision 2. Its replacement — the catalogue
  has no sort control — is red on `ceb57a1` and cannot land until the catalogue is redesigned, which
  needs an approved prototype under ADR 0022 decision 5. The debt is recorded in #132.
- Product instructions given in conversation must reach an issue before they can be asserted, which is
  ADR 0022 decision 4 and unchanged. This ADR adds what happens next.
- A change that removes a feature now costs one more test than it did. That is the point: the removal
  is the requirement, and the requirement is what nobody was holding.

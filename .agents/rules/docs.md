---
paths:
  - "docs/**"
  - "*.md"
---
# Documentation rules

- English only. Sentence case headings. No marketing adjectives.
- ADRs: `docs/decisions/NNNN-slug.md` with Date, Status, Context (dated facts), Decision (numbered),
  Consequences. Add the row to `docs/decisions/README.md`. Supersede, never rewrite, an accepted ADR.
- Milestone reports live in `docs/milestones/<name>.md` and list criteria, p50/p95 numbers, the
  hardware and models used, and everything skipped or failed.
- `docs/development-workflow.md` changes only through a superseding ADR.
- The product spec is not in the repository; do not cite it by section number in user-facing docs,
  cite the ADR that captured the point.

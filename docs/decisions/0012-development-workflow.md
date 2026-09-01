# ADR 0012: Development workflow

Date: 2026-09-01
Status: accepted

## Context

The project is built by one maintainer with Claude Code as the primary implementer, in the open.
Decisions were being made one at a time in chat; the design tool (ADR 0011) added a second loop;
the inherited `CONTRIBUTING.md` still described upstream's `main`/`devtest` branching and a CI
check that only validates the version string. The cycles needed to be written down once so
that every session, every contributor and every agent runs the same way.

## Decision

`docs/development-workflow.md` is the normative description of how the project is built. It
defines five cycles — Decide (ADRs), Design (UI/UX through OpenDesign with an approval gate),
Build (branches, PRs, commits, tests), Verify (milestones close on measured numbers), Ship
(releases after Milestone 0) — plus the approval gates at which an agent must stop, a definition
of done, and the agent session checklist.

Key rules fixed by this ADR:

1. `main` is the only long-lived branch; upstream's `devtest` convention is retired.
2. Docs, ADRs, design-system files and approved prototypes may go straight to `main`; code goes
   through a pull request that the maintainer merges.
3. No prototype and no design-system change is committed before the maintainer has seen it.
4. A design-system change touches `DESIGN.md`, `tokens.css` and `globals.css` in one commit.
5. A milestone closes only on p50/p95 numbers measured on the emulated minimum machine.
6. `CLAUDE.md` carries a "read this first" section pointing to the workflow and the ADR index,
   so the rules apply to every agent session.

Changes to the workflow go through a superseding ADR.

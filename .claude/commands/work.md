---
description: Work an issue through the full cycle — matrix, work, critic, gate, verdict.
argument-hint: <issue number>
arguments: [issue]
allowed-tools: Bash(gh issue view:*), Bash(gh issue comment:*), Bash(gh issue close:*), Bash(gh pr create:*), Read, Agent
---

Take issue **$issue** through the cycle in `.claude/skills/gopnik/SKILL.md` and
`docs/development-workflow.md`.
Read that skill before starting; what follows is the order of operations, not a
replacement for it.

1. **Read the issue.** `gh issue view $issue --comments`. If it has no answer to
   *what would settle it*, stop and say so: the work has no oracle, and Stage 2
   would have nothing to aim at. Ask for one rather than inventing it. If it has
   no `ready` label, the critic has not accepted it: run `/critique $issue` first
   and stop.

2. **Post the Stage 0 matrix as a comment, before touching anything.** Axes and
   their cartesian product, coverage marked per cell, mixed cells called out
   explicitly. Posting it first is what makes the tell checkable — if someone
   adds cases to the issue after your matrix, you skipped the step.

3. **If the issue carries the `ui` label, stop for design.** Prototype two or
   three variants in OpenDesign against the `backchannel` design system
   (`start_run` with `project: "backchannel-prototypes"`), send screenshots, and
   wait for the maintainer to pick one. Link the pick in the issue and commit the
   approved HTML to `design/prototypes/`. No implementation before the pick.
4. **Do the work** on a branch from `main`.

5. **Run the critic if the work produced a claim** — a diagnosis, an explanation
   of a mechanism, a statement about the codebase. Follow
   `.claude/skills/gopnik-critic/SKILL.md`: an adversary whose mandate is to
   refute, then verify its load-bearing claim yourself, then have it confirm
   your retelling. A change that asserts nothing beyond "this now behaves as the
   issue asked" skips this.

6. **Run the gate.** Both stages, evidence per item. Stage 2 crosses the
   boundary named in the issue, using the artifact as produced — for this
   repository that is the built application launched on a clean profile with
   real audio devices, as recorded in `gopnik.json`; a `tauri dev` window on the
   working tree does not stand in for it. macOS and Windows are not reachable
   here (ADR 0005): the verdict names them as not proven, it never implies them.

7. **Post the verdict to the issue** — `gh issue comment` — with the evidence: what was run, what came
   back, and what a broken version would have produced instead. `NOT READY`
   leaves it open with the reproductions attached. `READY` does **not** close it
   here — the pull request below closes it at merge, so the tracker and `main`
   never disagree. Close it directly only when the work ships without a pull
   request, because then nothing else will — `gh issue close --reason completed`.

8. **If a `BLOCKER` was fixed, the verdict is void.** Start a fresh round on the
   new revision, as a new comment, and carry the findings-dynamics line so the
   sequence stays readable. Since step 7 hands the closing to the merge, this
   also means **do not merge on a verdict the last fix superseded** — the
   merge, not the verdict, is now what closes the issue.

Then open the pull request with `gh pr create`, `Closes #$issue`, with the verdict linked rather
than restated. Two things that wording depends on: the keyword only closes when
the pull request targets the default branch, and closing the issue before the
pull request exists voids the state change the keyword would have made — the
link itself survives, so the issue still shows on the pull request, already
closed on a change that has not landed and stays closed if it never does.

If you skip a step, say which and why in the issue. A step skipped in the open
is a decision; a step skipped quietly is the thing this repository refuses.

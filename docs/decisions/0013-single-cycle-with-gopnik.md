# ADR 0013: One development cycle, every issue through the critic and the gate

Date: 2026-09-01
Status: accepted (supersedes the cycle structure of ADR 0012)

## Context

ADR 0012 described five cycles and left verification to a definition of done. Gopnik
(`madduck-tech/gopnik`, MIT) provides an adversarial critic for claims and an adversarial gate
for finished changes, anchored to a GitHub issue that states what would settle it. The maintainer
chose to run every issue through both, accepting slower delivery for verified quality, and asked
for one simple cycle rather than five.

## Decision

1. All work is tracked as GitHub issues and follows the single cycle in
   `docs/development-workflow.md`: issue → critic → OpenDesign variants when the UI is touched →
   implementation → gate → pull request that closes the issue at merge.
2. No exemption lane. Every executable change passes the critic and the gate. Documentation-only
   changes skip them.
3. Gopnik is installed in the repository (`.claude/skills/gopnik*`, `gopnik.json`) so contributors
   receive it with the project. Its language is `en`; verdicts are public issue comments.
4. `/issue` and `/work` commands, the "Work item" issue template and the pull request template
   are adopted from Gopnik and adapted to this repository.
5. Stage 2 for the desktop app: UI flows are verified with the `computer-use` skill against the
   built application on a clean profile; audio flows through a PipeWire virtual-device harness,
   which is the first issue of Milestone 0 because the latency measurements (ADR 0008) need it
   too. Until it exists audio verdicts are narrowed and the maintainer decides per issue.
6. The critic's `CONTINUE` adds the `ready` label; the maintainer may override any verdict with
   a comment, which becomes the record. "Touches the UI" means a new screen or a changed layout.
7. Release criterion: Linux proven end to end; macOS and Windows built in CI and documented as
   unverified. Hint quality is outside the cycle and gets its own evaluation harness later.
8. The approval gates and conventions of ADR 0012 stay in force; its five-cycle structure and the
   direct-to-`main` allowance for design files are replaced by this ADR (design files now travel
   with their issue).

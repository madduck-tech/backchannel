# ADR 0014: Product owner and engineering — where the gates are

Date: 2026-09-02
Status: accepted (supersedes the merge gate of ADR 0012 and ADR 0013)

## Context

ADR 0012 and 0013 made the maintainer the merge gate of every pull request. After the first
issue went through the full cycle, the maintainer stated the role they want: product owner —
direction, evaluating concepts and design variants, relaying user feedback, deciding releases —
and explicitly not reviewing pull requests or merging ("I don't want the merge to be my gate").

## Decision

1. **Product owner** (the maintainer): direction and scope, approval of concepts and design
   variants, user feedback, releases.
2. **Engineering** (Claude Code, other agents, contributors): the technical work end to end —
   issues, critic, implementation, gopnik gate, merging on a `READY` verdict, CI, dependencies,
   infrastructure.
3. **Gates that remain with the product owner:** a new screen or changed layout (design variants
   before implementation), a change of scope relative to an accepted ADR or issue, a release, and
   anything else that reaches users or the outside (publishing, organization settings, the app's
   name, storage keys).
4. **Merging is no longer a gate.** On `READY`, engineering merges with a merge commit and deletes
   the branch; the merge closes the issue. A verdict superseded by a later fix is not merged on.
5. Destructive operations on shared state (rewriting history on `main`, deleting data) are still
   announced before they happen.

## Consequences

- The product owner's time goes to product questions; the record of what was verified stays in the
  issue and the pull request, not in a review conversation.
- The critic and the gate are the only technical checks between an issue and `main`; their
  discipline carries the weight the review used to. A gate skipped is a decision stated in the
  issue, never a quiet omission.

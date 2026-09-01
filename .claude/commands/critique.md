---
description: Run the critic on an issue before any work starts, and post the verdict to it.
argument-hint: <issue number>
arguments: [issue]
allowed-tools: Bash(gh issue view:*), Bash(gh issue comment:*), Bash(gh issue edit:*), Read, Agent
---
Attack issue **$issue** before anyone works it. Read
`.claude/skills/gopnik-critic/SKILL.md` first; what follows is the order, not a replacement.

1. `gh issue view $issue --comments`. The claim under review is the issue itself: its diagnosis
   of what is wrong, its scope, and above all its *what would settle it*.
2. Spawn one independent adversary with `gopnik-critic` in independent adversary mode, with
   the mandate to refute: is the oracle an observation that could come back negative, is the
   diagnosis supported by the sources quoted, is the scope one change or several, is anything
   load-bearing assumed rather than shown.
3. Verify the adversary's load-bearing finding yourself against the repository or the sources.
4. Post the verdict as a comment: `CONTINUE`, `REVISE` (with the concrete rewrite the issue
   needs), or `BLOCK` (with why it cannot be settled as written). Evidence beats adjectives.
5. `CONTINUE` adds the `ready` label. `REVISE` and `BLOCK` do not; the maintainer rewrites,
   splits or closes. The maintainer may override a verdict with a comment saying why; the
   override is the record, not the verdict.

Do not start the work in the same turn.

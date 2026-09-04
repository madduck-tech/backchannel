# Workflow rules (always loaded)

Normative source: `docs/development-workflow.md`. Decisions: `docs/decisions/README.md`.

- One cycle for every change: issue with "what would settle it" → `gopnik-critic` on the issue →
  OpenDesign prototype variants approved by the maintainer when the UI is touched → implementation
  on a branch with the Stage 0 matrix posted first → `gopnik` gate with the verdict posted to the
  issue → pull request `Closes #N` linking the verdict, merged by engineering on READY. No exceptions
  for executable changes. Documentation-only changes go straight to `main`.
- Everything in the repository, issues and pull requests is in English (ADR 0010). Conversation
  with the maintainer may be in any language.
- `main` is the only long-lived branch. Commits are conventional
  (`feat|fix|docs|design|refactor|test|chore|ci(scope): subject`); agent commits carry the
  `Co-Authored-By` trailer.
- Roles (ADR 0014): the maintainer is the product owner — direction, concepts and design variants,
  user feedback, releases. Engineering (the agent) owns everything technical, merging included.
  Never ask the product owner to review or merge a pull request.
- Stop and ask before: a release or anything else that reaches users or the outside, renaming the
  app or storage keys, committing a prototype or design-system change the product owner has not
  seen, changing an issue's scope after the critic accepted it, rewriting history on `main` or
  deleting data.
- A decision someone would have to rediscover from code gets an ADR; supersede, never rewrite.
- Product terminology: "share protection", never "stealth", "invisible", "undetectable" (ADR 0009).
- `/usr/bin/od` is GNU coreutils and must not be shadowed. OpenDesign is `opendesign start|open|od …`
  or the `open-design` MCP server; prototype runs pass `project: "backchannel-prototypes"`.
- Testing is not optional and not vibes: `.claude/rules/testing.md` and ADR 0016. A change that
  executes ships with a test shown red without it; a bug is red-first with the failure output in the
  pull request.
- Report outcomes faithfully: failed checks, skipped steps and unverified platforms are stated,
  never implied. A readiness claim without a gopnik verdict is not made.

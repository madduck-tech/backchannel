# Workflow rules (always loaded)

Normative source: `docs/development-workflow.md`. Decisions: `docs/decisions/README.md`.

- Everything in the repository is in English: code, comments, commits, docs, UI strings (ADR 0010).
  Conversation with the maintainer may be in any language.
- `main` is the only long-lived branch. Docs, ADRs, approved design files and trivial fixes may go
  straight to `main`. All other code goes through a pull request the maintainer merges.
- Commits are conventional: `feat|fix|docs|design|refactor|test|chore|ci(scope): subject`, subject
  in the imperative, body says why. Agent commits carry the `Co-Authored-By` trailer.
- Stop and ask before: merging a PR, releasing, anything outward-facing, rewriting history,
  deleting branches or data, renaming the app or storage keys, adding a dependency that changes
  the license chain or a platform build, committing a prototype or design-system change the
  maintainer has not seen, changing scope relative to an ADR.
- A decision that someone would have to rediscover from code gets an ADR
  (`docs/decisions/NNNN-slug.md`, Context / Decision / Consequences, row in the index).
  Never rewrite an accepted ADR's substance; supersede it.
- Definition of done: implemented and pushed, logic tested, docs and ADRs updated, UI seen in the
  running app, commit or PR states what was verified and what was not.
- Product terminology: "share protection", never "stealth", "invisible", "undetectable" (ADR 0009).
- `/usr/bin/od` is GNU coreutils and must not be shadowed. OpenDesign is driven with
  `opendesign start|open|od …` or the `open-design` MCP server; prototype runs pass
  `project: "backchannel-prototypes"` explicitly.
- Report outcomes faithfully: failed tests, skipped steps and unverified platforms are stated.

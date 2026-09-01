# Development workflow

One cycle for every change. Every step leaves a trace in the GitHub issue, so the issue is the
record and `main` never disagrees with it.

## The cycle

1. **Issue.** Every change starts as a GitHub issue using the "Work item" template. Its one
   mandatory field is *what would settle it*: the observation that decides the issue is done,
   stated so it could come back negative. An issue without it is not ready to be worked.
2. **Critic.** `gopnik-critic` attacks the issue: the diagnosis, the scope, the oracle. Its
   verdict (`CONTINUE`, `REVISE`, `BLOCK`) is posted as a comment. `CONTINUE` adds the `ready`
   label; `REVISE` means the issue is rewritten before any work; `BLOCK` means it is closed or
   split. The critic and the implementer are the same model, so the maintainer's `ready` is the
   real gate: the maintainer may override any verdict with a comment saying why, and that
   comment, not the verdict, is the record.
3. **Design, when the issue adds a screen or changes a layout** (label `ui`; a new button label
   or a field in an existing form is not design). Prototype variants are made in OpenDesign
   against the `backchannel` design system. The maintainer picks one in Studio or from screenshots; the
   chosen variant is linked in the issue and, once approved, committed to `design/prototypes/`.
   No implementation starts before the pick.
4. **Implementation** on a branch from `main`. The Stage 0 matrix from the `gopnik` skill is
   posted to the issue before the first commit.
5. **Gate.** `gopnik` attacks the finished change: Stage 1 against the repository, Stage 2 across
   the delivery boundary, with proof that a load-bearing check can fail. The verdict and its
   evidence are posted to the issue. `NOT READY` means fix and a fresh round on the new revision.
   Stage 2 for this product is the built application on a clean profile: UI flows are driven
   with the `computer-use` skill (real window, accessibility tree, screenshots); audio flows use
   the PipeWire virtual-device harness (a null sink fed with a recording as the system channel,
   a virtual source as the microphone). Until the harness exists, audio verdicts are narrowed and
   name what is not proven; merging on a narrowed verdict is the maintainer's per-issue decision,
   recorded as a comment.
6. **Pull request** with `Closes #N` and a link to the verdict. The maintainer merges; the merge
   closes the issue.

That is the whole cycle. It applies to every executable change without exception; waiting longer
for a verified change is the accepted cost. Documentation-only changes skip steps 2–5 and go
straight to `main`.

## Decisions

A decision that someone would otherwise have to rediscover from code is recorded as an ADR in
`docs/decisions/` (Context, Decision, Consequences; row in the index; supersede, never rewrite).
An ADR is not a step of the cycle; it is written when the cycle produces such a decision.

## Conventions

- **Language.** Everything in the repository, the issues and the pull requests is in English
  (ADR 0010).
- **Branches.** `main` is the only long-lived branch and must always build. Work happens on
  short-lived branches; upstream's `devtest` convention is retired.
- **Commits.** `feat|fix|docs|design|refactor|test|chore|ci(scope): subject`, imperative subject,
  body says why. Agent commits carry the `Co-Authored-By` trailer.
- **Platform code.** macOS and Windows paths are written blind on Linux (ADR 0005); they are
  marked unverified in code and in the pull request, and the gate's verdict names them as not
  proven. The release criterion accepts this explicitly: Linux proven end to end, macOS and
  Windows built in CI and documented as unverified.
- **What the cycle does not measure.** The critic and the gate prove that a change works, not
  that the copilot is useful. Hint quality needs its own evaluation harness (a transcript set
  and a scoring pass); it is a future issue, not a step of this cycle.
- **Design system.** A change to a token or a component rule touches `design/backchannel/DESIGN.md`,
  `design/backchannel/tokens.css` and `frontend/src/app/globals.css` in one commit.
- **Dependencies.** A new crate or package is called out in the pull request with its license.
  Git dependencies are pinned to a revision.
- **Milestones.** A milestone is a set of issues. Its report in `docs/milestones/` is assembled
  from their verdicts and the measurements they carry (ADR 0008). The maintainer closes it.

## Approval gates

The agent proceeds on its own inside the cycle. It stops and asks before: merging a pull
request; releasing or anything else outward-facing; rewriting history, deleting branches or
data; renaming the app or storage keys; adding a dependency that changes the license chain or a
platform build; committing a prototype or design-system change the maintainer has not seen;
changing an issue's scope after the critic accepted it.

## Tooling

- **Gopnik** (`.claude/skills/gopnik*`, config in `gopnik.json`): the critic and the gate.
  `/issue` turns a discussion into an issue; `/work N` runs an issue through the cycle.
- **OpenDesign** (`opendesign start|open|od …`, MCP server `open-design`): prototypes against
  `design/backchannel`. Runs pass `project: "backchannel-prototypes"` explicitly.
- **Agent session start:** read `CLAUDE.md`, this file, `docs/decisions/README.md`.

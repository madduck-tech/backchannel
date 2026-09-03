# Development workflow

One cycle for every change. Every step leaves a trace in the GitHub issue, so the issue is the
record and `main` never disagrees with it.

## Roles

- **Product owner** (the maintainer). Owns direction and scope, evaluates concepts and design
  variants, relays user feedback, decides what is released and when. Does not review pull
  requests and is not the merge gate (ADR 0014).
- **Engineering** (Claude Code, other coding agents, contributors). Owns the technical work end to
  end: issues, critic, implementation, gate, merging, CI, dependencies, infrastructure. Works from
  ADRs and this document, reports outcomes faithfully, and stops only at the product gates below.

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
   the PipeWire virtual-device harness: `scripts/audio-harness.sh` makes a virtual source the
   default input and loops a recording into it, and `scripts/stage2-record-check.sh` drives the
   built application through a recording and asserts the sample's words come back as a transcript.
   Both are wired into `gopnik.json`; the system-audio side (`--system-only --system-home`) is
   verified but run by hand, because each application run costs about ten minutes. The audio pass
   needs a live PipeWire session and so does not run in CI. Audio verdicts are no longer narrowed
   by default; where a verdict still cannot reach something — both channels at once, transcription
   quality, macOS and Windows — it names what is not proven.
6. **Pull request** with `Closes #N` and a link to the verdict. On a `READY` verdict engineering
   merges it (merge commit, branch deleted); the merge closes the issue. A verdict superseded by
   a later fix is not merged on.

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

Engineering proceeds on its own inside the cycle, merging included. It stops and asks the product
owner only for product decisions: a new screen or a changed layout (design variants, step 3);
a change of scope relative to an accepted ADR or an accepted issue; a release, and anything else
that reaches users or the outside (publishing, organization settings, the app's name, storage
keys). Destructive operations on shared state — rewriting history on `main`, deleting data —
are still announced before they happen.

## Tooling

- **Gopnik** (`.claude/skills/gopnik*`, config in `gopnik.json`): the critic and the gate.
  `/issue` turns a discussion into an issue; `/work N` runs an issue through the cycle.
- **OpenDesign** (`opendesign start|open|od …`, MCP server `open-design`): prototypes against
  `design/backchannel`. Runs pass `project: "backchannel-prototypes"` explicitly.
- **Agent session start:** read `CLAUDE.md`, this file, `docs/decisions/README.md`.

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

## The quality cycle

ADR 0016. The cycle above asks whether the work does what is claimed; this asks whether the next
change will be caught.

None of the six items below has a failure mode: no tool reads a pull request body or a verdict. They
are conventions the gate and the critic enforce by being run, not by being automated. What *is*
automated is the table underneath.

1. **A change that executes ships with a test that fails without it.** Not "is covered" — a test
   demonstrated red on the code as it was. A bug is **red-first**: the failing test, its output pasted
   in the pull request, then the fix. A feature ships with a negative control — break the behaviour,
   show red, restore.
2. **The control is shown, not asserted.** The mutation and its output go in the pull request. Mutate
   by line number, or re-read the anchor: both known cases of a control that silently did nothing came
   from an anchor that did not match the file, and a control that does nothing reads exactly like a
   check that passes.
3. **When a check has several conditions, say how many controls are owed.** Three checks with five
   conditions owe five.
4. **A `READY` verdict on an executable change carries the control table.** This is a rule for
   whoever writes the verdict, recorded in `gopnik.json` where the gate reads it. Nothing mechanically
   refuses a verdict without one — no tool parses a verdict — so it rests on the same honesty as the
   rest of this section.
5. **Verify claims against the artifact, not the intent to produce it.** Re-read what was published.
6. **A `READY` verdict on an executable change carries its environment record.** Stage 1's first
   command is `scripts/environment-record.sh`; its output goes in the verdict with the rest. ADR 0019.
   A verdict is a claim about the repository and its evidence is a claim about a machine, and on
   2026-09-05 those differed three times in one day — 0 clippy findings locally against 35 in CI on
   one tree, a test that took different code paths depending on whether ffmpeg was on `PATH`, and an
   enumeration hang nobody has explained. Same honesty as 1–5: nothing parses a verdict. What *is*
   enforced is that the command runs on both sides, so the evidence arrives whether or not the author
   thought about it.

What is machine-enforced rather than asked for, and the check that does it:

| rule | check |
|---|---|
| an `#[ignore]`d test is run by the gate or excused with a reason, and the excuse cannot go stale | `frontend/tests/lib/ignored-tests-are-run.test.mjs` |
| a file under `tests/` that the runner's glob would skip | the same test |
| a registered command invoked from nowhere, or an invoke naming a command that does not exist | `command-reachability.test.mjs` |
| a modal key nothing can open, and the four declarations of that key list agreeing | `modal-reachability.test.mjs` |
| a component unreachable from any page | `component-reachability.test.mjs` |
| the string the device picker stores, against the Rust that parses it | `device-preference-string.test.mjs` |
| the device picker's two lists and two handlers, rendered | `device-selection.test.mjs` |
| the picker instructing the user to click a control it does not render | `device-selection-instructions.test.mjs` |
| either lint step (rustc's deny, eslint) being removed, switched off at step or job level, defanged with `\|\| true`, or left in a workflow that no longer runs on pull requests; and `eslint.config.mjs` importing something that is not installed | `lint-step-is-enforced.test.mjs`, over the reader in `workflow-yaml.test.mjs` |
| the environment record, or any lint step, running on one side only — configured in `gopnik.json` stage 1 but not `test.yml`, or the reverse; and CI provisioning a Node or pnpm version other than the one `.nvmrc` and `packageManager` pin | the same test |
| a transcript row's capture channel, across the Rust enum, the event, both TypeScript interfaces, the column and its migration — and the diarization pass leaving it alone | `transcript-channel.test.mjs` |
| the AppImage CI publishes for a Stage 2 pass being built by a different command than `gopnik.json` stage 2 names, or the job being switched off, or a build that produced no artifact going green | `stage2-artifact-matches-the-gate.test.mjs`, over the same reader |
| the recording control offering Start and Stop at once, a pause label that stops following the recording-state context, or `isRecordingDisabled` reaching only the styling | `recording-controls.test.mjs`, rendered and driven in jsdom |
| the sidebar losing the meetings list, mismarking the current meeting, leaving a deleted current meeting selected, letting a rename and the open meeting disagree, writing a blank title, or still reporting idle while recording | `sidebar.test.mjs`, rendered and driven in jsdom |
| the transcript losing a row at the virtualisation threshold, leaving a hole in the rendered window, editing the text it displays, or showing a raw diarizer id beside a named speaker | `transcript-view.test.mjs`, rendered and driven in jsdom with a faked layout |
| model settings saving a provider with no API key or a blank custom endpoint, keeping an untrimmed key, carrying one provider's custom endpoint into another's config, or telling the parent a configuration was saved after the backend refused it | `model-settings.test.mjs`, rendered and driven in jsdom |
| updater artifacts being produced for an endpoint outside this fork, or being switched on while the fork owns no updater identity | `updater-identity.test.mjs` |
| the share of components a test has ever rendered falling, whether because a test stopped rendering one or because components were added faster than tests | `rendered-component-ratio.test.mjs`, which holds both the numerator and the denominator |

The three reachability checks — and only those three — hold their allowlists under **set equality**,
so wiring a thing up, deleting it, or adding a new unreached one all force an edit. Every other row
is a literal pin with no allowlist — stated as a rule rather than a count, because the count that
stood here ("the other six rows") matched no way of counting the table on the day it was written:
that table had 7 rows and named 5 test files, which gives 4 or 2, never 6. The table lists the
checks that guard *reachability and contracts*; it is not the whole suite, which has 24 test files.

They are **not** immune to a mention in a comment. A commented-out `invoke('name')` moves the set and
turns the check STALE, and the cheapest way to resolve a STALE is to delete the allowlist entry and
its reason — the record the check exists to build. Matching on string literals rather than bare
identifiers narrows this; it does not close it. Closing it needs a lint that reads TypeScript, which
is #35; the Rust half of that gap is closed (ADR 0017).

Not covered, and named so the absence is a decision: a backend that fabricates a value a correct
component renders is caught by nothing, and **eleven eslint rules remain off** (#38, 277 findings,
one rule per pull request — 98 of them `react-hooks/*`, which are behaviour rather than style).
JavaScript itself is linted and denied as of #35; the Rust half as of ADR 0017 and ADR 0018.

Stage 2's **accessibility-tree** driver reaches only top-level push buttons — a `page tab` exposes no
action to it, and neither keyboard nor coordinate input reaches the webview. That is a limit of that
instrument, not of the application: measured on 2026-09-04, a WebDriver session through `tauri-driver`
opens the settings tabs, lists the audio devices and selects one with real pointer events, against the
**bundled AppImage**, in about ten seconds on a profile with no models. #20 is the work of putting that
in the gate.

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

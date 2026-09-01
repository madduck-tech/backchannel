# Development workflow

How Backchannel is built: who decides, how decisions are recorded, how UI is designed, how code
lands, how a milestone is verified, and what needs the maintainer's explicit approval.
Changes to this document go through an ADR.

## Roles

- **Maintainer.** Owns product and design decisions, approves designs and merges, releases.
- **Claude Code** (and any other coding agent). Primary implementer. Works from ADRs and this
  document, reports outcomes faithfully, and stops at the approval gates below.
- **Contributors.** Welcome. Follow the same cycles; product decisions still go through an ADR.

Design discussion between maintainer and agent may happen in any language. Everything that
lands in the repository is in English (ADR 0010).

## Cycle 1 — Decide (ADRs)

An Architecture Decision Record is required for anything that changes architecture, product
scope, product rules, platform support, tooling, or this workflow. Small implementation choices
do not need one; a decision that someone would otherwise have to rediscover from code does.

1. Discuss until the decision is clear. One question at a time.
2. Write `docs/decisions/NNNN-slug.md`: Context (facts, with dates), Decision (numbered),
   Consequences. Status: `accepted`, later `superseded by NNNN` if replaced. Never edit an
   accepted decision's substance; write a new ADR that supersedes it.
3. Add the row to `docs/decisions/README.md`. Deferred questions live in its "Deferred" section.
4. Commit with `docs:` and push. ADRs may go straight to `main`.

## Cycle 2 — Design (UI/UX)

The design system is the package in `design/backchannel/` (ADR 0011). OpenDesign is the
prototyping tool, not the source of truth and not a code generator.

1. **Define the screen** first: which of the five product moments it serves (create an agent,
   start a meeting, get useful help, save a structured result, ask across meetings), what it
   shows, what it must never show. This usually already exists in the spec or an ADR.
2. **Prototype in OpenDesign** against the `backchannel` design system. The agent starts the
   run over MCP (`start_run` with `project: "backchannel-prototypes"`) or the maintainer works
   in Studio. Iterate in Studio chat; each iteration is minutes.
3. **Approval gate.** The maintainer looks at the prototype (Studio, or a screenshot the agent
   sends) and says yes or what to change. Nothing moves further without the yes.
4. **Record.** The approved HTML goes to `design/prototypes/` with a row in its README, committed
   with `design:`.
5. **Implement** in the app (Tauri + React + Tailwind). Token names match between prototype and
   app (`var(--accent)` in the prototype is `bg-brand` in code), so the port is mechanical.
   The prototype is a reference, never copied as-is.
6. **Verify in the running app.** The agent runs the app, captures a screenshot, and compares
   it with the prototype; the maintainer reviews the real screen.

Rules:

- A change to the design system itself (a token, a component rule, a surface constraint) is one
  commit touching all three: `design/backchannel/DESIGN.md`, `design/backchannel/tokens.css`,
  `frontend/src/app/globals.css`.
- Prototype only where there is design risk: My Agents home, agent chat + card, Setup Master,
  Meeting Review, overlay. Settings forms, lists and dialogs are built directly from shadcn
  primitives under `DESIGN.md` rules.
- Prototype key states, not every state.
- Never ask OpenDesign for React code; its output is HTML.
- Terminology from ADR 0009 applies to every prototype and every screen.

## Cycle 3 — Build (code)

- **Branches.** `main` is the only long-lived branch and must always build. Work on short-lived
  branches from `main`. The former `devtest` branch convention from upstream is retired.
- **What may go straight to `main`:** docs, ADRs, design-system files and approved prototypes,
  CI fixes, and trivial changes (typos, comments, one-line fixes with no behavior change).
- **What goes through a pull request:** everything else, and always anything touching the audio
  pipeline, transcription, the LLM runtime, storage schema and migrations, platform-specific
  capture code, or the overlay. The maintainer merges. A PR description states what changed,
  why, how it was verified, and what was not verified.
- **Commits.** Conventional style: `feat`, `fix`, `docs`, `design`, `refactor`, `test`, `chore`,
  `ci`, with an optional scope, e.g. `feat(audio): split mic and system streams`. Subject in the
  imperative, body explains why. Commits made with an agent carry its trailer.
- **Tests.** Logic in the Rust core gets unit tests; the transcription layer is a port with
  adapters on purpose, keep it testable with fakes. Frontend logic in `frontend/tests`. CI must
  be green before merge.
- **Platform code.** macOS and Windows paths are written blind on Linux (ADR 0005). Such code is
  marked unverified in the PR and in a comment until someone runs it on the platform.
- **Dependencies.** A new crate or npm package is called out in the PR with its license and why
  it is needed. Pin git dependencies to a revision.
- **Upstream.** `upstream` points at Conversationaly with push disabled. Cherry-pick individual
  fixes when useful; never merge upstream wholesale.

## Cycle 4 — Verify (milestones)

A milestone closes on measured numbers, not on "it works".

1. Its criteria come from ADRs (Milestone 0: ADR 0002, 0003, 0005, 0008) and are listed in
   `docs/milestones/<name>.md` before work starts.
2. Measurements run on the emulated minimum machine (ADR 0003, ADR 0008): 4 cores, 8 GB, no GPU,
   via `systemd-run --user -p CPUQuota=400% -p MemoryMax=8G`. Numbers without the limit are not
   accepted.
3. The report in the same file lists p50 and p95 per criterion, the hardware, the models used,
   and what was skipped or failed. Failed criteria stay listed as failed; the milestone is not
   closed by narrowing it.
4. The maintainer closes the milestone.

## Cycle 5 — Ship (releases)

Not before Milestone 0 closes. When it does: a tag triggers the inherited release workflow that
builds the installers; release notes in English list user-visible changes and known platform
gaps (ADR 0005). Unsigned builds are documented as such.

## Approval gates

The agent proceeds on its own for everything that follows from an accepted ADR or an approved
design and is reversible. It stops and asks before:

- merging a pull request, releasing, or anything else outward-facing (organization settings,
  publishing, external services);
- rewriting history, deleting branches or data, or force-pushing;
- renaming the app, storage keys, bundle identifiers, or other rebrand steps;
- adding a runtime dependency that affects the license chain or the build on any platform;
- committing a prototype or a design-system change that the maintainer has not seen;
- narrowing or widening scope relative to an ADR.

## Definition of done

A task is done when: the change is implemented and pushed; logic has tests; docs and ADRs are
updated where the change affects them; a UI change has been seen in the running app; the commit
or PR says what was verified and what was not. Anything skipped is stated, not implied.

## Agent session checklist

At the start of a session an agent reads, in this order: `CLAUDE.md`, this file,
`docs/decisions/README.md`. It writes decisions into ADRs, not into chat history. It never
shadows `/usr/bin/od`; OpenDesign is driven through `opendesign` (daemon on 7456, web UI on 5175)
or the `open-design` MCP server.

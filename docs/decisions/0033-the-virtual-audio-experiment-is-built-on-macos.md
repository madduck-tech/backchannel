# 0033 — The virtual audio experiment is built on macOS, signed locally, on a branch of its own

Date: 2026-10-28
Status: accepted. Supersedes, for the virtual audio experiment only, decision 5 of
[ADR 0005](0005-platform-support-tiers.md), decision 5 of [ADR 0008](0008-latency-targets.md) and
decision 1 of [ADR 0012](0012-development-workflow.md) ("`main` is the only long-lived branch", as
`docs/development-workflow.md` repeats it). None of them is changed for any other work. Decision 3 is
amended by [ADR 0035](0035-the-experiment-branch-merges-before-ci-and-runs-it-after.md): pull requests into the
branch merge before CI, which runs after.

## Context

The virtual audio experiment ([specification](../virtual-audio-experiment-spec.md),
[plan](../virtual-audio-experiment-plan.md)) exposes Backchannel as a microphone and a speaker that a
calling application selects, and records both directions through them. On 2026-10-28:

- **ADR 0005 decision 5 makes "this Linux machine" the only development environment**, and
  `.claude/rules/platform-code.md` tells every agent working under `audio/**` that development happens
  on Linux only and macOS paths are written blind.
- **The product owner's development machine is a Mac**: macOS 26.6.2 (25G83), arm64 (`sw_vers`,
  `uname -m`). Linux runtime verification is, in the product owner's words, currently difficult to
  arrange.
- **On macOS a virtual device is an AudioServer plug-in** loaded by `coreaudiod` from
  `/Library/Audio/Plug-Ins/HAL/`; that directory needs administrator rights, and loading a new plug-in
  needs `coreaudiod` restarted. Three third-party plug-ins are installed there today
  (`ParrotAudioPlugin.driver`, `SteamStreamingMicrophone.driver`, `SteamStreamingSpeakers.driver`).
- **The repository has no signing identity.** ADR 0020 records zero secrets; macOS bundles are signed
  ad hoc (`bundle.macOS.signingIdentity` is `"-"`).
- **ADR 0008 decision 5 accepts no latency number measured without the `systemd-run` limit**, and
  `docs/milestones/README.md` repeats it; `systemd-run` does not exist on macOS.
- **The existing Stage 2 cannot run on macOS** (`gopnik.json` stage 2, read from source): it locates an
  AppImage, drives the UI through `tauri-driver`, reads AT-SPI through `orca-ide`, feeds audio through
  PipeWire and emulates the minimum machine with `systemd-run`.

The product owner decided on 2026-10-28, in conversation, reviewing the two documents above:

- the experiment is developed and verified on macOS first; Linux and Windows are deferred;
- there will be no Apple Developer Program membership for now, because this is an experiment;
- there is no feature flag: if the experiment succeeds, its branch is merged into `main`.

## Decision

1. **The virtual audio experiment is developed and runtime-verified on macOS.** For code written for
   this experiment, macOS is the verified platform and Linux and Windows paths are the ones marked
   `// UNVERIFIED on <platform>`. A macOS result says nothing about Linux or Windows, and no verdict
   implies them. ADR 0005's support tiers do not change.
2. **No Developer ID, no notarization, no distribution.** The plug-in, the routing helper and the
   application are built and installed locally on the development Mac, signed ad hoc or with a local
   self-signed certificate. If `coreaudiod` or TCC refuses that, the experiment stops or is revised; it
   does not acquire a Developer ID without a new product decision.
3. **The experiment lives on `exp/virtual-audio`**, branched from `main` in a separate worktree. Each
   work item is a short-lived branch and a pull request into it, through the full cycle of
   `docs/development-workflow.md`. `main` is merged into it, never rebased onto once pull requests
   have merged. Its macOS code is behind `#[cfg(target_os = "macos")]` and passes the Linux CI build.
4. **The branch is merged into `main` only on a continue decision**, through one pull request with its
   own verdict. That verdict names the Linux surfaces the branch touched and whether Linux Stage 2
   reached them; an unreached surface is a named gap that blocks under ADR 0022 until the product owner
   or an issue accepts it. On stop or revise, the branch is not merged and its milestone report and
   ADRs go to `main` as documentation.
5. **The experiment's Stage 2 is a macOS instrument built first** (plan step 2), recorded in
   `gopnik.json` through `gopnik-setup`, with `scripts/environment-record.sh` extended by the macOS keys
   that ADR 0019 requires a verdict to carry.
6. **The rules say so**, in the same change as this ADR: `.claude/rules/platform-code.md` (Linux
   only, and latency under `systemd-run`), `.claude/rules/testing.md` (macOS verified by CI builds
   only), `.claude/rules/workflow.md` (the long-lived branch), `docs/development-workflow.md`
   (Branches, Platform code, steps 4, 5 and 6), `docs/milestones/README.md` (ADR 0008 decision 5),
   `CONTRIBUTING.md` (branch, Stage 2, closing keyword), `.github/pull_request_template.md` (closing
   keyword) and the `/work` command (branch base, platform reach, `Refs #N` with a manual close),
   with `AGENTS.md` and the generated commands regenerated and a pointer left in ADRs 0005, 0008 and
   0012. **One surface lags:** the `gopnik.json` notes, which say every verification run happens on
   Linux, are rewritten by plan step 2 through `gopnik-setup`, since that step is what gives the
   experiment a macOS stage. Until then an agent on the experiment branch reads them; a step-1
   precondition fix's verdict states that they do not apply and that its Stage 2 is the
   precondition run on the development Mac.
7. **ADR 0008 decision 5 does not apply to the experiment's numbers** (A4, A5, A7, A9, A14). They are
   bridge and control latencies on the development Mac, not the copilot's end-to-end latency, and the
   minimum machine cannot be emulated there. Every report of them names the machine and says they are
   not from the minimum machine; none is cited as evidence for an ADR 0008 criterion.

## Consequences

- **Two rules for one directory, chosen by branch.** On `main`, macOS audio code is still written blind;
  on `exp/virtual-audio`, it is verified and Linux is not. The rule states which applies where.
- **A long-lived branch drifts.** The cost is paid in the merges from `main`, and in the final verdict,
  which reruns everything on the merge result rather than trusting the branch's history.
- **Nobody but the product owner can run the result.** An ad-hoc signed plug-in and helper cannot be
  handed to anyone else, and the experiment measures nothing about Gatekeeper, notarization or a
  privileged installer.
- **Machine-wide state is outside the worktree.** The plug-in, the helper's launchd job and TCC grants
  outlive any checkout; every work item that installs one states how its removal was verified.
- **The Linux gate's denominator does not reach the experiment's code.** Until the branch is merged,
  Linux Stage 2 runs nothing of it, and that is a known gap, not a pass.

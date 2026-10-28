# Virtual audio devices experiment implementation plan

Date: 2026-10-28
Status: Proposed work breakdown; implementation has not started.
Requirements and acceptance IDs: [Experiment specification](virtual-audio-experiment-spec.md).

## Delivery rules

The product owner decided on 2026-10-28 (specification, "Scope and platform boundary"):

- macOS is the development and verification platform for this experiment; Linux and Windows
  runtime work is deferred and no Linux machine or PipeWire session is required for the
  experiment verdict;
- no Apple Developer Program membership: local ad-hoc or self-signed builds only, nothing
  notarized or distributed;
- no feature flag: the work lives on one experiment branch, merged into `main` only if the
  experiment decision is continue.

These override ADR 0005 decision 5, `.claude/rules/platform-code.md` ("Development happens
on Linux only") and "`main` is the only long-lived branch" for this experiment only.
[ADR 0033](decisions/0033-the-virtual-audio-experiment-is-built-on-macos.md) records them, and
`platform-code.md` carries the exception in the same commit.

### Branches and worktree

- The experiment branch is `exp/virtual-audio`, branched from `main` in a separate managed
  worktree. Record the worktree path and branch in the umbrella issue. Do not implement the
  experiment in the primary checkout.
- Each work item is a short-lived branch from `exp/virtual-audio` and a pull request into
  it, with the full cycle: issue → critic → approved design → Stage 0 matrix →
  implementation → gopnik → READY → merge by engineering. `test.yml` runs on every pull
  request, so Linux Stage 1 holds on the experiment branch as it does on `main`.
- Merge `main` into `exp/virtual-audio` at least at every work-item merge, so the final
  merge does not become a rewrite. Do not rebase the experiment branch once pull requests
  have merged into it.
- macOS code in shared crates sits behind `#[cfg(target_os = "macos")]` and must pass
  `-D warnings` on the Linux CI build. Linux paths touched on the branch (recording manager,
  pipeline, transcription, settings) keep their existing tests green.
- Worktree isolation does not isolate the HAL plug-in, the helper's launchd job, TCC grants
  or Core Audio state. Every work item that installs something states what it installed and
  how its cleanup was verified on the development Mac.

### Design and documentation

This documentation does not authorize an unreviewed layout. Produce OpenDesign variants
using `backchannel-prototypes`; the product owner's chosen setup/settings design is committed
under `design/prototypes/` before its UI implementation. Record requirement-to-test debts in
the issues until tests exist. Do not edit generated `AGENTS.md` files; edit their sources.

## Sequence and work items

| Step | Work item and dependencies | Deliverable and exit observation |
| --- | --- | --- |
| 0 | Umbrella issue, ADR and worktree; no dependency | Umbrella issue with macOS-only scope, deferred Linux/Windows, thresholds A1–A14, owed assertions and critic verdict. ADR 0033 and the `platform-code.md` exception merged to `main`. Experiment branch and worktree created from that `main` and recorded in the issue. |
| 1 | macOS verification instrument; after step 0 | The Stage 2 that every later step needs (see "macOS verification instrument"). Exit: one recorded run on the development Mac in which each oracle is shown red by a deliberate fault and green without it. No product code. |
| 2 | Loopback usefulness check; after step 1 | Two existing third-party loopback devices installed locally, a minimal forwarding process, and the current application recording them as microphone and system audio. The product owner runs real calls with it. **Go/no-go**: stop here if the explicit route is not found useful. Uninstall verified. No code merged into product paths. |
| 3 | HAL plug-in and helper feasibility spike; after step 2 go | Two public devices plus private bridge from a locally built plug-in; a launchd helper forwarding real bidirectional PCM; distinct markers recovered at an independent peer. First observations: whether `coreaudiod` loads the ad-hoc or self-signed plug-in, whether TCC keeps the helper's microphone grant across rebuilds, and on-demand opening from `StartIO`/`StopIO`. Install, restart and removal recorded. A1/A2/A14 preliminary. |
| 4 | Backend decision and test protocol; after step 3 | New ADR: plug-in source (owned versus reused, licence), bridge transport, helper launch mechanism and code identity, clock/rate-conversion strategy, shared-state ownership. Baseline latency/alignment instruments demonstrably detect added delay, lost blocks, wrong routes and drift. |
| 5 | Setup/settings/tray design; after step 0, using step 3 constraints | Approved committed prototypes for setup (including the administrator install step and its audio interruption), physical selectors, health, mute, recording and repair; failure/missing-device/quit states included. A12 requirement debts linked. Can overlap step 4. |
| 6 | Routing helper and endpoint lifecycle; after step 4 | Idempotent install detection and reconciliation, exclusive ownership, stable identities, physical selection, on-demand device opening, mute, client-independent forwarding, teardown. Locally built bundle runs without STT. A1/A4/A5/A8/A11/A14. |
| 7 | Device switching and recovery; after step 6 | Transactional replacement, loop prevention, hotplug state, sample-rate changes by clients, sleep/wake and `coreaudiod` restart recovery, truthful failure state. A7/A8/A10; validate both directions independently. |
| 8 | Recording integration; after steps 6/7 | Proxy capture adapter, process tap disabled in proxy mode, split durable tracks/shared timestamps, mixed playback compatibility, segmented models only, explicit completeness/gaps and labelled transcript output. A3/A6/A9/A10/A12/A13. |
| 9 | Setup, settings and tray controls; after steps 5/7, recording controls after step 8 | First-run enablement, install/permission detection, actual signal tests, route selectors, persistent preferences, mute, recording, status, quit/repair/removal instructions. State agrees across surfaces. A1/A7/A9/A11/A12. |
| 10 | Experiment qualification; after steps 8/9 | Locally built bundle on a fresh macOS user account with the plug-in not yet installed, native/browser compatibility matrix, one-hour duplex test, all controls and failure injections, milestone report with pass/fail and explicit gaps for A1–A14. |
| 11 | Product experiment decision; after step 10 | Continue/revise/stop on measured results and setup feedback. On continue: one pull request from `exp/virtual-audio` into `main` with its own gopnik verdict (see "Merging into main"). No release without the product owner's authorization. |

Steps are work packages, not necessarily one PR each. Keep PRs independently reviewable;
do not present intermediate incomplete flows as supported functionality. An output-only
spike does not settle the full-duplex umbrella issue. No calendar estimate is asserted
before the spike establishes the plug-in, helper and installation work.

## macOS verification instrument

The existing Stage 2 cannot run on macOS: it locates an AppImage, drives the UI through
`tauri-driver` (which does not support WKWebView), reads the accessibility tree through
`orca-ide` over AT-SPI, feeds audio through a PipeWire harness, and emulates the minimum
machine with `systemd-run`. Step 1 provides the macOS counterparts, through `gopnik-setup`
so they are recorded in `gopnik.json` and not guessed:

- **Artifact.** A locally built `.app` whose revision is bound the way `stage2-locate-app.sh`
  binds the AppImage (a `.built-from` file), so a stale bundle is refused.
- **UI driving.** The macOS accessibility API or computer-use, with the #160 rules: a refused
  interaction is a failure, every wait names something false in the state being left, and
  state is asserted after the interaction rather than its return value.
- **Environment record.** `scripts/environment-record.sh` gains macOS keys: OS version and
  build, architecture, plug-in and helper versions and signing identity, microphone TCC state
  for the helper, and the physical devices in use (ADR 0019).
- **Test rig.** Named and frozen in the umbrella issue: which device is the independent peer
  (a second machine or phone, or a local WebRTC loopback), the physical loop from an output to
  an input used for the latency baseline, and the headphones, microphone, speakers and
  Bluetooth headset used.
- **Marker detector.** Generated timed PCM markers with a codec-tolerant detector, calibrated
  for timing error and false matches before qualification.
- **Latency budget.** ADR 0008's `systemd-run` emulation has no macOS equivalent. The
  instrument records the machine and states that numbers are not from the minimum machine.

## Platform investigations

**macOS, required for the experiment.** Compare a plug-in built from Apple's NullAudio sample
or libASPL with an existing component, under the licence constraint in the specification.
Prove both endpoint roles, private bridge access, stable UIDs, physical routing, on-demand
opening and installation on the development Mac. Resolve without a Developer ID: plug-in
loading, helper launch (`SMAppService` versus a plain `~/Library/LaunchAgents` job), TCC
identity across rebuilds, `coreaudiod` restart policy, upgrade/removal and multiple clients.
A Core Audio process tap alone does not implement the public duplex endpoint contract. Do not
infer virtual-device runtime support from a successful macOS build.

**Linux deferred.** When a Linux runtime environment becomes available, compare native
PipeWire graph ownership with the existing PulseAudio-protocol integration. Demonstrate
public source/sink visibility in both native and browser clients; avoid assuming every
private stream becomes a public device. Measure node lifecycle on UI/service/server exit,
physical-device replacement and login restart. Prefer user-owned state and explicitly
enabled startup. If native PipeWire is chosen, record new build/runtime/packaging dependencies;
ADR 0015's reason for not adding them is still relevant. Reuse existing cpal capture where
appropriate, but do not confuse capture support with node creation or live forwarding.

**Windows deferred.** Investigate a signed virtual audio driver and bridge service, or an
existing redistributable component. Establish capture/render endpoint delivery, driver
signing/install/reboot requirements, supported Windows versions and endpoint identities.
SysVAD is an architectural starting point, not a functioning bridge. WASAPI passive loopback
alone does not implement the public virtual microphone.

These investigations have their own issues and verdicts. Building one OS does not require
writing placeholder implementations for the others. A missing backend has an explicit
unsupported capability result and cannot create an apparently ready setup.

## Integration map

Inspect current source again when implementation begins; these are integration candidates,
not instructions to expand existing classes indiscriminately.

| Existing surface | Intended responsibility |
| --- | --- |
| `frontend/src-tauri/src/audio/devices/` | Stable physical identities, capabilities and explicit exclusion of owned virtual endpoints from physical choices |
| New HAL plug-in and routing helper, paths chosen in the step 4 ADR | Public devices, bridge, long-lived forwarding ownership, state and health |
| `frontend/src-tauri/src/audio/capture/core_audio.rs` | Process tap stays off while proxy mode is enabled; a Stage 1 test holds this |
| `frontend/src-tauri/src/audio/stream.rs` | Existing passive capture; proxy adapter must avoid duplicate global capture |
| `frontend/src-tauri/src/audio/recording_manager.rs` | Attach/detach recorder without owning call-route lifetime; reject missing required directions |
| `frontend/src-tauri/src/audio/pipeline.rs` | Shared timing and separate direction semantics; prevent duplicated capture |
| `frontend/src-tauri/src/audio/transcription/` | Segmented models only in proxy mode; backlog/recovery per ADR 0027 |
| `frontend/src-tauri/src/audio/recording_saver.rs` and persistence layer | Durable split artifacts, mixed playback compatibility, gaps and failure reporting |
| `frontend/src-tauri/src/tray.rs` and approved frontend settings/setup | One authoritative state for selection, route/recording health and controls |
| Build scripts for the plug-in and helper | Reproducible local build, signing with the chosen local identity, install/uninstall scripts with recorded cleanup |

Define backend-neutral operations before UI wiring: probe/install state, enable/disable,
read actual state, select mic/output, mute, test routes, subscribe to health and reconcile.
Requests need identifiers and applied-state acknowledgements so stale results cannot
overwrite newer selections. Control access is restricted to the current local user.

## Verification protocol and negative controls

Freeze exact metrics and sample matching rules in the issue. Use generated timed PCM markers
for transport/latency oracles and distinct speech fixtures for transcription; STT text alone
cannot measure audio fidelity. Use a shared clock or calibrated reference for direction
alignment. Keep direct-device baselines with the same physical devices and transport.
Remote markers are matched using the calibrated codec-tolerant detector, not byte equality
with pre-encoding PCM. A3's zero-loss requirement applies to the bridge oracle at the
endpoint boundary; network-peer delivery is reported separately.

| Requirement family | Required challenge to the oracle |
| --- | --- |
| A1/A11 lifecycle | Seed an owned stale/duplicate device or launchd job and interrupt setup; ensure census/repair detects it without touching an unrelated sentinel device or OS defaults. |
| A2/A3 duplex | Disconnect each direction independently and omit/duplicate a known marker; verify the test identifies which direction and interval failed. |
| A4/A5 timing | Add known delay and clock-rate skew independently; show each corresponding threshold goes red. |
| A6 isolation | Send a distinct unrelated marker to another output, then intentionally send it into the proxy. Keep the call sentinel present in both runs. |
| A7 switching | Remove old and new devices in separate runs, fail the proposed switch, change the virtual device's sample rate from a client, and attempt a self/derived route; assert applied selection, peer audio and lack of silent fallback. |
| A8 containment | Kill UI, STT and routing helper in separate runs while an independent peer measures continuity; detect a deliberately interrupted route; assert both public devices remain present after the helper dies. |
| A9 recording/mute | Feed markers during stop/pause and through each mute control; inspect persisted tracks, mixed file, STT and peer audio using applied sample timestamps. Measure request-to-applied latency and next-owned-buffer silence separately from audio already delivered to OS/client/peer; do not assert recall of downstream samples. |
| A10 completeness | Exhaust capture queue, stall/kill writer, deny permission, restart `coreaudiod` and sleep/wake separately; compare gap metadata against reference evidence. |
| A12 settings/model | Select non-default devices, fail an apply, restart clients, and attempt to select a streaming model in proxy mode; assert actual state and channel behavior. |
| A13 transcription | Independently suppress decoder output and swap channel labels; each must fail the fixed speech-fixture oracle. Verify overlapping phrases and stopped/paused marker exclusion without replacing the PCM checks. |
| A14 on-demand opening | Start and stop a client on each endpoint; then make the helper open the physical device eagerly and show the check goes red; separately, delay the first physical sample and show the reported start latency follows. |

Each row contains multiple conditions. The issue must expand these into a control table
with one executed control per load-bearing condition and state the total count; this table
is a test design, not evidence that controls have run. Save mutations/injections, assertions,
failure output, restored-state checks and artifact revision in the verdict.

Stage 1 covers pure routing transitions, identity/loop rules, timing conversion, bounded
queue/gap behavior, pause/mute boundaries, persistence, the process tap staying off in proxy
mode, and UI/tray state with applicable frontend census updates. Stage 2 is the macOS
instrument from step 1, driving the locally built bundle, the actual public endpoints and an
independent peer. Existing capture harnesses are useful inputs but do not establish live
forwarding: a test reading the same local source can pass while the remote peer receives
nothing. Extend the gate denominator to include both endpoint roles.

For the fresh-profile setup pass, use a fresh macOS user account, do not seed away onboarding,
and do not preinstall the plug-in or helper being tested. Separately report steady-state
passes that do seed installation, naming the surfaces they cannot observe. Record actual
OS/hardware/app versions and every unverified platform. The milestone report follows
`docs/milestones/` rules: criteria, p50/p95, hardware/models, failures, skipped work and
accepted gaps. No generic green verdict substitutes for A1–A14.

## Merging into main

On a continue decision, one pull request merges `exp/virtual-audio` into `main`. Its verdict:

- reruns Stage 1 on the merge result and the macOS instrument on a bundle built from it;
- states which Linux surfaces the branch touched and whether Linux Stage 2 reached them. With
  no Linux machine available that is a named gap, and under ADR 0022 it blocks until the
  product owner or an issue accepts it;
- names Windows and Linux runtime as not proven, and states that nothing is notarized or
  distributable;
- lists the machine-wide components the merged code can install and how they are removed.

A stop or revise decision leaves the branch unmerged; the milestone report and the ADRs go to
`main` as documentation.

## Documentation review status

A `gopnik-critic` review of an earlier draft was reported on 2026-10-28, covering the healthy
baseline's treatment of reported gaps, A13's labelled transcription from both directions, and
mute applying only to owned buffers. No verdict is linked from this repository; it is posted
to the umbrella issue in step 0 or the review is rerun there. The revision of 2026-10-28
(macOS-only, no Developer ID, experiment branch, loopback check, on-demand microphone, A14,
split A3 oracle, segmented models only, macOS verification instrument) has not been reviewed.
Implementation and runtime verification have not started.

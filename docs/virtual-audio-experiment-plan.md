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
[ADR 0033](decisions/0033-the-virtual-audio-experiment-is-built-on-macos.md) records them, also
sets aside ADR 0008 decision 5 for the experiment's own latency numbers, and the always-loaded
rules, `platform-code.md` and `docs/development-workflow.md` carry the exception.

### Branches and worktree

- The experiment branch is `exp/virtual-audio`, branched from `main` in a separate managed
  worktree. Record the worktree path and branch in the umbrella issue. Do not implement the
  experiment in the primary checkout.
- Each work item is a short-lived branch from `exp/virtual-audio` and a pull request into
  it, with the full cycle: issue → critic → approved design → Stage 0 matrix →
  implementation → gopnik → READY → merge by engineering. `test.yml` runs on every pull
  request, so Linux Stage 1 holds on the experiment branch as it does on `main`.
- GitHub's closing keywords act only on merges into the default branch (its documentation;
  not tested here). A pull request into `exp/virtual-audio` therefore says `Refs #N`, and
  engineering closes the step issue by hand after the merge, with a comment linking the merge
  commit and the verdict.
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
| 0 | Umbrella issue, ADR and worktree; no dependency | Umbrella issue #273 with macOS-only scope, deferred Linux/Windows, thresholds A1–A14 inlined, owed assertions and an accepted critic verdict. ADR 0033 and the rule exceptions merged to `main`. Experiment branch and worktree created from that `main` and recorded in #273. |
| 1 | Loopback usefulness check; after step 0 | See "Step 1: loopback usefulness check". Precondition run first; then the product owner's calls; **go/no-go** recorded on #273. Third-party devices removed and the removal shown by census. No code merged anywhere. |
| 2 | macOS verification instrument and protocol freeze; after step 1 go | The Stage 2 that every later step needs, and the frozen protocol (see "macOS verification instrument"). Exit: one recorded run on the development Mac in which each oracle is shown red by a deliberate fault and green without it, and #273 carries the control table with its count, the rig and the matching rules. No product code. |
| 3 | HAL plug-in and helper feasibility spike; after step 2 | Two public devices plus private bridge from a locally built plug-in; a launchd helper forwarding real bidirectional PCM; distinct markers recovered at an independent peer. First observations: whether `coreaudiod` loads the ad-hoc or self-signed plug-in, whether TCC keeps the helper's microphone grant across rebuilds, and on-demand opening from `StartIO`/`StopIO`. Install, restart and removal recorded. A1/A2/A14 preliminary, against the frozen protocol. |
| 4 | Backend decision; after step 3 | New ADR: plug-in source (owned versus reused, licence), bridge transport, helper launch mechanism and code identity, clock/rate-conversion strategy, shared-state ownership. |
| 5 | Setup/settings/tray design; after step 0, using step 3 constraints | Approved committed prototypes for setup (including the administrator install step and its audio interruption), physical selectors, health, mute, recording and repair; failure/missing-device/quit states included. A12 requirement debts linked. Can overlap step 4. |
| 6 | Routing helper and endpoint lifecycle; after step 4 | Idempotent install detection and reconciliation, exclusive ownership, stable identities, physical selection, on-demand device opening, mute, client-independent forwarding, teardown. Locally built bundle runs without STT. A1/A4/A5/A8/A11/A14. |
| 7 | Device switching and recovery; after step 6 | Transactional replacement, loop prevention, hotplug state, sample-rate changes by clients, sleep/wake and `coreaudiod` restart recovery, truthful failure state. A7/A8/A10; validate both directions independently. |
| 8 | Recording integration; after steps 6/7 | Proxy capture adapter, process tap disabled in proxy mode, split durable tracks/shared timestamps, mixed playback compatibility, segmented models only, explicit completeness/gaps and labelled transcript output. A3/A6/A9/A10/A12/A13. |
| 9 | Setup, settings and tray controls; after steps 5/7, recording controls after step 8 | First-run enablement, install/permission detection, actual signal tests, route selectors, persistent preferences, mute, recording, status, quit/repair/removal instructions. State agrees across surfaces. A1/A7/A9/A11/A12. |
| 10 | Experiment qualification; after steps 8/9 | Locally built bundle on a fresh macOS user account, with no Backchannel component installed machine-wide (census of `/Library/Audio/Plug-Ins/HAL/` and `launchctl` before the run; third-party plug-ins listed as sentinels). Native/browser compatibility matrix, one-hour duplex test, all controls and failure injections, milestone report with pass/fail and explicit gaps for A1–A14. |
| 11 | Product experiment decision; after step 10 | Continue/revise/stop on measured results and setup feedback, recorded on #273 (see "Outcomes"). On continue: one pull request from `exp/virtual-audio` into `main` with its own gopnik verdict (see "Merging into main"). No release without the product owner's authorization. |

Steps are work packages, not necessarily one PR each. Keep PRs independently reviewable;
do not present intermediate incomplete flows as supported functionality. An output-only
spike does not settle the full-duplex umbrella issue. No calendar estimate is asserted
before the spike establishes the plug-in, helper and installation work.

## Step 1: loopback usefulness check

The question is the hypothesis's first half only: does an explicit route — choosing a
Backchannel-like microphone and speaker in the calling app — make setup and recording boundaries
easier to understand than passive capture? It cannot say anything about latency, reliability or
the final setup flow, and a borrowed setup is clumsier than the product would be, so a no-go is
weighed with that in mind and its reasons recorded.

- **Precondition run.** The current application on macOS records a *selected* loopback input as
  the microphone and a *selected* loopback device as system audio. The default macOS backend
  (`CoreAudio`) sends system audio to the global tap whatever device is chosen
  (`audio/stream.rs:41`), so this needs the non-default backend setting and the cpal path, which
  has never run on macOS. Record the setting, the devices and a short recording in which a known
  phrase on each side lands in the right channel. If the path fails, that is reported as an
  application defect with its own issue, not as a no-go.
- **Calls.** At least three real calls by the product owner: at least one native client and one
  browser client, each also recorded with passive capture on the same Mac for comparison.
- **The question asked**, answered on #273 with reasons: is the explicit route worth its setup
  cost compared with passive capture, yes or no.
- **The forwarder** is a throwaway tool built in the experiment worktree under `experiments/`,
  never merged and outside the cycle because nothing ships from it. Its source is attached to the
  step 1 issue so the result can be reproduced.
- **Cleanup.** Third-party loopback devices are removed afterwards and the HAL directory census
  shown, so step 3 starts with only the sentinel plug-ins present.

## macOS verification instrument

The existing Stage 2 cannot run on macOS: it locates an AppImage, drives the UI through
`tauri-driver` (which does not support WKWebView), reads the accessibility tree through
`orca-ide` over AT-SPI, feeds audio through a PipeWire harness, and emulates the minimum
machine with `systemd-run`. Step 2 provides the macOS counterparts, through `gopnik-setup`
so they are recorded in `gopnik.json` and not guessed:

- **Artifact.** A locally built `.app` whose revision is bound the way `stage2-locate-app.sh`
  binds the AppImage (a `.built-from` file), so a stale bundle is refused.
- **UI driving.** The macOS accessibility API or computer-use, with the #160 rules: a refused
  interaction is a failure, every wait names something false in the state being left, and
  state is asserted after the interaction rather than its return value.
- **Environment record.** `scripts/environment-record.sh` gains macOS keys: OS version and
  build, architecture, plug-in and helper versions and signing identity, microphone TCC state
  for the helper, and the physical devices in use (ADR 0019).
- **Test rig.** Frozen on #273 at the end of step 2: which device is the independent peer (a
  second machine or phone, or a local WebRTC loopback), the physical loop from an output to an
  input used for the latency baseline, where outgoing markers enter for A3 (a cabled loop into
  the physical microphone input, or a separate virtual input standing in for it, stated as
  such), and the headphones, microphone, speakers and Bluetooth headset used.
- **Marker detector.** Generated timed PCM markers with a codec-tolerant detector. Before any
  threshold is judged, its timing error is measured against a known inserted delay and must
  have p95 at most 5 ms; its false-match and miss rate on a marker-free and a marker-only
  recording are stated.
- **Sample counts.** Every p95 states its N. The one-hour runs carry at least 300 markers per
  direction; switching and mute p95s carry at least 30 trials each.
- **Shared reference for A5.** One generator emits paired markers into both directions with a
  logged host-time offset; alignment is the recorded offset minus the emitted offset. The
  mechanism is fixed at step 2 and its own error stated.
- **Control table.** Every condition in the table under "Verification protocol and negative
  controls" expanded to one control, numbered, with the total, posted to #273.
- **Protocol freeze.** Metrics, thresholds, matching rules and the rig are frozen on #273 at the
  end of step 2. Step 3's spike reports against them; changing them later is a scope change.
- **Latency budget.** ADR 0008's `systemd-run` emulation has no macOS equivalent and ADR 0033
  decision 7 sets it aside for these numbers. The record names the machine and every report says
  the numbers are not from the minimum machine.

## Platform investigations

**macOS, required for the experiment.** Compare a plug-in built from Apple's NullAudio sample
or libASPL with an existing component, under the licence constraint in the specification.
Prove both endpoint roles, private bridge access, stable UIDs, physical routing, on-demand
opening and installation on the development Mac. The plug-in is built universal, but only arm64
can be run here; x86_64 is named as unverified. Resolve without a Developer ID: plug-in
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

## Outcomes

| Outcome | Action on #273 |
| --- | --- |
| No-go at step 1 | Decision and reasons commented; closed as a negative result. No driver work starts. The branch carries no product code and is deleted; the step 1 report goes to `main` as documentation. |
| Plug-in or helper refused at step 3 (`coreaudiod` or TCC without a Developer ID) | Observation commented; the product owner decides stop (closed as negative) or revise (a new product decision, for example a Developer ID, recorded in a new ADR before work resumes). |
| A criterion fails at step 10 | Report linked; the product owner decides revise (named criteria reopened as step issues, #273 stays open) or stop (closed as negative, branch not merged). |
| Continue at step 11 | The merge pull request into `main` says `Closes #273` and links the qualification report and its verdict. |

## Owed assertions

Instructions that remove, forbid or hide something ship with a test that fails while the thing is
present (ADR 0023). Owed, with the step that pays each:

| Instruction | Paid by |
| --- | --- |
| Process tap not started in proxy mode | 8 (Stage 1) |
| No streaming model offered in proxy mode | 8, 9 (A12) |
| Physical microphone closed while no client reads Backchannel Microphone | 6 (A14) |
| OS and communication defaults unchanged by setup | 6, 9 (A1) |
| Private bridge side absent from client device pickers | 3, 6 (A1) |
| OTHERS never routed into the virtual microphone | 6 (A6) |
| Local microphone monitoring off | 6 |
| Directions never combined before the split-transcription boundary | 8 (A13) |
| No silent fallback to passive capture or another microphone | 7, 8 (A7, A12) |
| No silent redirect of playback to laptop speakers | 7 (A7) |
| Backchannel endpoints excluded from physical selectors | 6, 9 |
| Removal never touches third-party devices or recordings | 6 (A11) |
| `coreaudiod` never restarted while an endpoint is in use | 6, 9 (A11) |

Thirteen in total, counted by hand from the specification.

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

The critic's round-1 verdict on #273 (2026-10-28) was REVISE, with findings F1–F8; this revision
answers them. A gopnik-critic review of an earlier draft was reported in conversation on the same
day and has no linked verdict. Implementation and runtime verification have not started.

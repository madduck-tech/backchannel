# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-foundation-conversationaly-fork.md) | Foundation: hard fork of Conversationaly at `madduck-tech/backchannel` | accepted |
| [0002](0002-stt-russian-recommendation.md) | STT for Russian: catalog as is, recommendation by meeting language | accepted |
| [0003](0003-two-stt-streams-resource-budget.md) | Two STT streams: model instances and resource budget | accepted |
| [0004](0004-echo-cancellation-scope.md) | Echo: no AEC in the MVP, speaker warning, gate if time permits | accepted |
| [0005](0005-platform-support-tiers.md) | Platform support tiers; development on Linux only | accepted; decision 2 superseded by 0015 |
| [0006](0006-proactive-mode-design.md) | Proactive mode: mechanics of the intervention levels | accepted |
| [0007](0007-observation-schema-versioning.md) | Versioning of the observation schema | accepted |
| [0008](0008-latency-targets.md) | Latency targets for Milestone 0 and how to measure them | accepted; decision 3's drop-cap criterion superseded by 0027; decision 5 set aside by 0033 for the virtual audio experiment |
| [0009](0009-positioning-share-protection.md) | Positioning: share protection, not stealth | accepted |
| [0010](0010-project-language-english.md) | The project language is English | accepted |
| [0011](0011-design-system-package-and-opendesign.md) | Design system as a repository package; OpenDesign for prototyping | accepted |
| [0012](0012-development-workflow.md) | Development workflow: approval gates, conventions | partly superseded by 0013; decision 1 set aside by 0033 for the virtual audio experiment |
| [0013](0013-single-cycle-with-gopnik.md) | One cycle: issue → critic → design → implementation → gopnik gate → PR | accepted; merge gate superseded by 0014 |
| [0014](0014-product-owner-and-engineering-roles.md) | Product owner and engineering: engineering merges on READY; product gates only | accepted |
| [0015](0015-linux-system-audio-via-cpal-pulseaudio-host.md) | Linux system audio through cpal's PulseAudio host, not a new capture path | accepted; supersedes decision 2 of 0005 |
| [0016](0016-quality-cycle-tests-and-red-first.md) | The quality cycle: a change ships with the test that would have caught it | accepted; extends 0013 |
| [0017](0017-deny-rustc-warnings.md) | rustc warnings are denied, and the deny is held in place | accepted; supersedes 0016's "no lint in CI" for Rust |
| [0018](0018-adopt-clippy.md) | clippy is adopted, and every allow says what it would cost to fix | accepted; completes 0017, supersedes 0016's "no lint in CI" in full |
| [0019](0019-record-the-verification-environment.md) | A verification result carries the environment that produced it | accepted |
| [0020](0020-no-updater-artifacts-without-an-identity.md) | No updater artifacts until this fork owns an updater identity | accepted |
| [0021](0021-carry-the-capture-channel-by-time-overlap.md) | Carry the capture channel across a re-segmentation by time overlap | accepted |
| [0022](0022-a-check-that-skips-the-change-is-not-evidence.md) | A check that skips the change is not evidence | accepted |
| [0023](0023-an-instruction-to-remove-ships-as-a-test.md) | An instruction to remove something ships as a test that fails while it is there | accepted |
| [0024](0024-an-approved-design-nobody-built-is-a-defect.md) | An approved design nobody built is a defect, and "out of scope" is an issue or it is nothing | accepted |
| [0025](0025-the-engine-moves-with-its-weights-copied.md) | transcribe.cpp 0.4.1 is adopted with its weights copied, and with upstream's ITN default but one | accepted |
| [0026](0026-a-capped-stream-is-decoded-in-segments.md) | A stream with a length cap is decoded in segments | accepted |
| [0027](0027-a-live-path-that-falls-behind-is-warned-about-not-trimmed.md) | A live path that falls behind is warned about, never trimmed | accepted; supersedes the drop-cap wording of 0008 decision 3 |
| [0028](0028-an-agent-cli-writes-a-summary-with-no-tools.md) | An agent CLI writes a summary with its tools off, and a tool event discards it | accepted |
| [0029](0029-backchannel-has-its-own-identity.md) | Backchannel has its own identity, and the old name stays only where it is not seen | accepted |
| [0030](0030-every-model-is-offered-and-shows-its-licence.md) | Every model is offered, and shows its licence | accepted |
| [0031](0031-every-release-has-one-shape.md) | Every release has one shape: the same files, a written description, published on the product owner's word | accepted |
| [0032](0032-one-source-for-every-agent-harness.md) | One source of agent instructions for every harness, under Codex's cap | accepted |
| [0033](0033-the-virtual-audio-experiment-is-built-on-macos.md) | The virtual audio experiment is built on macOS, signed locally, on a branch of its own | accepted; supersedes 0005 decision 5, 0008 decision 5 and 0012 decision 1 for that experiment only |
| [0033](0033-the-pulseaudio-cookie-is-computed-in-memory.md) | The PulseAudio cookie is computed in memory, by a fork of the `pulseaudio` crate patched at the workspace root | accepted |

## Deferred questions

- **Embeddings in the MVP.** Knowledge requires indexing, so a default embedding model is needed even if the user
  never sees it. The spec defers the embeddings choice (§18). Deferred on 2026-09-01: revisit when designing Knowledge/RAG.

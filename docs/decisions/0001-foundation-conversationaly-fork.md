# ADR 0001: Application foundation — hard fork of Conversationaly

Date: 2026-09-01
Status: accepted

## Context

The product spec (§32–35) requires not writing desktop/audio/STT plumbing from scratch: take an existing
open-source meeting stack and build the agent-platform layer on top of it.
Candidates evaluated on 2026-09-01: Conversationaly, Meetily, Project Raven, NexQ, Vexa Desktop.

## Decision

The base is a **hard fork of `bykof/conversationaly`** (MIT).
Created on 2026-09-01 as a GitHub fork in the `madduck-tech` organization: https://github.com/madduck-tech/backchannel
(branch `main`, public). We do not fork Meetily directly. Raven, NexQ and Vexa Desktop are used as references only.

## Why

- Conversationaly is itself a hard fork of Meetily (`Zackriya-Solutions/meeting-minutes`, MIT) from 2026-06-05,
  diverged by ~58k deleted lines. The Python backend, paid licensing, telemetry and duplicate STT engines are
  already removed. Pulling Meetily upstream back in is unrealistic anyway.
- A single STT runtime, transcribe.cpp (MIT, GGUF on ggml), with a catalog of ~85 models including
  `nemotron-3.5-asr-streaming-0.6b` (streaming, `ru-RU` in its metadata) and GigaAM v3.
- Bundled llama.cpp sidecar, SQLite via sqlx with migrations, CI for macOS/Windows/Linux,
  Metal/CUDA/Vulkan/ROCm builds, VAD, noise suppression, device and permission handling.
- The whole license chain is MIT: Conversationaly → Meetily, transcribe.cpp, llama.cpp.

## What the foundation does NOT provide (our work)

- Microphone and system audio are mixed before STT (`pipeline.rs`). Separate YOU/OTHERS streams must be built by us.
- transcribe.cpp allows one active session per loaded model: two streams = two loaded models.
- No overlay, content protection or hotkeys.
- The LLM is used only after the meeting; there is no realtime loop.
- No echo cancellation, RAG, MCP or agents.
- Linux system audio relies on a heuristic search for PulseAudio `monitor` sources via cpal/ALSA.

## Risks

- Bus factor of 1 for both Conversationaly and transcribe.cpp. Pin revisions; vendor if needed.
- Conversationaly is three weeks old (first fork commit 2026-08-06) and may be abandoned. Acceptable for a hard fork.

## Reference projects

- `Laxcorp-Research/project-raven` (MIT, Electron): dual YOU/THEM streams, WebRTC AEC3 + residual echo gate,
  content-protected overlay, meeting detection by window titles, local RAG, "ask across meetings".
- `naxhq/NexQ` (MIT, Tauri): overlay window configuration in Tauri, dual-party capture in Rust. Windows only.
- `Vexa-ai/vexa-desktop` (MIT/Apache-2): per-OS audio capture table. Low value.

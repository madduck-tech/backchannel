---
paths:
  - "frontend/src-tauri/src/audio/**"
  - "frontend/src-tauri/src/transcribe_engine/**"
  - "frontend/src-tauri/src/capture/**"
  - "llama-helper/**"
  - "frontend/src-tauri/Cargo.toml"
---
# Audio, transcription and runtime rules

Decisions that govern this code: ADR 0002 (STT for Russian), 0003 (two STT streams), 0004 (echo),
0005 (platform tiers), 0006 (proactive mode), 0008 (latency).

- Changes here always go through a pull request; they are never pushed straight to `main`.
- Development happens on Linux only. macOS and Windows paths are written blind: mark them
  `// UNVERIFIED on <platform>` and say so in the PR. Do not claim they work.
- Microphone and system audio are separate streams (YOU / OTHERS) from capture to STT. Never mix
  them before transcription. Batch models share one instance: `Error::Busy` forbids concurrent
  compute on a `Model`, not serial use, so the two channels take turns through one session with a
  VAD and a queue each. Streaming models still need one instance per channel, which
  `TranscribeEngine`'s single `Model` slot cannot express — until it can, that path alone is fed
  the two channels summed (`transcription/adapters/summed.rs`) and its rows carry no channel. That
  is the one exception, it is written down where it lives, and it ends when the engine can hold two.
- STT must keep up with realtime. Dropping audio when behind is not acceptable for the copilot;
  surface backlog as a warning and a metric instead.
- Keep the transcription layer a port with adapters (`audio/transcription/ports.rs`); logic there
  gets unit tests with fake sinks, not integration-only coverage.
- The LLM context for realtime assistance is incremental: never rebuild the whole prompt per
  evaluation once the persistent-context path exists.
- Linux system audio goes through cpal's optional `pulseaudio` host (ADR 0015, superseding
  decision 2 of ADR 0005 — the `pulseaudio` crate is pure Rust, so this added no system
  dependency). Monitors are classified by the device **id** ending `.monitor`, never by matching
  "monitor" in a description: the descriptions read "Monitor of ..." and the old check was
  case-sensitive, so it matched none of them.
- Pin git dependencies to a revision; a new crate is called out with its license.
- Latency work is measured on the emulated minimum machine
  (`systemd-run --user -p CPUQuota=400% -p MemoryMax=8G`) with the six timestamps from ADR 0008.

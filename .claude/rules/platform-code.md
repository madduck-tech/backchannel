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
  them before transcription. Streaming models get one instance per channel; batch models share one
  instance through a queue.
- STT must keep up with realtime. Dropping audio when behind is not acceptable for the copilot;
  surface backlog as a warning and a metric instead.
- Keep the transcription layer a port with adapters (`audio/transcription/ports.rs`); logic there
  gets unit tests with fake sinks, not integration-only coverage.
- The LLM context for realtime assistance is incremental: never rebuild the whole prompt per
  evaluation once the persistent-context path exists.
- Linux system audio goes through the PulseAudio protocol (`libpulse-binding` via pipewire-pulse),
  not through cpal/ALSA `monitor` name matching.
- Pin git dependencies to a revision; a new crate is called out with its license.
- Latency work is measured on the emulated minimum machine
  (`systemd-run --user -p CPUQuota=400% -p MemoryMax=8G`) with the six timestamps from ADR 0008.

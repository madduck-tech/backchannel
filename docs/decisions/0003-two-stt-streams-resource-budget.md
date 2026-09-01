# ADR 0003: Two STT streams — model instance allocation and resource budget

Date: 2026-09-01
Status: accepted

## Context

The spec requires separate processing of microphone and system audio before STT (§10, §38, Milestone 0 items 4–5).
Concern: two local STT engines in realtime plus a local LLM on a single laptop.

Facts (2026-09-01):

- People speak in turns: total seconds of speech across the two channels equal the seconds on the mixed stream.
  Each channel has its own Silero VAD; silence is not transcribed. Compute does not double.
- transcribe.cpp allows one active session (stream or run) per loaded model.
- In the fork the transcription layer is a `Transcriber` port with `streaming` and `segmented` adapters
  (`frontend/src-tauri/src/audio/transcription/`); `TranscriptChunk` already has a `speaker` field.
- Memory: Nemotron 3.5 Q8 = 716 MB per instance; GigaAM v3 Q8 = 261 MB; Gemma 4 E2B ≈ 3.6 GiB, E4B ≈ 5.3 GiB.
- Nemotron Q8 speed on a Ryzen 7 4750U: CPU 8× realtime, Vulkan 14×.
- The fork's batch path drops old audio once more than 30 s behind; the streaming path has no cap.
- The fork has a `HardwareProfile` (cores, GPU type, memory, performance tier).

## Decision

1. **Streaming models**: one model instance per channel (YOU and OTHERS). Memory ×2.
2. **Batch models** (including GigaAM, the Russian default per ADR 0002): one instance serves both channels
   through a shared segment queue. Memory ×1.
3. **The recommendation engine** (§19) computes the budget as OS reserve + LLM + STT × k + headroom,
   where k = 2 for streaming and 1 for batch. Extend the existing `HardwareProfile`; do not write a new scanner.
4. **Minimum target machine for the MVP**: 8 GB RAM, no discrete GPU. On it the Master recommends
   GigaAM + Gemma 4 E2B or a cloud LLM. Nemotron ×2 + local LLM is tagged "16 GB".
5. **Milestone 0** gains a measurement: two channels + local LLM on the minimum machine;
   STT does not fall behind realtime while the LLM processes a prompt. Dropping audio when behind is disabled for the copilot.

## Consequences

- The main resource risk is not memory but CPU contention between STT and a local LLM in proactive mode.
  Mitigations: llama-helper is a separate process, so lower its priority and cap its threads; STT gets priority.
  Verified by the measurement in item 5, not by design.

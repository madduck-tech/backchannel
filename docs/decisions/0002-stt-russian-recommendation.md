# ADR 0002: STT for Russian — catalog as is, recommendation by meeting language

Date: 2026-09-01
Status: accepted

## Context

The spec requires Russian, streaming, local operation and a small STT model (§40) and names
Nemotron 3.5 ASR Streaming 0.6B as the primary candidate. Milestone 0 (§36, item 3) framed the risk as
"does Nemotron or another suitable streaming STT work".

Verified on 2026-09-01 from the model cards (transcribe.cpp and NVIDIA):

- Nemotron 3.5 already runs through transcribe.cpp (GGUF on ggml, Metal/CUDA/Vulkan/ROCm/CPU).
  The "how to run NeMo from Rust on three OSes" risk is removed by the foundation (ADR 0001).
- Russian is in the "transcription-ready" tier. WER on FLEURS ru with the language given:
  10.84 (80 ms chunk), 9.87 (320 ms), 9.17 (1.12 s). Q8_0 = 716 MB. License: OpenMDW-1.1.
- GigaAM v3 (ai-sage, Sber) is in the same catalog. e2e-rnnt: WER 5.36 on FLEURS ru, Q8_0 = 261 MB.
  Russian only, batch only (segments up to 25 s). Conversationaly already runs batch models live
  via VAD segmentation (segments up to 8 s); text arrives per phrase after a pause.

## Decision

1. **Model list** — the transcribe.cpp catalog as is; the user picks any model. No extra work.
2. **The recommendation depends on the meeting language.** The Setup Master asks for it on first launch.
   - Russian: `Recommended` = `gigaam-v3-e2e-rnnt`; `nemotron-3.5-asr-streaming-0.6b-q8` is tagged `Streaming`.
   - English: Conversationaly's default stays, `parakeet-tdt-0.6b-v3-q8`.
3. **Basis for the markers** — FLEURS numbers from the model cards. A benchmark on real recordings
   is not part of Milestone 0; do it later only if we want to refine the markers.
4. **Mixed speech (Russian with English terms) is out of scope for the MVP** and not optimized for.
5. **Milestone 0, item 3** is reworded: both paths work in the split YOU/OTHERS pipeline —
   streaming (Nemotron) and VAD-segmented (GigaAM). Both paths exist in Conversationaly, but on the mixed stream.

## Consequences

- Word-by-word streaming is no longer mandatory: copilot hints are computed on completed phrases,
  and the transcript is not the primary UI per the spec (§9–10).
- The GigaAM v3 license was not checked; verify before release.

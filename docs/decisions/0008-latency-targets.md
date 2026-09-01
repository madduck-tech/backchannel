# ADR 0008: Latency targets for Milestone 0 and how to measure them

Date: 2026-09-01
Status: accepted

## Context

Milestone 0 (§36, item 8) requires "an answer with acceptable latency" without a number. A hint older than
~10 s in a live conversation is useless. In the fork VAD closes a segment after 2000 ms of silence
(`redemption_time`) — right for recording, dead delay for a copilot.

Estimated chain for a proactive hint (Russian default, GigaAM, incremental LLM context per ADR 0006),
from end of phrase to overlay:

| Stage | Cloud LLM | Local LLM, GPU | Local LLM, CPU |
|---|---|---|---|
| VAD closes the segment | 0.7 s | 0.7 s | 0.7 s |
| STT decodes the segment | 0.5 s | 0.5 s | 0.5 s |
| LLM: prompt delta + JSON of ~60 tokens | 1.5 s | 1.5 s | 5 s |
| Total | ~3 s | ~3 s | ~6–7 s |

## Decision

1. **VAD in meeting mode:** `redemption_time` = 700 ms (instead of 2000). Phrase splitting is acceptable;
   the transcript is merged at the text level.
2. **The overlay streams answer tokens**; perceived latency equals the first token.
3. **Milestone 0 criteria, p95 on the minimum machine (ADR 0003: 4 cores, 8 GB, no GPU):**
   - Reactive answer via hotkey: first token ≤ 2 s; full answer ≤ 4 s (cloud) / ≤ 6 s (local CPU).
   - Proactive hint at Medium: end of phrase → screen ≤ 4 s (cloud or GPU) / ≤ 8 s (local CPU).
   - Transcript: streaming partial text ≤ 1 s; committed segment ≤ 2 s after end of speech.
   - STT keeps up with realtime: backlog ≤ 5 s p95; the 30 s drop cap is never reached.
4. **Measurement.** Six timestamps per event: audio in, VAD closed, STT committed, LLM requested,
   first token, overlay painted. Event log; Milestone 0 report with p50/p95.
5. **Emulating the minimum machine** on the development machine (16 cores, 30 GB):
   `systemd-run --user -p CPUQuota=400% -p MemoryMax=8G`. Numbers without the limit are not accepted.

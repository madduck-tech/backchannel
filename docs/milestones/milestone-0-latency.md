# Milestone 0 — transcript latency, first measurement

Date: 2026-09-06. First numbers this repository has ever had for ADR 0008, which set its criteria on
2026-09-01.

## What was measured, and with what

| | |
|---|---|
| machine | 16 cores, 30 GB, Ubuntu 24.04.4, kernel 7.0.0-31-generic, PipeWire 1.0.5 |
| limit | `systemd-run --user --scope -p CPUQuota=400% -p MemoryMax=8G` — ADR 0008 decision 5 |
| model | `parakeet-tdt-0.6b-v3-Q8_0` (the catalog default), CPU only, no BLAS |
| decode path | **segmented** (VAD + batch). `transcription/mod.rs:85` branches on `Capabilities::supports_streaming`; this model is batch-only |
| audio | `scripts/audio-harness.sh`, a PipeWire virtual source looping the JFK sample at −2.1 dB peak |
| driver | `scripts/stage2-record-check.sh` against the built AppImage on a clean profile |
| build | AppImage from `main` at the commit that added `audio/latency.rs` |

The recording ran **250 s** and produced 34 transcript segments. The transcript is correct — *"Ask
not what your country can do for you, ask what you can do for your country."*

## The numbers

`lag_ms` per commit, nearest-rank percentiles (the definition `audio/latency.rs` states):

```
n=16  min=-1687  p50=-1575  p95=-1360  max=-1360   (milliseconds)
```

**Read the sign before reading the value.** `bench_sink.rs:125` computes
`elapsed_since_first_sample - audio_end_seconds`, and its own comment says negative is meaningful:
the decoder's audio position runs *ahead* of the clock measured from the first sample fed. So the
transcript is not late; it is consistently ~1.5 s ahead of that reference.

**What is not explained, and is not claimed:** the offset is *constant* across the whole run
(−1.36 s to −1.69 s over 250 s, no drift). The code's explanation — a decoder chewing through an
initial backlog — predicts an offset that *shrinks*. A steady offset instead suggests the audio clock
and `BenchSink::started` differ by a fixed startup gap. **So the absolute value is not "how late the
text is" and must not be read as one.** What this run does establish is that it **does not drift**
over four minutes, which is the property ADR 0008 decision 3's *"backlog ≤ 5 s p95"* is really about.

## Three things this report cannot do, named rather than left out

**1. `n=16` is a sample of the throttle, not of the recording.** `BenchSink` logs one line per 15 s.
The in-memory collection added alongside `audio/latency.rs` holds every lag and emits a
`BENCH SUMMARY` — **and it did not fire.** The summary is on `Drop`, and `stage2-record-check.sh`
kills the application, so `Drop` never runs. The numbers above were recovered from the throttled log
lines, which is the exact thing that change was written to avoid. **Follow-up: the summary needs an
explicit end-of-recording call, not a destructor.**

**2. The unlimited comparison is not comparable.** A second run without the `systemd-run` limit
passed the transcript check and stopped at the first match, so it produced **one** BENCH line
(−2214 ms) over a much shorter recording. One sample against sixteen, at different recording lengths,
is not a comparison and is not presented as one. Repeating it with a fixed duration is outstanding.

**3. Three of ADR 0008's six timestamps do not exist.** Decision 4 asks for audio in, VAD closed, STT
committed, LLM requested, first token, overlay painted. The last three need the proactive overlay of
ADR 0006: `grep -ri proactive frontend/src frontend/src-tauri/src` → **0**. Nothing here averages over
half a chain.

## Against ADR 0008's criteria

| criterion | status |
|---|---|
| transcript: streaming partial ≤ 1 s | **not measured** — the segmented path emits no partials, by construction |
| transcript: committed segment ≤ 2 s after end of speech | **not measured as stated.** `lag_ms` is measured against the first sample fed, not against end of speech; the two differ by the constant offset above |
| STT keeps up: backlog ≤ 5 s p95, 30 s drop cap never reached | **holds** — no drift over 250 s, no backlog warning in the log |
| reactive answer via hotkey | ⛔ needs ADR 0006 |
| proactive hint at Medium | ⛔ needs ADR 0006 |

## And this is not a check

No hosted runner has an audio device or the 1.2 GB of models a decode needs. A regression here is
visible by **comparing two of these reports, by a person**, and never by a job going red. #65 says so
and this report repeats it so no reader mistakes a number for a gate.

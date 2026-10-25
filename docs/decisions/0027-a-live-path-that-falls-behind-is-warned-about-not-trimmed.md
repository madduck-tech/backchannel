# 0027 — A live path that falls behind is warned about, never trimmed

Date: 2026-10-25
Status: accepted (supersedes the last criterion of ADR 0008 decision 3, "the 30 s drop cap is never reached": there is no drop cap)

## Context

The VAD + batch live path carried a 30 s backlog cap that dropped the oldest speech once a model fell that far behind. Read from source in #209, the cap could not fire:
- `SegmentedTranscriber::feed` decoded every queued segment before it returned;
- so its queue never held more than one window's segment;
- the backlog waited instead in the unbounded channel that feeds the service.

The warning that does exist, `BenchSink`'s, was switched on only for the stream path. The reason given was that the batch path "already warns when its backlog cap starts dropping audio", and that was untrue.

`BenchSink` also measured lag on the wall clock. While a recording is paused nothing is sent, so the audio clock stops and the wall clock does not. A healthy model's first row after a long pause therefore read as that far behind, and the one warning was spent on it.

ADR 0003 decision 5 already forbids dropping audio when behind. So does `.claude/rules/platform-code.md`, which says to surface backlog "as a warning and a metric instead".

## Decision

1. **No live path drops audio for being behind.** The cap, its warning and its tests are removed.
2. **Lag is read on the audio sent**, through the transcription channel's own clock (`audio::transcription::sent_clock`). The sending half advances it by one channel's samples per mixing window, the clock `audio_end` is on. A pause stops it.
3. **Every live path warns once,** when its lag is 20 s past the first row's lag:
   - the stream path;
   - VAD + batch on a local model;
   - VAD + batch on the audio LLM.

   The first row's lag is excluded, so a model load or a sidecar warm-up does not count. Every figure reported (the toast, the `BENCH` line, ADR 0008's p95) is the absolute lag.

## Consequences

- A model slower than real time keeps every second of a meeting and arrives later and later. The person is told once, with the existing text: "Live transcription is about Ns behind what you are saying. Nothing is being lost, but the text will keep arriving late — pick a faster model in settings to close the gap."
- "Nothing is being lost" holds while recording. **It is not true past Stop's 600 s wait (#210)**: a backlog Stop cannot drain in ten minutes loses its rows. Whether to keep that sentence until #210 lands is the product owner's call.
- **The warning latches.** A spike that recovers spends it, and a later sustained lag in the same recording is not reported. Re-arming it would mean a second toast. `today_a_recovered_spike_spends_the_one_warning` documents this and is deleted if that changes.
- **A model slow from its first row is first reported late.** The baseline takes in the first decode's own slowness, so the toast first comes at the first row's lag plus 20 s. In #209's test, a decoder at 2× real time is first reported at about 44 s behind.
- **The toast now reaches the default model and the built-in Gemma.** On the built-in Gemma, "pick a faster model" may have nothing faster to offer. And the sidecar's 5-minute idle shutdown during a recording can spend the warning on a reload (#213).
- **A backlog costs memory.** It waits in the unbounded channel at 128 KB per second of backlog (2 channels × 16 kHz × f32). For a model at 1.4× real time with both sides speaking (`whisper-large-v3-turbo-q4` on #169's measurements), a 2-hour meeting is about 2000 s of backlog, about 260 MB. Stop cannot drain that within its 600 s (#210).
- ADR 0003's Context line ("the fork's batch path drops old audio once more than 30 s behind") described the fork as it was. It is left as written; this ADR records that the behaviour it describes is gone.

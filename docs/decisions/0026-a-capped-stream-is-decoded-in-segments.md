# 0026 — A stream with a length cap is decoded in segments

Date: 2026-10-25
Status: accepted

## Context

The live path used to pick the stream for every model whose GGUF says `supports_streaming`. One `transcribe_cpp::Stream` then stayed open for the whole meeting.

`moonshine_streaming` (tiny, small and medium) streams natively, and one of its rows, `moonshine-streaming-small-q8`, is among first run's four recommended models. Its stream has limits that a meeting runs past:

- one stream holds at most `max_audio_ms = 81 920` (4096 encoder frames). Past that, `stream_input_capped` returns at once and takes nothing more;
- every feed re-decodes everything heard so far, so a feed's cost grows with the meeting;
- its `committed_text` is best-effort upstream.

Measured on #200 (`controls-200`, tiny, four cores): a recording kept its first seconds. On `dots-full.wav` (305 s) the stream path committed 2 rows, the later starting at 1.2 s, a coverage of 0.002. Over the first 80 s, before the cap makes every feed return at once, feeds in 50–80 s cost 3.8× the feeds in 0–30 s, and feeding took 2.75 × the audio's length: the stream fell further behind with every second.

The same GGUF metadata also says whether a stream is capped, so the cap can be read where the path is chosen.

## Decision

1. **`audio::transcription::live_path`** chooses the live path from the loaded model's capabilities. It is the only function that chooses: a model streams only when `supports_streaming` is true **and** `max_audio_ms` is 0. Every other model, including one whose capabilities cannot be read, is decoded in VAD segments. The dictation probe uses the same function, so it times the path recording takes.
2. **The catalogue labels these rows as segment-by-segment.** `streaming` is false for the three `moonshine_streaming` rows (`CAPPED_STREAMS` in the generator). The speed labels, and the rows' place in the file, which Settings renders in order, keep reading the native streaming, because changing them was nobody's decision. The product owner chose to keep `moonshine-streaming-small-q8` in first run's four and to label it honestly. They also chose not to report this upstream and not to swap the recommended model in the meantime.
3. **`SEGMENTED_LIVE_RECOMMENDATIONS`** names the recommended live models that do not stream: the default and the three rows above. A batch row therefore cannot pick up the "Recommended" label by accident.

## Consequences

- These rows' live text arrives per segment (≈ 8 s), with no partials, and their rows carry a channel. They leave the stream path's lag warning behind: the segmented path has none that fires (#209). Measured on `dots-full.wav`, one channel, four cores:
  - tiny, small and medium keep 0.946, 0.950 and 0.950 of a per-30-s reference;
  - all three transcribe the sample's last 20 s;
  - they feed at 0.04, 0.09 and 0.13–0.14 × real time. The segmented path decodes each channel on its own, so a meeting with both sides speaking costs up to twice that.
- Voxtral Realtime reports a cap of 0 but has a wall of about 2.9 h, so it still streams. That is #204.
- A family that gains or loses a cap moves path with no code change here. Its catalogue label then disagrees with the rule until the generator is updated. `the_catalogue_label_agrees_with_the_path_rule`, an excused instrument run by name and not by the gate, turns red on that disagreement for every model in the measurement cache. On 2026-10-25 that was 22 rows, 6 of them streaming; Nemotron 3.5 and Parakeet Unified are not in the cache.

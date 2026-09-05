// The outside of the live-transcription hexagon.
//
// `streaming` and `segmented` are driving adapters: they own a decoding
// backend and satisfy `ports::Transcriber`. `summed` is a driving *decorator*:
// it satisfies the same port by summing the two capture channels for a backend
// that can only hold one stream open. `tauri_sink` is the driven adapter:
// it satisfies `ports::TranscriptSink` by emitting Tauri events. `bench_sink`
// is a driven *decorator*: it satisfies the same port by wrapping another sink
// and measuring what passes through.
//
// Nothing in `service` or `ports` imports from here — the dependency only ever
// points inward, which is what makes the use case testable with fakes.

pub mod bench_sink;
pub mod segmented;
pub mod streaming;
pub mod summed;
pub mod tauri_sink;

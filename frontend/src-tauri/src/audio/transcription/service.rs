// audio/transcription/service.rs
//
// The live-transcription use case, and the only place that knows the shape of a
// recording: audio arrives until it stops, then the decoder is drained, then
// the volatile text on screen is cleared.
//
// It compiles without Tauri, without transcribe.cpp and without an audio
// device, which is the point — every bug this module used to hide was in code
// that could only be exercised by holding a real meeting.

use super::ports::{Channel, Fatal, Transcriber, TranscriptSink};
use crate::audio::recording_state::DeviceType;
use crate::audio::AudioChunk;
use log::info;
use tokio::sync::mpsc::UnboundedReceiver;

/// Drive audio through a transcriber into a sink until the audio stops.
///
/// Blocking on purpose: every decoder behind [`Transcriber`] is a blocking
/// native call, so this runs on a blocking thread rather than holding an async
/// worker hostage.
pub fn run(
    mut transcriber: impl Transcriber,
    mut sink: impl TranscriptSink,
    mut audio: UnboundedReceiver<AudioChunk>,
) {
    let mut chunks = 0u64;
    let mut ended: Option<String> = None;

    while let Some(mut chunk) = audio.blocking_recv() {
        chunks += 1;
        // Still received after a fatal error, and dropped: the channel is unbounded, so leaving it
        // unread would hold the rest of the meeting's audio in memory.
        if ended.is_some() {
            continue;
        }
        // From v0.4.1 one NaN or Inf rejects the whole feed. Every live decoder is fed from here,
        // so this one call covers the stream, the VAD segments and the audio-LLM path.
        replace_non_finite(&mut chunk.data);
        // A failed chunk costs that audio, not the meeting's transcript. The
        // decoder is usually fine on the next one, and ending a recording's
        // transcript over one bad buffer is the worse failure by far.
        // The chunk's own capture channel, not a guess about its contents. The
        // pipeline forwards one chunk per channel per window and tags each with
        // the device it came from, so this is a reading, not an inference.
        let channel = match chunk.device_type {
            DeviceType::Microphone => Channel::You,
            DeviceType::System => Channel::Others,
        };
        if let Err(e) = transcriber.feed(channel, &chunk.data, &mut sink) {
            // A failed stream fails every later chunk the same way, and each warning is a toast.
            // Said once, and nothing more is fed. The recording itself is unaffected.
            if let Some(fatal) = e.downcast_ref::<Fatal>() {
                sink.warn(&fatal.to_string());
                ended = Some(fatal.to_string());
            } else {
                sink.warn(&e.to_string());
            }
        }
    }

    // Input ended: whatever the decoder is still holding is still owed to us. A failed stream holds
    // nothing, and finishing it would only fail again.
    if ended.is_none() {
        if let Err(e) = transcriber.finish(&mut sink) {
            sink.warn(&e.to_string());
        }
    }

    // Live text does not survive the stream that produced it. Clear it, or the
    // last half-formed phrase sits on screen looking like part of the meeting.
    sink.tentative("");

    match ended {
        Some(why) => info!("🎙️ Live transcription stopped after {chunks} audio chunks: {why}"),
        None => info!("🎙️ Live transcription ended after {chunks} audio chunks"),
    }
}

/// Replace every NaN and infinite sample with silence, and say how many there were.
///
/// transcribe.cpp v0.4.1 rejects a run or a feed holding any of them with `INVALID_ARG`, before
/// decoding anything. Silence is valid input, and one bad sample is worth losing; the chunk around it
/// is not. Import already does the same in its decoder. (#169)
pub fn replace_non_finite(samples: &mut [f32]) -> usize {
    let mut replaced = 0;
    for s in samples.iter_mut().filter(|s| !s.is_finite()) {
        *s = 0.0;
        replaced += 1;
    }
    replaced
}

// `pub(crate)` rather than private: `FakeSink` is the crate's one honest
// stand-in for the driven port, and `adapters/bench_sink.rs` needs exactly it
// to prove its decorator changes nothing. A second copy over there would be a
// second thing to keep in step with the port.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::audio::transcription::ports::TranscriptChunk;
    use anyhow::Result;

    /// What a sink was told. Shared, because `run` takes the sink by value.
    #[derive(Default)]
    pub(crate) struct Recorded {
        pub committed: Vec<String>,
        pub tentative: Vec<String>,
        pub warnings: Vec<String>,
    }

    #[derive(Default, Clone)]
    pub(crate) struct FakeSink(pub std::sync::Arc<std::sync::Mutex<Recorded>>);

    impl TranscriptSink for FakeSink {
        fn committed(&mut self, chunk: TranscriptChunk) {
            self.0.lock().unwrap().committed.push(chunk.text);
        }
        fn tentative(&mut self, text: &str) {
            self.0.lock().unwrap().tentative.push(text.to_string());
        }
        fn warn(&mut self, message: &str) {
            self.0.lock().unwrap().warnings.push(message.to_string());
        }
    }

    /// Emits one chunk per feed, optionally failing on a chosen call: with a transient error, or with
    /// [`Fatal`], as a stream that ended FAILED does (#169). What it was fed is shared, because `run`
    /// takes it by value.
    struct FakeTranscriber {
        fed: usize,
        fail_on: Option<usize>,
        fatal_on: Option<usize>,
        finished: bool,
        seen: std::sync::Arc<std::sync::Mutex<Fed>>,
    }

    #[derive(Default)]
    struct Fed {
        feeds: usize,
        non_finite: usize,
    }

    impl FakeTranscriber {
        fn new(fail_on: Option<usize>) -> Self {
            Self { fed: 0, fail_on, fatal_on: None, finished: false, seen: Default::default() }
        }
    }

    impl Transcriber for FakeTranscriber {
        fn feed(&mut self, _channel: Channel, pcm: &[f32], sink: &mut dyn TranscriptSink) -> Result<()> {
            self.fed += 1;
            {
                let mut seen = self.seen.lock().unwrap();
                seen.feeds += 1;
                seen.non_finite += pcm.iter().filter(|s| !s.is_finite()).count();
            }
            if self.fatal_on == Some(self.fed) {
                return Err(Fatal("The live transcript stopped: the decoder failed".to_string()).into());
            }
            if self.fail_on == Some(self.fed) {
                anyhow::bail!("decoder exploded");
            }
            sink.committed(TranscriptChunk {
                text: format!("chunk {}", self.fed),
                audio_start: 0.0,
                audio_end: 1.0,
                confidence: None,
                speaker: None,
                channel: None,
            });
            Ok(())
        }

        fn finish(&mut self, sink: &mut dyn TranscriptSink) -> Result<()> {
            self.finished = true;
            sink.committed(TranscriptChunk {
                text: "tail".to_string(),
                audio_start: 1.0,
                audio_end: 2.0,
                confidence: None,
                speaker: None,
                channel: None,
            });
            Ok(())
        }
    }

    fn audio() -> (
        tokio::sync::mpsc::UnboundedSender<AudioChunk>,
        UnboundedReceiver<AudioChunk>,
    ) {
        tokio::sync::mpsc::unbounded_channel()
    }

    fn chunk() -> AudioChunk {
        AudioChunk {
            data: vec![0.0; 800],
            sample_rate: 16_000,
            timestamp: 0.0,
            chunk_id: 0,
            device_type: DeviceType::Microphone,
        }
    }

    /// Feed `n` chunks, then close the channel, and report what the sink saw.
    fn transcribe(n: usize, fail_on: Option<usize>) -> Recorded {
        let (tx, rx) = audio();
        for _ in 0..n {
            tx.send(chunk()).unwrap();
        }
        drop(tx);

        let sink = FakeSink::default();
        let recorded = sink.0.clone();
        run(FakeTranscriber::new(fail_on), sink, rx);

        let log = std::mem::take(&mut *recorded.lock().unwrap());
        log
    }

    #[test]
    fn every_chunk_is_transcribed_and_the_tail_is_drained() {
        assert_eq!(
            transcribe(3, None).committed,
            vec!["chunk 1", "chunk 2", "chunk 3", "tail"],
            "the decoder's tail must be drained after input ends"
        );
    }

    #[test]
    fn a_failed_chunk_warns_but_does_not_end_the_transcript() {
        let log = transcribe(3, Some(2));

        assert_eq!(log.warnings, vec!["decoder exploded"]);
        assert_eq!(
            log.committed,
            vec!["chunk 1", "chunk 3", "tail"],
            "chunk 2 failed; 3 and the tail must still arrive"
        );
    }

    /// A stream that ended FAILED fails every later feed, and each warning was a toast. Said once,
    /// and nothing more is fed or finished. (#169)
    #[test]
    fn a_failed_stream_is_said_once_and_fed_no_more() {
        let (tx, rx) = audio();
        for _ in 0..5 {
            tx.send(chunk()).unwrap();
        }
        drop(tx);
        let sink = FakeSink::default();
        let recorded = sink.0.clone();
        let mut transcriber = FakeTranscriber::new(None);
        transcriber.fatal_on = Some(2);
        let seen = transcriber.seen.clone();
        run(transcriber, sink, rx);

        let log = recorded.lock().unwrap();
        assert_eq!(log.warnings, vec!["The live transcript stopped: the decoder failed"], "one warning, not one per chunk");
        assert_eq!(seen.lock().unwrap().feeds, 2, "nothing is fed after the stream failed");
        assert_eq!(log.committed, vec!["chunk 1"], "a failed stream is not finished, so no tail is asked of it");
    }

    /// From v0.4.1 one NaN or Inf rejects the whole feed; the decoder is handed silence in its place.
    /// (#169)
    #[test]
    fn a_chunk_with_nan_reaches_the_decoder_finite() {
        let (tx, rx) = audio();
        let mut bad = chunk();
        bad.data[10] = f32::NAN;
        bad.data[20] = f32::INFINITY;
        bad.data[30] = f32::NEG_INFINITY;
        tx.send(bad).unwrap();
        drop(tx);
        let transcriber = FakeTranscriber::new(None);
        let seen = transcriber.seen.clone();
        run(transcriber, FakeSink::default(), rx);

        let seen = seen.lock().unwrap();
        assert_eq!(seen.feeds, 1, "precondition: the chunk was fed");
        assert_eq!(seen.non_finite, 0, "the decoder was handed {} non-finite samples", seen.non_finite);
    }

    #[test]
    fn non_finite_samples_become_silence_and_nothing_else_changes() {
        let mut samples = [0.5, f32::NAN, f32::INFINITY, -0.25, f32::NEG_INFINITY, 0.0];
        assert_eq!(replace_non_finite(&mut samples), 3);
        assert_eq!(samples, [0.5, 0.0, 0.0, -0.25, 0.0, 0.0]);
    }

    #[test]
    fn the_live_text_is_cleared_when_the_stream_ends() {
        assert_eq!(
            transcribe(1, None).tentative.last().map(String::as_str),
            Some(""),
            "a stale partial must not outlive the recording"
        );
    }
}

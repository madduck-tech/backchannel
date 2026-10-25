// audio/transcription/adapters/segmented.rs
//
// Driving adapter for models that cannot stream: speech is cut into segments by
// VAD and each one is decoded whole.
//
// There is no tentative text on this path, so it is silent between utterances,
// and its latency floor is the segment length. Two decoders sit behind one
// adapter because segmentation is identical between them —
// only the call that turns samples into a string differs:
//   - `Decoder::Local`    — `Session::run()`, for the batch-only catalog
//                           families (whisper, canary, qwen3-asr, ...).
//   - `Decoder::AudioLlm` — one llama-helper sidecar request per segment, for
//                           audio-capable LLMs (Gemma 4 E2B/E4B).
//
// Single-threaded on purpose: transcribe.cpp allows one in-flight compute per
// Model, so a second concurrent `run()` fails with `Error::Busy`. The sidecar
// has the same constraint for a different reason — one process, one loaded
// model.
//
// One decoder, two channels. `Error::Busy` forbids *concurrent* compute on a
// `Model`, not serial use of it, and `Session::run()` decodes a whole utterance
// carrying no state between calls — so YOU and OTHERS can share one model by
// taking turns, and this path needs no second `Model::load`. What they cannot
// share is the segmentation: `ContinuousVadProcessor` is stateful across calls,
// so each channel keeps its own VAD and its own queue.

use crate::audio::common::{
    split_segment_at_silence, DIARIZED_MAX_SEGMENT_SAMPLES, LIVE_MAX_SEGMENT_SAMPLES,
};
use crate::audio::transcription::ports::{Channel, Transcriber, TranscriptChunk, TranscriptSink};
use crate::audio::vad::{ContinuousVadProcessor, SpeechSegment};
use crate::transcribe_engine::{keep_partial_on_truncation, scored_confidence, speaker_turns};
use anyhow::Result;
use log::warn;
use std::collections::VecDeque;
use transcribe_cpp::{Diarize, Session};

/// Pipeline audio is already mono 16kHz, which is what the VAD and every model
/// want.
const SAMPLE_RATE: u32 = 16_000;

/// How long VAD waits through a pause before closing a segment. Matches the
/// import path so live and file transcripts segment the same way.
const VAD_REDEMPTION_MS: u32 = 2_000;


/// How a segment becomes text.
pub enum Decoder {
    /// Local GGUF through transcribe.cpp.
    Local { session: Session, language: Option<String>, diarize: Diarize },
    /// Audio-capable LLM in the built-in sidecar.
    AudioLlm {
        handle: tokio::runtime::Handle,
        app_data_dir: std::path::PathBuf,
        model: String,
    },
    /// Returns one turn per segment, naming the segment's length.
    ///
    /// Test-only, and it is what makes this adapter's own logic — which channel
    /// a segment came from, and what order the two queues drain in — observable
    /// without loading a model.
    ///
    /// `seconds_per_second` makes it slow: it sleeps that long per second of the segment, so a
    /// model slower than real time can be driven without one (#209).
    #[cfg(test)]
    Fake { speaker_id: i32, seconds_per_second: f64 },
}

pub struct DecodedTurn {
    pub text: String,
    pub speaker_id: i32,
    pub start_ms: f64,
    pub end_ms: f64,
    pub confidence: Option<f32>,
}

impl Decoder {
    fn decode(&mut self, samples: &[f32]) -> Result<Vec<DecodedTurn>> {
        match self {
            Decoder::Local { session, language, diarize } => {
                let transcript = keep_partial_on_truncation(crate::transcribe_engine::options::run(
                    session,
                    samples,
                    language.clone(),
                    *diarize,
                ))?;
                // `None` when the family scores nothing, which is what `ports.rs:54` says the
                // value means. `Some(mean_token_confidence(..))` was unconditional here, and for a
                // family that leaves every `Token::p` at the zero sentinel it painted a red `0%` on
                // every line (#162); for the 53 catalogue rows whose architecture builds no token
                // row at all it painted a green 100%.
                let confidence = scored_confidence(&transcript);

                let turns = speaker_turns(&transcript);
                if !turns.is_empty() {
                    return Ok(turns
                        .into_iter()
                        .map(|t| DecodedTurn {
                            text: t.text,
                            speaker_id: t.speaker_id,
                            start_ms: t.start_ms,
                            end_ms: t.end_ms,
                            confidence,
                        })
                        .collect());
                }

                let text = transcript.text.trim().to_string();
                if text.is_empty() {
                    return Ok(vec![]);
                }
                Ok(vec![DecodedTurn {
                    text,
                    speaker_id: 0,
                    start_ms: 0.0,
                    end_ms: 0.0,
                    confidence,
                }])
            }
            Decoder::AudioLlm { handle, app_data_dir, model } => {
                // The sidecar call is async and this adapter is driven from a
                // blocking thread, which is exactly where block_on is legal.
                let text = handle.block_on(
                    crate::summary::summary_engine::client::transcribe_with_builtin(
                        app_data_dir,
                        model,
                        samples,
                    ),
                )?;
                if text.is_empty() {
                    return Ok(vec![]);
                }
                // A chat completion carries no token probabilities.
                Ok(vec![DecodedTurn {
                    text,
                    speaker_id: 0,
                    start_ms: 0.0,
                    end_ms: 0.0,
                    confidence: None,
                }])
            }
            #[cfg(test)]
            Decoder::Fake { speaker_id, seconds_per_second } => {
                if *seconds_per_second > 0.0 {
                    std::thread::sleep(std::time::Duration::from_secs_f64(
                        samples.len() as f64 / SAMPLE_RATE as f64 * *seconds_per_second,
                    ));
                }
                Ok(vec![DecodedTurn {
                text: format!("{} samples", samples.len()),
                speaker_id: *speaker_id,
                start_ms: 0.0,
                end_ms: 0.0,
                confidence: None,
            }])
            }
        }
    }
}

/// The diarizing model's own cluster id, when it produced one.
///
/// This used to decide the *channel* too, by summing `mic_rms` against
/// `sys_rms` over the turn's span and calling the louder side the speaker. That
/// guess is gone: the channel is now a fact of capture carried on the chunk,
/// and it is right whoever is louder. What remains here is genuinely a guess —
/// the model's clustering *within* what it heard — so it stays in `speaker`.
fn label(speaker_id: i32) -> Option<String> {
    (speaker_id > 0).then(|| speaker_id.to_string())
}

/// Everything that has to be kept apart for one capture channel.
struct ChannelState {
    channel: Channel,
    vad: ContinuousVadProcessor,
    pending: VecDeque<SpeechSegment>,
}

impl ChannelState {
    fn new(channel: Channel) -> Result<Self> {
        Ok(Self {
            channel,
            vad: ContinuousVadProcessor::new(SAMPLE_RATE, VAD_REDEMPTION_MS)?,
            pending: VecDeque::new(),
        })
    }
}

pub struct SegmentedTranscriber {
    decoder: Decoder,
    /// One per capture channel. An array rather than two named fields so the
    /// drain below can pick between them by index without duplicating itself.
    channels: [ChannelState; 2],
    max_segment_samples: usize,
}

impl SegmentedTranscriber {
    pub fn new(decoder: Decoder) -> Result<Self> {
        Self::with_diarization(decoder, false)
    }

    pub fn with_diarization(decoder: Decoder, diarizes: bool) -> Result<Self> {
        Ok(Self {
            decoder,
            channels: [
                ChannelState::new(Channel::You)?,
                ChannelState::new(Channel::Others)?,
            ],
            max_segment_samples: if diarizes {
                DIARIZED_MAX_SEGMENT_SAMPLES
            } else {
                LIVE_MAX_SEGMENT_SAMPLES
            },
        })
    }

    fn slot(&mut self, channel: Channel) -> &mut ChannelState {
        // Two elements: find is cheaper to read than an index convention that
        // has to be kept true in three places.
        self.channels
            .iter_mut()
            .find(|state| state.channel == channel)
            .expect("every Channel variant has a ChannelState")
    }

    /// Whichever channel is holding the oldest queued speech, so the two drain
    /// as one conversation. Without this the transcript would order rows by
    /// which queue happened to be serviced, not by when the words were said.
    fn oldest_queued(&self) -> Option<usize> {
        self.channels
            .iter()
            .enumerate()
            .filter_map(|(i, state)| state.pending.front().map(|s| (i, s.start_timestamp_ms)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i)
    }

    /// Decode everything queued on both channels.
    ///
    /// Inside every `feed`, so the queue here never holds more than one window's segment. A model
    /// slower than real time falls behind upstream, in the channel that feeds the service, and
    /// nothing is dropped: `BenchSink` tells the person once it is 20 s behind (#209, ADR 0027).
    fn drain(&mut self, sink: &mut dyn TranscriptSink) {
        while let Some(i) = self.oldest_queued() {
            let channel = self.channels[i].channel;
            let Some(segment) = self.channels[i].pending.pop_front() else { break };
            self.decode_segment(channel, segment, sink);
        }
    }

    fn decode_segment(
        &mut self,
        channel: Channel,
        segment: SpeechSegment,
        sink: &mut dyn TranscriptSink,
    ) {
        let segment_start = segment.start_timestamp_ms / 1000.0;
        let segment_end = segment.end_timestamp_ms / 1000.0;

        match self.decoder.decode(&segment.samples) {
            Ok(turns) => {
                for turn in turns {
                    let timed = turn.end_ms > turn.start_ms;
                    let (start, end) = if timed {
                        (
                            segment_start + turn.start_ms / 1000.0,
                            segment_start + turn.end_ms / 1000.0,
                        )
                    } else {
                        (segment_start, segment_end)
                    };

                    sink.committed(TranscriptChunk {
                        text: turn.text,
                        audio_start: start,
                        audio_end: end,
                        confidence: turn.confidence,
                        speaker: label(turn.speaker_id),
                        // The channel this audio was captured on, not a verdict
                        // about it. Every row on this path carries one, whether
                        // or not the model diarizes.
                        channel: Some(channel),
                    });
                }
            }
            Err(e) => {
                warn!("Batch transcription of a segment failed: {e}");
                sink.warn(&e.to_string());
            }
        }
    }
}

impl Transcriber for SegmentedTranscriber {
    fn feed(
        &mut self,
        channel: Channel,
        pcm_16k: &[f32],
        sink: &mut dyn TranscriptSink,
    ) -> Result<()> {
        let cap = self.max_segment_samples;
        let state = self.slot(channel);
        // Losing a chunk to VAD is recoverable; ending the meeting's transcript
        // over it is not.
        match state.vad.process_audio(pcm_16k) {
            Ok(segments) => enqueue(segments, &mut state.pending, cap),
            Err(e) => warn!("VAD processing failed on the {} channel: {e}", channel.label()),
        }
        self.drain(sink);
        Ok(())
    }

    fn finish(&mut self, sink: &mut dyn TranscriptSink) -> Result<()> {
        let cap = self.max_segment_samples;
        for state in self.channels.iter_mut() {
            match state.vad.flush() {
                Ok(segments) => enqueue(segments, &mut state.pending, cap),
                Err(e) => warn!("VAD flush failed on the {} channel: {e}", state.channel.label()),
            }
        }
        self.drain(sink);
        Ok(())
    }
}

/// Queue segments, splitting any too long for a single decode.
///
/// The cap is what the speaker experiences as latency: one decode must not be
/// allowed to hold the whole transcript hostage.
fn enqueue(segments: Vec<SpeechSegment>, pending: &mut VecDeque<SpeechSegment>, cap: usize) {
    for segment in segments {
        if segment.samples.len() > cap {
            pending.extend(split_segment_at_silence(&segment, cap));
        } else {
            pending.push_back(segment);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn segment(secs: f64, start_ms: f64) -> SpeechSegment {
        SpeechSegment {
            samples: vec![0.0; (secs * SAMPLE_RATE as f64) as usize],
            start_timestamp_ms: start_ms,
            end_timestamp_ms: start_ms + secs * 1000.0,
            confidence: 1.0,
        }
    }

    /// Silero consumes whole 30ms frames and buffers the remainder, so audio
    /// for these tests is counted in frames — otherwise the assertion is about
    /// that leftover rather than about routing.
    const FRAME: usize = (SAMPLE_RATE as usize * 30) / 1000;

    fn audio(frames: usize) -> Vec<f32> {
        vec![0.01; frames * FRAME]
    }

    fn transcriber() -> SegmentedTranscriber {
        SegmentedTranscriber::new(Decoder::Fake { speaker_id: 0, seconds_per_second: 0.0 }).unwrap()
    }

    /// What a sink was told, with the channel each row claimed.
    #[derive(Default)]
    struct Rows(Vec<TranscriptChunk>);

    impl TranscriptSink for Rows {
        fn committed(&mut self, chunk: TranscriptChunk) {
            self.0.push(chunk);
        }
        fn tentative(&mut self, _text: &str) {}
        fn warn(&mut self, _message: &str) {}
    }

    impl Rows {
        fn channels(&self) -> Vec<Option<Channel>> {
            self.0.iter().map(|c| c.channel).collect()
        }
    }

    /// Whether a buffer becomes a segment is Silero's verdict, so these tests
    /// assert on where the audio *went* and on what the queues produce — never
    /// on a synthetic waveform being recognised as speech. Matrix cells 1.1-1.4
    /// (real speech on each side, correctly labelled) are Stage 2's, on the
    /// built application with real audio.
    #[test]
    fn audio_is_segmented_by_the_channel_it_arrived_on() {
        let mut t = transcriber();
        let mut rows = Rows::default();

        t.feed(Channel::Others, &audio(33), &mut rows).unwrap();

        assert_eq!(
            t.slot(Channel::Others).vad.processed_samples(),
            33 * FRAME,
            "the system channel's segmenter must have seen the audio sent to it"
        );
        assert_eq!(
            t.slot(Channel::You).vad.processed_samples(),
            0,
            "nothing was captured on the microphone, so its segmenter must have seen nothing"
        );
    }

    #[test]
    fn the_two_channels_do_not_share_one_segmenter() {
        // The defect this guards: one `ContinuousVadProcessor` for both sides.
        // A shared segmenter would see YOU's speech and OTHERS' silence as one
        // alternating stream, cutting utterances at every switch and crediting
        // each segment to whichever channel fed last.
        let mut t = transcriber();
        let mut rows = Rows::default();

        for _ in 0..4 {
            t.feed(Channel::You, &audio(10), &mut rows).unwrap();
            t.feed(Channel::Others, &audio(5), &mut rows).unwrap();
        }

        // Deliberately unequal: one shared segmenter would report the same
        // number on both sides -- the sum -- and that is the failure this
        // guards against.
        assert_eq!(t.slot(Channel::You).vad.processed_samples(), 40 * FRAME);
        assert_eq!(t.slot(Channel::Others).vad.processed_samples(), 20 * FRAME);
    }

    #[test]
    fn a_row_carries_the_channel_its_audio_was_captured_on() {
        let mut t = transcriber();
        let mut rows = Rows::default();

        t.slot(Channel::Others).pending.push_back(segment(1.0, 0.0));
        t.slot(Channel::You).pending.push_back(segment(1.0, 2_000.0));
        t.drain(&mut rows);

        assert_eq!(
            rows.channels(),
            vec![Some(Channel::Others), Some(Channel::You)],
            "each row must name the queue its audio came off, not a fixed side"
        );
    }

    #[test]
    fn the_queues_drain_in_the_order_the_words_were_said() {
        let mut t = transcriber();
        let mut rows = Rows::default();

        // Queued directly: VAD timing is not what is under test here, the
        // choice between two non-empty queues is.
        // OTHERS speaks first on purpose. YOU is `channels[0]`, so a drain that
        // simply prefers the first queue would produce the right order for any
        // fixture where the microphone also happened to speak first.
        t.slot(Channel::You).pending.push_back(segment(1.0, 3_000.0));
        t.slot(Channel::Others).pending.push_back(segment(1.0, 1_000.0));
        t.slot(Channel::Others).pending.push_back(segment(1.0, 5_000.0));
        t.drain(&mut rows);

        assert_eq!(
            rows.channels(),
            vec![Some(Channel::Others), Some(Channel::You), Some(Channel::Others)],
            "rows must follow the clock, not whichever queue was serviced first"
        );
        let starts: Vec<f64> = rows.0.iter().map(|c| c.audio_start).collect();
        assert_eq!(starts, vec![1.0, 3.0, 5.0]);
    }

    #[test]
    fn a_cluster_id_is_the_only_thing_left_in_speaker() {
        assert_eq!(label(0), None, "a row nothing attributed must claim nothing");
        assert_eq!(label(2), Some("2".to_string()));
    }

    #[test]
    fn a_long_utterance_is_split_before_one_decode_holds_the_transcript() {
        let mut pending = VecDeque::new();
        enqueue(vec![segment(40.0, 0.0)], &mut pending, LIVE_MAX_SEGMENT_SAMPLES);

        assert!(pending.len() > 1, "a 40s utterance must be split, got {}", pending.len());
        assert!(
            pending.iter().all(|s| s.samples.len() <= LIVE_MAX_SEGMENT_SAMPLES * 2),
            "no sub-segment should be wildly past the cap"
        );
    }

    #[test]
    fn short_segments_pass_through_unsplit() {
        let mut pending = VecDeque::new();
        enqueue(vec![segment(3.0, 0.0)], &mut pending, LIVE_MAX_SEGMENT_SAMPLES);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].samples.len(), 3 * SAMPLE_RATE as usize);
    }
}

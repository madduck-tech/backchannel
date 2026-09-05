// audio/transcription/adapters/summed.rs
//
// A driving *decorator*: it satisfies `ports::Transcriber` by summing the two
// capture channels back into one and handing that to an inner transcriber.
//
// This exists for exactly one backend and is meant to die. `StreamingTranscriber`
// owns a single `transcribe_cpp::Stream`, and a stream is a conversation with the
// model: feeding it YOU's window and then OTHERS' window would present the same
// wall-clock second twice, in series, as if two people had spoken one after the
// other. ADR 0003's answer is one model instance per channel, which the engine
// cannot express today — it holds one `Model` slot (`transcribe_engine/engine.rs`).
// Until it can, the streaming path gets what it has always had: the mix, and no
// channel on its rows.
//
// The batch path needs none of this. `Session::run()` decodes a whole utterance
// with no state carried between calls, so one model can serve both channels by
// interleaving — which is what `segmented.rs` does.

use crate::audio::pipeline::sum_clamped;
use crate::audio::transcription::ports::{Channel, Transcriber, TranscriptSink};
use anyhow::Result;

/// Sum the two channels and feed one inner transcriber.
pub struct SumChannels<T> {
    inner: T,
    /// The window that arrived first and is waiting for its partner.
    held: Option<(Channel, Vec<f32>)>,
}

impl<T: Transcriber> SumChannels<T> {
    pub fn new(inner: T) -> Self {
        Self { inner, held: None }
    }

    /// Feed whatever is waiting, unsummed. The partner never came, so the other
    /// channel was silent for that window as far as this adapter can tell.
    fn flush_held(&mut self, sink: &mut dyn TranscriptSink) -> Result<()> {
        match self.held.take() {
            Some((_, pcm)) => self.inner.feed(Channel::You, &pcm, sink),
            None => Ok(()),
        }
    }
}

impl<T: Transcriber> Transcriber for SumChannels<T> {
    fn feed(&mut self, channel: Channel, pcm_16k: &[f32], sink: &mut dyn TranscriptSink) -> Result<()> {
        // Pairing is by alternation rather than by a timestamp, because `feed`
        // carries no clock. It holds because `pipeline::forward_mixed` emits
        // exactly one chunk per channel per mixing window, from two windows
        // `extract_window` has already padded to the same length — so the two
        // are produced together or not at all.
        //
        // If that ever stops holding, this degrades rather than breaking: an
        // unpartnered window is fed on its own, which is that window with the
        // other channel treated as silent. It never stalls waiting for a
        // partner and never feeds the same audio twice.
        match self.held.take() {
            Some((held_channel, held_pcm)) if held_channel != channel => {
                let summed = sum_clamped(&held_pcm, pcm_16k);
                self.inner.feed(Channel::You, &summed, sink)
            }
            Some((_, held_pcm)) => {
                // Same channel twice: the earlier window has no partner coming.
                let first = self.inner.feed(Channel::You, &held_pcm, sink);
                self.held = Some((channel, pcm_16k.to_vec()));
                first
            }
            None => {
                self.held = Some((channel, pcm_16k.to_vec()));
                Ok(())
            }
        }
    }

    fn finish(&mut self, sink: &mut dyn TranscriptSink) -> Result<()> {
        // A held window is still owed to the decoder: dropping it would silently
        // shorten the meeting by one window at the very end of the recording.
        let flushed = self.flush_held(sink);
        let finished = self.inner.finish(sink);
        flushed.and(finished)
    }

    fn note_levels(&mut self, start_s: f64, mic_rms: f32, sys_rms: f32) {
        self.inner.note_levels(start_s, mic_rms, sys_rms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
        use crate::audio::transcription::service::tests::FakeSink;

    /// Records the audio it was handed, so the test can assert on the sum.
    #[derive(Default)]
    struct Spy {
        fed: Vec<Vec<f32>>,
        finished: bool,
    }

    impl Transcriber for Spy {
        fn feed(&mut self, _channel: Channel, pcm: &[f32], _sink: &mut dyn TranscriptSink) -> Result<()> {
            self.fed.push(pcm.to_vec());
            Ok(())
        }
        fn finish(&mut self, _sink: &mut dyn TranscriptSink) -> Result<()> {
            self.finished = true;
            Ok(())
        }
    }

    /// `SumChannels` owns its inner transcriber, so the spy reports through a
    /// shared handle rather than being borrowed back out.
    #[derive(Default, Clone)]
    struct SharedSpy(std::sync::Arc<std::sync::Mutex<Spy>>);

    impl Transcriber for SharedSpy {
        fn feed(&mut self, channel: Channel, pcm: &[f32], sink: &mut dyn TranscriptSink) -> Result<()> {
            self.0.lock().unwrap().feed(channel, pcm, sink)
        }
        fn finish(&mut self, sink: &mut dyn TranscriptSink) -> Result<()> {
            self.0.lock().unwrap().finish(sink)
        }
    }

    fn harness() -> (SumChannels<SharedSpy>, SharedSpy, FakeSink) {
        let spy = SharedSpy::default();
        (SumChannels::new(spy.clone()), spy, FakeSink::default())
    }

    #[test]
    fn a_pair_of_channels_reaches_the_decoder_summed_once() {
        let (mut sum, spy, mut sink) = harness();

        sum.feed(Channel::You, &[0.25, -0.25], &mut sink).unwrap();
        assert!(
            spy.0.lock().unwrap().fed.is_empty(),
            "the first channel of a window must wait for its partner, not be decoded alone"
        );

        sum.feed(Channel::Others, &[0.5, 0.5], &mut sink).unwrap();
        assert_eq!(
            spy.0.lock().unwrap().fed,
            vec![vec![0.75, 0.25]],
            "the decoder must see one window carrying both channels"
        );
    }

    #[test]
    fn the_sum_is_clamped_the_same_way_the_recording_is() {
        let (mut sum, spy, mut sink) = harness();

        sum.feed(Channel::You, &[0.9, -0.9], &mut sink).unwrap();
        sum.feed(Channel::Others, &[0.9, -0.9], &mut sink).unwrap();

        assert_eq!(
            spy.0.lock().unwrap().fed,
            vec![vec![1.0, -1.0]],
            "an over-range sum must clamp, exactly as pipeline::sum_clamped does for the WAV"
        );
    }

    #[test]
    fn an_unpartnered_window_is_still_decoded() {
        let (mut sum, spy, mut sink) = harness();

        sum.feed(Channel::You, &[0.1], &mut sink).unwrap();
        sum.feed(Channel::You, &[0.2], &mut sink).unwrap();

        assert_eq!(
            spy.0.lock().unwrap().fed,
            vec![vec![0.1]],
            "a second window from the same channel means the first has no partner coming"
        );
    }

    #[test]
    fn the_last_window_is_not_lost_at_the_end_of_a_recording() {
        let (mut sum, spy, mut sink) = harness();

        sum.feed(Channel::Others, &[0.4], &mut sink).unwrap();
        sum.finish(&mut sink).unwrap();

        let spy = spy.0.lock().unwrap();
        assert_eq!(spy.fed, vec![vec![0.4]], "the held window must be flushed before finishing");
        assert!(spy.finished, "the inner decoder must still be drained");
    }

}

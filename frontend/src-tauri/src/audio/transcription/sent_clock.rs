//! The channel that carries audio to transcription, and the clock it keeps. (#209)
//!
//! How far behind the speaker a transcript is can only be read where the audio enters the queue:
//! downstream of `recv`, the transcriber only ever sees the chunk it is decoding, and a backlog
//! waits upstream of it, in this channel. So the channel's sending half counts what it sends, and
//! `BenchSink` reads that count against each committed row's `audio_end`.
//!
//! The clock is the one `audio_end` is on. Every mixing window sends both channels, the shorter
//! zero-padded, and both channels' VADs count those samples; the clock advances by **one**
//! channel's samples per window, the longer of the two, exactly as the pipeline's own timestamps
//! do. A counter summing every send would run at twice that clock and read every healthy recording
//! as falling behind.
//!
//! It stops while a recording is paused, because nothing is sent then (`recording_state.rs`
//! discards captured chunks). The wall clock does not, which is why the warning used to fire after
//! any long pause.

use crate::audio::AudioChunk;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::{self, error::SendError, UnboundedReceiver, UnboundedSender};

/// Samples per second on the transcription side.
const SAMPLE_RATE: f64 = 16_000.0;

/// Audio sent toward transcription so far, in one channel's samples.
#[derive(Clone, Debug, Default)]
pub struct SentClock(Arc<AtomicU64>);

impl SentClock {
    pub fn samples(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    pub fn seconds(&self) -> f64 {
        self.samples() as f64 / SAMPLE_RATE
    }
}

/// The sending half: what the pipeline hands each mixing window to.
#[derive(Clone)]
pub struct FeedSender {
    tx: UnboundedSender<AudioChunk>,
    clock: SentClock,
}

/// The receiving half, and the clock its sender keeps.
pub struct FeedReceiver {
    rx: UnboundedReceiver<AudioChunk>,
    clock: SentClock,
}

pub fn feed_channel() -> (FeedSender, FeedReceiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let clock = SentClock::default();
    (FeedSender { tx, clock: clock.clone() }, FeedReceiver { rx, clock })
}

impl FeedSender {
    /// The clock's reading before this window: the timestamp its chunks carry.
    pub fn sent_samples(&self) -> u64 {
        self.clock.samples()
    }

    /// Send one mixing window, both channels, and advance the clock by the longer one.
    ///
    /// Empty chunks are not sent. Returns how many were, or the first refusal: once the receiver is
    /// gone it is gone for the rest of the meeting. The clock advances either way, as the
    /// pipeline's timestamps always have.
    pub fn send_window(&self, chunks: Vec<AudioChunk>) -> Result<usize, SendError<AudioChunk>> {
        let advance = chunks.iter().map(|c| c.data.len()).max().unwrap_or(0) as u64;
        let mut sent = 0;
        let mut result = Ok(());
        for chunk in chunks.into_iter().filter(|c| !c.data.is_empty()) {
            if let Err(e) = self.tx.send(chunk) {
                result = Err(e);
                break;
            }
            sent += 1;
        }
        self.clock.0.fetch_add(advance, Ordering::Relaxed);
        result.map(|()| sent)
    }
}

impl FeedReceiver {
    /// The channel, and the clock that `BenchSink` reads lag from.
    pub fn into_parts(self) -> (UnboundedReceiver<AudioChunk>, SentClock) {
        (self.rx, self.clock)
    }

    /// For a reader that needs the audio and not the clock: the audio check and the dictation
    /// probe.
    pub async fn recv(&mut self) -> Option<AudioChunk> {
        self.rx.recv().await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::audio::recording_state::DeviceType;

    /// One mixing window as the pipeline sends it: both channels, `others` silent.
    pub(crate) fn window(you: Vec<f32>, at_samples: u64) -> Vec<AudioChunk> {
        let len = you.len();
        [(you, DeviceType::Microphone), (vec![0.0; len], DeviceType::System)]
            .into_iter()
            .map(|(data, device_type)| AudioChunk {
                data,
                sample_rate: 16_000,
                timestamp: at_samples as f64 / SAMPLE_RATE,
                chunk_id: 0,
                device_type,
            })
            .collect()
    }

    #[test]
    fn a_window_advances_the_clock_by_one_channel_not_both() {
        let (tx, rx) = feed_channel();
        let (mut rx, clock) = rx.into_parts();
        tx.send_window(window(vec![0.1; 800], 0)).unwrap();
        tx.send_window(window(vec![0.1; 800], 800)).unwrap();
        assert_eq!(clock.samples(), 1_600, "two 50 ms windows are 100 ms of the meeting, not 200");
        let mut chunks = 0;
        while rx.try_recv().is_ok() {
            chunks += 1;
        }
        assert_eq!(chunks, 4, "both channels are still sent");
    }

    #[test]
    fn the_longer_channel_sets_the_advance_and_empty_chunks_are_not_sent() {
        let (tx, rx) = feed_channel();
        let (mut rx, clock) = rx.into_parts();
        let mut w = window(vec![0.1; 800], 0);
        w[1].data.clear();
        assert_eq!(tx.send_window(w).unwrap(), 1);
        assert_eq!(clock.samples(), 800);
        assert!(rx.try_recv().is_ok() && rx.try_recv().is_err());
    }
}

// audio/transcription/adapters/bench_sink.rs
//
// A measuring decorator on the driven side of the hexagon.
//
// The question it exists to answer is "how far behind the speaker is the
// transcript?", and nothing else in the app can answer it. A decoder knows how
// long its own decode took; a sink knows what text arrived. Only the pair of
// (audio sent so far, audio position) captured at the instant text is committed
// gives the lag a user actually experiences.
//
// "Audio sent so far" is the transcription channel's own clock (`sent_clock`),
// not the wall clock (#209). The wall clock kept running through a pause, while
// nothing was captured, so a healthy model's first row after a long pause read
// as half a minute behind and the warning fired on it; and it started after the
// model load, while audio queued during the load.
//
// A decorator rather than a macro sprinkled through the adapters, because every
// backend commits through a `TranscriptSink`. Wrapping the sink at the two
// composition points in `transcription/mod.rs` therefore instruments the
// streaming path, the local batch path and the sidecar audio-LLM path at once,
// and none of the three adapters has to know that measurement exists.

use crate::audio::transcription::ports::{TranscriptChunk, TranscriptSink};
use crate::audio::transcription::sent_clock::SentClock;
use log::info;
use std::time::{Duration, Instant};

/// How often a `BENCH` line is allowed out, after the first one.
///
/// Commits arrive every couple of seconds on a streaming model, and the point
/// of the line is a trend over a meeting, not a running commentary.
const LOG_EVERY: Duration = Duration::from_secs(15);

/// How far behind the speaker the transcript has to fall before it stops being
/// a latency figure and becomes something the user should be told about.
///
/// Twenty seconds is past the point where the text on screen is still useful
/// for following the conversation, and comfortably past any normal decode
/// latency, so it does not fire on a model that is merely unhurried.
const LAG_WARN_MS: f64 = 20_000.0;

/// Wraps a sink and reports how far behind real time the transcript is.
pub struct BenchSink<S> {
    inner: S,
    /// What lag is measured against: the audio sent toward transcription so far.
    sent: SentClock,
    /// The first commit's lag. The warning is judged against it, so a model load or a sidecar
    /// warm-up, which delays the first row once, does not read as falling behind; a model slower
    /// than real time still grows past it. Every reported figure stays absolute.
    baseline_ms: Option<f64>,
    /// Monotonic wall time, for the log's `t=` and its throttle only.
    started: Instant,
    commits: u64,
    last_log: Instant,
    /// Whether this recording wants the user warned about lag at all. Off by
    /// default: see [`BenchSink::warn_when_behind`].
    lag_warning: bool,
    /// Latched after the one warning, the same way `segmented.rs` latches its
    /// backlog warning.
    lag_warned: bool,
    /// Every lag, not only the throttled ones that reach the log.
    ///
    /// The throttle exists so a meeting does not produce one log line per commit; it was never
    /// meant to throw the numbers away, and until #65 that is what it did — a p95 computed from
    /// one sample per fifteen seconds is a p95 of the throttle, not of the transcript. Held in
    /// memory for the length of one recording: a f64 per commit, so an hour of dense speech is
    /// tens of kilobytes.
    lags_ms: Vec<f64>,
}

impl<S: TranscriptSink> BenchSink<S> {
    pub fn new(inner: S, sent: SentClock) -> Self {
        let started = Instant::now();
        Self {
            inner,
            sent,
            baseline_ms: None,
            started,
            commits: 0,
            last_log: started,
            lags_ms: Vec::new(),
            lag_warning: false,
            lag_warned: false,
        }
    }

    /// Also tell the user, once, if the transcript falls ~20s behind them.
    ///
    /// Opt-in rather than always-on because only the streaming path needs it.
    /// The VAD + batch adapter already warns when its backlog cap starts
    /// dropping audio, and one slow model producing two different toasts is one
    /// too many. The streaming path has no such cap: it never drops anything,
    /// it just arrives later and later, which is exactly the failure a user
    /// cannot diagnose without being told.
    pub fn warn_when_behind(mut self) -> Self {
        self.lag_warning = true;
        self
    }

    /// Whether this is the moment to hand out the "pick a faster model" advice.
    ///
    /// Once per recording: the condition holds for every subsequent commit once
    /// it holds at all, and the point is to tell the user something they can
    /// act on, not to bury the UI in identical toasts.
    fn behind(&mut self, lag: f64) -> bool {
        let baseline = *self.baseline_ms.get_or_insert(lag);
        if self.lag_warning && !self.lag_warned && lag - baseline >= LAG_WARN_MS {
            self.lag_warned = true;
            true
        } else {
            false
        }
    }

    /// Whether this commit gets a log line.
    ///
    /// Deliberately checked *before* any formatting: this runs on the decode
    /// thread for every committed chunk, and building a string only to throw it
    /// away is the entire cost of instrumenting a hot path.
    fn due(&mut self, now: Instant) -> bool {
        // The first commit always reports — it is the one that tells you the
        // pipeline produced anything at all, and waiting 15s for that is how a
        // silent failure gets mistaken for a slow model.
        if self.commits == 1 || now.duration_since(self.last_log) >= LOG_EVERY {
            self.last_log = now;
            true
        } else {
            false
        }
    }
}

/// Milliseconds of audio between the live edge (everything sent toward
/// transcription so far) and the end of the text just committed.
///
/// Never negative in practice: a row cannot describe audio that was not sent.
fn lag_ms(sent_secs: f64, audio_end_secs: f64) -> f64 {
    (sent_secs - audio_end_secs) * 1000.0
}

impl<S: TranscriptSink> TranscriptSink for BenchSink<S> {
    fn committed(&mut self, chunk: TranscriptChunk) {
        self.commits += 1;
        let now = Instant::now();
        let elapsed = now.duration_since(self.started);
        // Two float operations, unconditionally. What the throttle below guards
        // is the formatting, which is the part that actually costs something.
        let lag = lag_ms(self.sent.seconds(), chunk.audio_end);
        self.lags_ms.push(lag);

        if self.due(now) {
            info!(
                "BENCH n={} t={:.1}s audio_end={:.1}s lag_ms={lag:.0} chars={}",
                self.commits,
                elapsed.as_secs_f64(),
                chunk.audio_end,
                chunk.text.chars().count(),
            );
        }

        // The text first: the user should see the line before being told it
        // arrived late.
        self.inner.committed(chunk);

        if self.behind(lag) {
            self.inner.warn(&format!(
                "Live transcription is about {:.0}s behind what you are saying. Nothing is \
                 being lost, but the text will keep arriving late — pick a faster model in \
                 settings to close the gap.",
                lag / 1000.0
            ));
        }
    }

    fn tentative(&mut self, text: &str) {
        // Never logged, on purpose. Tentative text changes on nearly every
        // feed — several times a second — so a line here would bury the commit
        // lines it exists to make readable, and cost more than what it measures.
        self.inner.tentative(text);
    }

    fn warn(&mut self, message: &str) {
        self.inner.warn(message);
    }
}

impl<S> BenchSink<S> {
    /// The summary of one recording, or `None` if nothing was committed.
    ///
    /// ADR 0008 states its criteria in p95, and this is the only place in the application that
    /// produces one. It is *reported*, never enforced: the measurement needs an audio device and
    /// 1.2 GB of models, and CI has neither, so nothing can go red on it. #65 says so rather than
    /// letting a printed number look like a check.
    pub fn summary(&mut self) -> Option<crate::audio::latency::Percentiles> {
        crate::audio::latency::percentiles(&mut self.lags_ms.clone())
    }
}

impl<S> Drop for BenchSink<S> {
    fn drop(&mut self) {
        if let Some(p) = crate::audio::latency::percentiles(&mut self.lags_ms.clone()) {
            info!("BENCH SUMMARY committed-lag {p}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::transcription::sent_clock::{feed_channel, tests::window, FeedSender};
    use crate::audio::transcription::service::tests::FakeSink;
    use crate::audio::AudioChunk;
    use tokio::sync::mpsc::UnboundedReceiver;

    fn chunk(text: &str, audio_end: f64) -> TranscriptChunk {
        TranscriptChunk {
            text: text.to_string(),
            audio_start: (audio_end - 1.0).max(0.0),
            audio_end,
            confidence: None,
            speaker: None,
            channel: None,
        }
    }

    /// The counting channel as the pipeline drives it: 50 ms windows, both channels, `others`
    /// silent. Lag is read from its clock, so the tests move that clock the way production does.
    struct Feed {
        tx: FeedSender,
        _rx: UnboundedReceiver<AudioChunk>,
    }

    fn feed() -> (Feed, SentClock) {
        let (tx, rx) = feed_channel();
        let (rx, clock) = rx.into_parts();
        (Feed { tx, _rx: rx }, clock)
    }

    impl Feed {
        fn send(&self, secs: f64) {
            for _ in 0..(secs * 20.0).round() as usize {
                let at = self.tx.sent_samples();
                self.tx.send_window(window(vec![0.0; 800], at)).unwrap();
            }
        }
    }

    /// Wind the wall clock back, as if `secs` had passed. Lag does not read it; the log's
    /// throttle does, and so did the lag before #209, which the pause test shows.
    fn started_seconds_ago<S: TranscriptSink>(bench: &mut BenchSink<S>, secs: u64) {
        bench.started = bench
            .started
            .checked_sub(Duration::from_secs(secs))
            .expect("the monotonic clock has been running for at least that long");
    }

    #[test]
    fn measuring_does_not_change_what_the_sink_is_told() {
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let mut bench = BenchSink::new(inner, SentClock::default());

        bench.committed(chunk("hello", 1.0));
        bench.tentative("half a wo");
        bench.committed(chunk("world", 2.0));
        bench.warn("something slipped");
        bench.tentative("");

        let log = recorded.lock().unwrap();
        assert_eq!(log.committed, vec!["hello", "world"]);
        assert_eq!(log.tentative, vec!["half a wo", ""]);
        assert_eq!(log.warnings, vec!["something slipped"]);
    }

    #[test]
    fn lag_is_the_audio_sent_minus_the_audio_position() {
        // 12 s of audio sent, and the text just committed describes audio up to the 10 s mark: two
        // seconds behind the speaker.
        assert_eq!(lag_ms(12.0, 10.0), 2_000.0);
    }

    #[test]
    fn a_transcript_that_keeps_up_is_never_warned_about() {
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let (feed, clock) = feed();
        let mut bench = BenchSink::new(inner, clock).warn_when_behind();

        feed.send(60.0);
        bench.committed(chunk("on time", 59.5));

        assert!(recorded.lock().unwrap().warnings.is_empty());
    }

    /// #209: a pause stops the audio, and the wall clock did not stop with it. A healthy model's
    /// first row after a minute's pause read as a minute behind.
    #[test]
    fn a_pause_is_not_falling_behind() {
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let (feed, clock) = feed();
        let mut bench = BenchSink::new(inner, clock).warn_when_behind();

        feed.send(10.0);
        bench.committed(chunk("before the pause", 9.5));
        // Paused: a minute of wall time, and nothing sent.
        started_seconds_ago(&mut bench, 60);
        feed.send(30.0);
        bench.committed(chunk("after the pause", 39.5));

        let log = recorded.lock().unwrap();
        assert!(log.warnings.is_empty(), "a healthy model was warned about after a pause: {:?}", log.warnings);
    }

    /// #209: the first row of a recording comes after the model load (or the sidecar's warm-up),
    /// while audio queued. That delay happens once and is not falling behind.
    #[test]
    fn a_late_first_row_is_a_load_not_a_lag() {
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let (feed, clock) = feed();
        let mut bench = BenchSink::new(inner, clock).warn_when_behind();

        feed.send(30.0);
        bench.committed(chunk("first, after a 28 s load", 2.0));
        feed.send(10.0);
        bench.committed(chunk("caught up", 39.0));

        let log = recorded.lock().unwrap();
        assert!(log.warnings.is_empty(), "a model load was warned about as lag: {:?}", log.warnings);
    }

    /// The bar is relative to the first row, so the baseline must not hide a model that keeps
    /// falling behind; and what the person is told is how far behind they actually are.
    #[test]
    fn falling_twenty_seconds_further_behind_warns_once_with_the_whole_lag() {
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let (feed, clock) = feed();
        let mut bench = BenchSink::new(inner, clock).warn_when_behind();

        feed.send(7.0);
        bench.committed(chunk("five seconds behind from the start", 2.0));
        feed.send(53.0);
        bench.committed(chunk("thirty seconds behind", 30.0));
        bench.committed(chunk("still behind", 31.0));

        let log = recorded.lock().unwrap();
        assert_eq!(log.committed.len(), 3, "the text still arrives");
        assert_eq!(log.warnings.len(), 1, "advice once per recording, not once per chunk: {:?}", log.warnings);
        assert!(log.warnings[0].contains("about 30s behind"), "the whole lag, not the part past the first row: {}", log.warnings[0]);
        assert!(log.warnings[0].contains("faster model"), "the warning has to say what to do: {}", log.warnings[0]);
    }

    /// Documents today's behaviour, accepted in #209 as a known limit: the one warning is spent
    /// on a spike that recovers, and a later sustained lag in the same recording is not
    /// reported. Re-arming it would mean a second toast, which is the product owner's call; if
    /// that is ever decided, this test is deleted, not adjusted.
    #[test]
    fn today_a_recovered_spike_spends_the_one_warning() {
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let (feed, clock) = feed();
        let mut bench = BenchSink::new(inner, clock).warn_when_behind();

        feed.send(5.0);
        bench.committed(chunk("on time", 4.0));
        feed.send(25.0);
        bench.committed(chunk("a long decode", 8.0));
        bench.committed(chunk("recovered", 29.5));
        feed.send(40.0);
        bench.committed(chunk("behind again", 40.0));

        assert_eq!(recorded.lock().unwrap().warnings.len(), 1);
    }

    #[test]
    fn the_segmented_paths_are_left_to_their_own_warning() {
        // No `warn_when_behind`, so the decorator only measures. The VAD + batch
        // adapter already tells the user when its backlog cap starts dropping
        // audio, and two toasts about one slow model is one too many.
        let inner = FakeSink::default();
        let recorded = inner.0.clone();
        let (feed, clock) = feed();
        let mut bench = BenchSink::new(inner, clock);

        feed.send(5.0);
        bench.committed(chunk("on time", 4.0));
        feed.send(30.0);
        bench.committed(chunk("late", 5.0));

        assert!(recorded.lock().unwrap().warnings.is_empty());
    }

    #[test]
    fn the_first_commit_reports_and_then_at_most_one_line_every_15s() {
        let mut bench = BenchSink::new(FakeSink::default(), SentClock::default());
        let t0 = bench.started;

        bench.commits = 1;
        assert!(bench.due(t0), "the first commit always reports");

        bench.commits = 2;
        assert!(!bench.due(t0 + Duration::from_secs(14)), "14s is inside the window");
        assert!(bench.due(t0 + Duration::from_secs(15)), "15s reopens it");
        assert!(!bench.due(t0 + Duration::from_secs(29)), "window restarts from the last line");
        assert!(bench.due(t0 + Duration::from_secs(30)));
    }
}

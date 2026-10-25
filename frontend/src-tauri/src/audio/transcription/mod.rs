// audio/transcription/mod.rs
//
// Live transcription, arranged as a hexagon:
//
//   ports.rs      the two boundaries — Transcriber (in), TranscriptSink (out)
//   service.rs    the use case, which knows only those two traits
//   adapters/     transcribe.cpp, Silero, the sidecar, and Tauri events
//   mod.rs        this file: the composition root that picks the adapters
//
// Only this file knows which backend a given recording will use, and only
// `adapters/tauri_sink.rs` knows that a UI exists. That split is the point: the
// live loop used to be one 700-line function that could not run without a real
// meeting, a real model and a real Tauri app, so nothing in it was ever tested
// and the bugs that mattered were the ones only a user could find.

pub mod adapters;
pub mod sent_clock;
pub mod ports;
pub mod service;

use adapters::bench_sink::BenchSink;
use adapters::segmented::{Decoder, SegmentedTranscriber};
use adapters::streaming::StreamingTranscriber;
use adapters::summed::SumChannels;
use adapters::tauri_sink::TauriSink;
use crate::audio::AudioChunk;
use crate::transcribe_engine::TRANSCRIBE_ENGINE;
use log::{error, info};
use tauri::{AppHandle, Runtime};
use transcribe_cpp::{Diarize, StreamOptions};

pub use adapters::tauri_sink::{reset_speech_detected_flag, TranscriptPartial, TranscriptUpdate};

/// How a loaded transcribe.cpp model is decoded live. (#200)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivePath {
    /// One stream for the whole meeting.
    Stream,
    /// Speech segmented by VAD, each segment decoded whole.
    Segmented,
}

/// Choose the live path from what the loaded model reports about itself.
///
/// A model streams only when it streams natively **and** reports no cap on how long a stream may run
/// (`max_audio_ms == 0`). moonshine_streaming streams, but one stream holds at most 81.9 s, re-decodes
/// everything so far on every feed, and its committed text is best-effort upstream, so a meeting kept
/// its first seconds (#200). Segmented, it decodes all of it. Read from GGUF metadata, so it cannot
/// drift from what the model can do. `None`, a model whose capabilities could not be read, is
/// segmented, the path that never needs them. Voxtral Realtime reports 0 with a 2.9 h wall (#204).
pub fn live_path(capabilities: Option<&transcribe_cpp::Capabilities>) -> LivePath {
    match capabilities {
        Some(c) if c.supports_streaming && c.max_audio_ms == 0 => LivePath::Stream,
        _ => LivePath::Segmented,
    }
}

/// Start live transcription for a recording.
///
/// Picking a backend goes provider first, then model capability:
///   - `builtin-ai` means an audio-capable LLM in the llama-helper sidecar,
///     which has no transcribe.cpp session at all — so it is checked first.
///   - otherwise [`live_path`] decides, from the loaded model's GGUF metadata,
///     so it cannot disagree with what the model can actually do; the catalog's
///     `streaming` field only labels rows in the picker before download.
pub fn start_transcription_task<R: Runtime>(
    app: AppHandle<R>,
    receiver: sent_clock::FeedReceiver,
) -> tokio::task::JoinHandle<()> {
    // The channel, and the clock its sender keeps, which `BenchSink` measures lag against.
    let (receiver, sent) = receiver.into_parts();
    tokio::spawn(async move {
        reset_speech_detected_flag();

        if let Some((provider, model)) = transcript_provider_config(&app).await {
            if crate::config::is_builtin_transcript_provider(&provider) {
                run_builtin_audio_llm(app, receiver, sent, model).await;
                return;
            }
        }

        let engine = {
            let guard = TRANSCRIBE_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned()
        };
        let Some(engine) = engine else {
            TauriSink::fatal(&app, "Transcription engine not initialized");
            return;
        };

        if !engine.is_model_loaded().await {
            TauriSink::fatal(&app, "No transcription model is loaded");
            return;
        }

        // Resolved against the loaded model, not passed raw: the picker stores
        // "de" and a model may advertise "de-DE", which transcribe.cpp rejects
        // outright — killing the stream before a single sample decodes.
        let language = engine
            .resolve_language(crate::get_language_preference_internal())
            .await;

        let session = match engine.open_session().await {
            Ok(s) => s,
            Err(e) => {
                TauriSink::fatal(&app, &format!("Failed to open transcription session: {e}"));
                return;
            }
        };

        // A model loaded for transcription has the ASR role (`load_model` refuses one without), so
        // this reads its capabilities; were it ever to fail, the VAD + batch path is the safe one.
        let streaming = live_path(session.model().capabilities().ok().as_ref()) == LivePath::Stream;
        let model_name = engine.get_current_model().await;
        let diarizes = model_name.as_deref().is_some_and(crate::config::model_diarizes);
        info!(
            "🎙️ Live transcription starting (model {:?}, language {:?}, path {}, speakers {})",
            model_name,
            language,
            if streaming { "stream" } else { "VAD + batch" },
            if diarizes { "on" } else { "off" }
        );

        // feed()/run()/finalize() are blocking native calls, so the whole loop
        // lives on a blocking thread rather than stalling the async reactor.
        let joined = tokio::task::spawn_blocking(move || {
            let mut session = session;
            let diarize = if diarizes { Diarize::On } else { Diarize::Default };
            // One wrap here covers both decode paths below, because both reach
            // the user through this sink. Instrumentation belongs at the
            // composition root for the same reason adapter choice does.
            let sink = BenchSink::new(TauriSink::new(app.clone()), sent);

            if streaming {
                match crate::transcribe_engine::options::stream(&mut session, language, diarize, &StreamOptions::default()) {
                    // Wrapped, because one open stream cannot take two
                    // channels: it would hear the same second of the meeting
                    // twice, in series. ADR 0003's per-channel instance needs a
                    // second `Model` the engine cannot hold yet, so until then
                    // this path gets the mix and its rows carry no channel.
                    Ok(stream) => service::run(
                        SumChannels::new(StreamingTranscriber::new(stream)),
                        sink,
                        receiver,
                    ),
                    Err(e) => {
                        TauriSink::fatal(&app, &format!("Failed to begin transcription stream: {e}"))
                    }
                }
            } else {
                match SegmentedTranscriber::with_diarization(
                    Decoder::Local { session, language, diarize },
                    diarizes,
                ) {
                    Ok(transcriber) => service::run(transcriber, sink, receiver),
                    Err(e) => {
                        TauriSink::fatal(&app, &format!("Failed to start speech detection: {e}"))
                    }
                }
            }
        })
        .await;
        if let Err(e) = joined {
            error!("Transcription task panicked: {e}");
        }
    })
}

/// Read the configured transcript provider and model, if any is stored.
async fn transcript_provider_config<R: Runtime>(app: &AppHandle<R>) -> Option<(String, String)> {
    use tauri::Manager;
    match crate::api::api::api_get_transcript_config(app.clone(), app.state(), None).await {
        Ok(Some(config)) if !config.provider.is_empty() => Some((config.provider, config.model)),
        _ => None,
    }
}

/// Live transcription through an audio-capable LLM in the built-in sidecar.
///
/// Uses the same segmented adapter as a local batch model: an LLM decode per
/// utterance needs exactly the same VAD segmentation and emit path. Only the
/// call that turns samples into a string differs.
async fn run_builtin_audio_llm<R: Runtime>(
    app: AppHandle<R>,
    receiver: tokio::sync::mpsc::UnboundedReceiver<AudioChunk>,
    sent: sent_clock::SentClock,
    model: String,
) {
    use crate::config::DEFAULT_BUILTIN_TRANSCRIBE_MODEL;
    use tauri::Manager;

    let model = if model.is_empty() {
        DEFAULT_BUILTIN_TRANSCRIBE_MODEL.to_string()
    } else {
        model
    };

    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            TauriSink::fatal(&app, &format!("Could not resolve the app data directory: {e}"));
            return;
        }
    };

    // Fail once, up front, with something the user can act on — rather than the
    // same "projector missing" warning for every utterance.
    match crate::summary::summary_engine::models::get_mmproj_path(&app_data_dir, &model) {
        Ok(Some(path)) if path.exists() => {}
        Ok(Some(path)) => {
            TauriSink::fatal(
                &app,
                &format!(
                    "{model} is not fully downloaded — its audio projector is missing from {}",
                    path.display()
                ),
            );
            return;
        }
        Ok(None) => {
            TauriSink::fatal(&app, &format!("{model} cannot transcribe audio"));
            return;
        }
        Err(e) => {
            TauriSink::fatal(&app, &e.to_string());
            return;
        }
    }

    info!("🎙️ Live transcription via built-in audio model {model}");

    // The sidecar call is async and the service loop is blocking. A blocking
    // thread is exactly where Handle::block_on is legal, so the decoder carries
    // the handle rather than the whole loop becoming async.
    let handle = tokio::runtime::Handle::current();
    let joined = tokio::task::spawn_blocking(move || {
        let sink = BenchSink::new(TauriSink::new(app.clone()), sent);
        let decoder = Decoder::AudioLlm { handle, app_data_dir, model };
        match SegmentedTranscriber::new(decoder) {
            Ok(transcriber) => service::run(transcriber, sink, receiver),
            Err(e) => TauriSink::fatal(&app, &format!("Failed to start speech detection: {e}")),
        }
    })
    .await;
    if let Err(e) = joined {
        error!("Transcription task panicked: {e}");
    }
}

#[cfg(test)]
mod live_path_tests {
    use super::*;
    use transcribe_cpp::{Capabilities, TimestampKind};

    fn caps(supports_streaming: bool, max_audio_ms: i64) -> Capabilities {
        Capabilities {
            native_sample_rate: 16_000,
            languages: vec!["en".into()],
            translate_target_languages: vec![],
            max_timestamp_kind: TimestampKind::None,
            supports_language_detect: false,
            supports_translate: false,
            supports_streaming,
            supports_spec_decode: false,
            max_audio_ms,
        }
    }

    #[test]
    fn a_stream_with_no_cap_streams() {
        assert_eq!(live_path(Some(&caps(true, 0))), LivePath::Stream, "nemotron's capabilities");
    }

    #[test]
    fn a_stream_with_a_cap_is_segmented() {
        assert_eq!(live_path(Some(&caps(true, 81_920))), LivePath::Segmented, "moonshine_streaming's capabilities (#200)");
    }

    #[test]
    fn a_batch_model_is_segmented_and_so_is_an_unread_one() {
        assert_eq!(live_path(Some(&caps(false, 0))), LivePath::Segmented);
        assert_eq!(live_path(None), LivePath::Segmented);
    }
}

#[cfg(test)]
mod falling_behind {
    //! A model slower than real time, through the live path as it is built. (#209)
    //!
    //! The real `service::run`, the real `SegmentedTranscriber` with its Silero VAD, the counting
    //! channel the pipeline sends into, and `BenchSink` as the composition root builds it. Only the
    //! decoder is a fake: it sleeps `K` seconds per second of segment, scaled by `SCALE`, and the
    //! sender paces windows on the same scale, so the run takes a tenth of the audio's length and
    //! lag, counted in samples, is exact whatever the scale.
    use super::adapters::bench_sink::BenchSink;
    use super::adapters::segmented::{Decoder, SegmentedTranscriber};
    use super::ports::{Channel, TranscriptSink, Transcriber};
    use super::sent_clock::{feed_channel, tests::window};
    use super::service::{self, tests::FakeSink};
    use crate::measure::{pinned_sample, read_wav_mono_16k};
    use anyhow::Result;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Seconds of decoding per second of segment.
    const K: f64 = 2.0;
    /// Wall seconds are audio seconds over this. Bounded at 10. Silero's own time is not scaled,
    /// so it is measured on the reference run and counted in the prediction: on macOS CI it alone
    /// put the depth 12 s past a prediction that left it out (#209's gate).
    const SCALE: f64 = 10.0;
    /// Seconds of `dots-full.wav` sent.
    const T: f64 = 120.0;

    /// Counts the samples the service actually fed on `you`: depth is what was sent minus this.
    struct Counting<X> {
        inner: X,
        fed: Arc<AtomicU64>,
    }

    impl<X: Transcriber> Transcriber for Counting<X> {
        fn feed(&mut self, channel: Channel, pcm_16k: &[f32], sink: &mut dyn TranscriptSink) -> Result<()> {
            if channel == Channel::You {
                self.fed.fetch_add(pcm_16k.len() as u64, Ordering::Relaxed);
            }
            self.inner.feed(channel, pcm_16k, sink)
        }
        fn finish(&mut self, sink: &mut dyn TranscriptSink) -> Result<()> {
            self.inner.finish(sink)
        }
    }

    /// The segments the adapter cuts from `audio`, decoded instantly: what a model that keeps up
    /// would commit, to hold the slow run's commits against.
    ///
    /// The reference goes through the same adapter, so a loss that happens whatever the speed is
    /// invisible here; what this proves is that **being slow loses nothing**, which is the claim:
    /// the dropping it replaces fired only on a model that had fallen behind. Its control drops
    /// segments only when the decoder is slow. Since that dropping could never fire, this check
    /// held at the previous commit too: it guards against a speed-dependent loss coming back.
    ///
    /// `BenchSink` is built here by hand, as `start_transcription_task` builds it on both of its
    /// branches; that both branches do is read from source, not driven.
    fn segments_of(audio: &[f32]) -> Vec<String> {
        let sink = FakeSink::default();
        let recorded = sink.0.clone();
        let mut t = SegmentedTranscriber::new(Decoder::Fake { speaker_id: 0, seconds_per_second: 0.0 }).unwrap();
        let mut sink = sink;
        for w in audio.chunks(800) {
            t.feed(Channel::You, w, &mut sink).unwrap();
            t.feed(Channel::Others, &vec![0.0; w.len()], &mut sink).unwrap();
        }
        t.finish(&mut sink).unwrap();
        let committed = recorded.lock().unwrap().committed.clone();
        committed
    }

    #[test]
    fn a_segmented_model_slower_than_real_time_is_warned_about_and_loses_nothing() {
        let all = read_wav_mono_16k(&pinned_sample("dots-full.wav"));
        let audio = &all[..(T * 16_000.0) as usize];
        // The adapter's own cost per second of audio (Silero, mostly), decoding instantly.
        let timed = Instant::now();
        let expected_rows = segments_of(audio);
        let c = timed.elapsed().as_secs_f64() / T;
        let speech: u64 = expected_rows.iter().map(|r| r.trim_end_matches(" samples").parse::<u64>().unwrap()).sum();
        let f = speech as f64 / audio.len() as f64;
        assert!(K * f >= 1.5, "inconclusive: k·f = {:.2} (f = {f:.2}), under 1.5, so this run cannot fall behind enough to mean anything", K * f);

        let (tx, rx) = feed_channel();
        let (rx, clock) = rx.into_parts();
        let fake = FakeSink::default();
        let recorded = fake.0.clone();
        // As the composition root builds every live sink.
        let sink = BenchSink::new(fake, clock.clone());
        let fed = Arc::new(AtomicU64::new(0));
        let transcriber = Counting {
            inner: SegmentedTranscriber::new(Decoder::Fake { speaker_id: 0, seconds_per_second: K / SCALE }).unwrap(),
            fed: fed.clone(),
        };
        let consumer = std::thread::spawn(move || service::run(transcriber, sink, rx));

        let start = Instant::now();
        for (i, w) in audio.chunks(800).enumerate() {
            let due = start + Duration::from_secs_f64(i as f64 * 0.05 / SCALE);
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            tx.send_window(window(w.to_vec(), tx.sent_samples())).unwrap();
        }
        let depth = (clock.samples() - fed.load(Ordering::Relaxed)) as f64 / 16_000.0;
        drop(tx);
        consumer.join().unwrap();

        let log = recorded.lock().unwrap();
        // Per second of audio the consumer spends c on the adapter plus K·f/SCALE asleep, against
        // the sender's 1/SCALE, so it runs at K·f + c·SCALE times the sender's pace.
        let effective = K * f + c * SCALE;
        let predicted = T * (1.0 - 1.0 / effective);
        eprintln!(
            "f {f:.3}, k·f {:.2}, adapter {c:.4} s per audio s, effective {effective:.2}; depth when sending ended {depth:.1} s, predicted {predicted:.1} s; {} rows of {} expected; warnings {:?}",
            K * f, log.committed.len(), expected_rows.len(), log.warnings
        );
        assert!(depth >= 30.0, "the run fell only {depth:.1} s behind, so it says nothing about a backlog");
        assert!((depth - predicted).abs() <= 8.0, "depth {depth:.1} s, predicted {predicted:.1} s ± 8");
        assert_eq!(log.committed, expected_rows, "every segment committed, in order, none shed");
        assert!(!log.warnings.iter().any(|w| w.contains("skipped")), "audio was shed: {:?}", log.warnings);
        let behind: Vec<&String> = log.warnings.iter().filter(|w| w.contains("behind what you are saying")).collect();
        assert_eq!(behind.len(), 1, "one warning that the transcript is behind: {:?}", log.warnings);
    }
}

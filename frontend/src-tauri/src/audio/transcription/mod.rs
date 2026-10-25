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
                    // Only this path opts into the lag warning. The segmented
                    // adapter below already warns when its backlog cap starts
                    // dropping audio; the streaming path has no cap, so nothing
                    // otherwise tells a user that the transcript has quietly
                    // drifted half a minute behind them.
                    // Wrapped, because one open stream cannot take two
                    // channels: it would hear the same second of the meeting
                    // twice, in series. ADR 0003's per-channel instance needs a
                    // second `Model` the engine cannot hold yet, so until then
                    // this path gets the mix and its rows carry no channel.
                    Ok(stream) => service::run(
                        SumChannels::new(StreamingTranscriber::new(stream)),
                        sink.warn_when_behind(),
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
/// utterance needs exactly the same VAD segmentation, backlog cap and emit
/// path. Only the call that turns samples into a string differs.
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

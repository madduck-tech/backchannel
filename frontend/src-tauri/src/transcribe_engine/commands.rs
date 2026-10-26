// transcribe_engine/commands.rs
//
// Tauri command surface. This replaces the 24 whisper_*/parakeet_* commands the
// frontend used to call with 12 — the two families were always the same 12
// operations duplicated per engine, and there is only one engine now.
//
// Event names and payloads are deliberately unchanged from the whisper path
// (model-download-progress, model-loading-started, …) so the model manager UI
// keeps working against the same contract.

use crate::config::DEFAULT_TRANSCRIBE_MODEL;
use crate::transcribe_engine::{ModelInfo, ModelStatus, TranscribeEngine};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, Emitter, Manager, Runtime};

pub static TRANSCRIBE_ENGINE: Mutex<Option<Arc<TranscribeEngine>>> = Mutex::new(None);

static MODELS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Called during app setup, before `transcribe_init`.
pub fn set_models_directory<R: Runtime>(app: &AppHandle<R>) {
    let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    let models_dir = app_data_dir.join("models");

    if !models_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&models_dir) {
            log::error!("Failed to create models directory: {}", e);
            return;
        }
    }
    log::info!("Models directory set to: {}", models_dir.display());

    // Files from the whisper-rs / ONNX engines can never be loaded again, so
    // clear them here rather than leaving GBs of dead weight on disk.
    TranscribeEngine::purge_legacy_models(&models_dir);

    *MODELS_DIR.lock().unwrap() = Some(models_dir);
}

fn get_models_directory() -> Option<PathBuf> {
    MODELS_DIR.lock().unwrap().clone()
}

/// Shared accessor — every command below needs the engine or a uniform error.
fn engine() -> Result<Arc<TranscribeEngine>, String> {
    TRANSCRIBE_ENGINE
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Transcription engine not initialized".to_string())
}

#[command]
pub async fn transcribe_init() -> Result<(), String> {
    // The shared entry point of both batch engine-init paths
    // (`import::get_or_init_transcribe` and its retranscription twin), so a
    // batch job starting resets the idle unloader's clock before it loads.
    crate::audio::common::touch_engine_idle().await;

    let mut guard = TRANSCRIBE_ENGINE.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let e = TranscribeEngine::new_with_models_dir(get_models_directory())
        .map_err(|e| format!("Failed to initialize transcription engine: {}", e))?;
    *guard = Some(Arc::new(e));
    Ok(())
}

#[command]
pub async fn transcribe_get_available_models() -> Result<Vec<ModelInfo>, String> {
    // Unlike the whisper path there is no standalone-scan fallback: init is
    // cheap (no model load), so just initialize instead of duplicating the
    // discovery logic for the uninitialized case.
    transcribe_init().await?;
    engine()?
        .discover_models()
        .await
        .map_err(|e| format!("Failed to discover models: {}", e))
}

#[command]
pub async fn transcribe_has_available_models() -> Result<bool, String> {
    Ok(transcribe_get_available_models()
        .await?
        .iter()
        .any(|m| matches!(m.status, ModelStatus::Available)))
}

#[command]
pub async fn transcribe_get_models_directory() -> Result<String, String> {
    transcribe_init().await?;
    Ok(engine()?.get_models_directory().await.display().to_string())
}

#[command]
pub async fn transcribe_load_model<R: Runtime>(
    app_handle: AppHandle<R>,
    model_name: String,
) -> Result<(), String> {
    let engine = engine()?;

    let _ = app_handle.emit(
        "model-loading-started",
        serde_json::json!({ "modelName": model_name }),
    );

    let result = engine
        .load_model(&model_name)
        .await
        .map_err(|e| format!("Failed to load model: {}", e));

    match &result {
        Ok(()) => {
            // A model just loaded is a model wanted now. Without this the idle clock still read from
            // the last screen, and the next tick could drop what the first-run audio check had just
            // loaded for itself (#168).
            crate::audio::common::touch_engine_idle().await;
            let _ = app_handle.emit(
                "model-loading-completed",
                serde_json::json!({ "modelName": model_name }),
            );
        }
        Err(error) => {
            let _ = app_handle.emit(
                "model-loading-failed",
                serde_json::json!({ "modelName": model_name, "error": error }),
            );
        }
    }
    result
}

#[command]
pub async fn transcribe_is_model_loaded() -> Result<bool, String> {
    Ok(engine()?.is_model_loaded().await)
}

#[command]
pub async fn transcribe_get_current_model() -> Result<Option<String>, String> {
    Ok(engine()?.get_current_model().await)
}

#[command]
pub async fn transcribe_download_model<R: Runtime>(
    app_handle: AppHandle<R>,
    model_name: String,
) -> Result<(), String> {
    transcribe_init().await?;
    let engine = engine()?;

    let app_for_progress = app_handle.clone();
    let name_for_progress = model_name.clone();
    let progress_callback = Box::new(move |p: crate::transcribe_engine::engine::DownloadProgress| {
        let _ = app_for_progress.emit(
            "model-download-progress",
            serde_json::json!({
                "modelName": name_for_progress,
                "progress": p.percent,
                "downloaded_mb": p.downloaded_mb,
                "total_mb": p.total_mb,
                "speed_mbps": p.speed_mbps,
                "status": if p.percent >= 100 { "completed" } else { "downloading" },
            }),
        );
    });

    match engine.download_model(&model_name, Some(progress_callback)).await {
        Ok(()) => {
            let _ = app_handle.emit(
                "model-download-complete",
                serde_json::json!({ "modelName": model_name }),
            );
            Ok(())
        }
        Err(e) => {
            let _ = app_handle.emit(
                "model-download-error",
                serde_json::json!({ "modelName": model_name, "error": e.to_string() }),
            );
            Err(format!("Failed to download model: {}", e))
        }
    }
}

#[command]
pub async fn transcribe_cancel_download(model_name: String) -> Result<(), String> {
    engine()?
        .cancel_download(&model_name)
        .await
        .map_err(|e| format!("Failed to cancel download: {}", e))
}

/// Deletes the model file. Named for the UI flow that calls it (removing a
/// corrupted download), but it deletes any catalog model.
#[command]
pub async fn transcribe_delete_corrupted_model(model_name: String) -> Result<(), String> {
    transcribe_init().await?;
    engine()?
        .delete_model(&model_name)
        .await
        .map_err(|e| format!("Failed to delete model: {}", e))
}

/// What the pre-flight in [`transcribe_check_model_ready`] found.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ModelReadiness {
    /// Nothing left to load — either the provider is a built-in audio LLM,
    /// which has no transcribe.cpp model at all, or the configured model is
    /// already resident.
    Ready(String),
    /// Downloaded and resolvable, but the weights are not in memory yet.
    NeedsLoad(String),
}

/// The state of the model a recording would use, as the pre-check asks for it, loading nothing.
/// (#182)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingModelState {
    /// On disk and usable: today's `Ready` and `NeedsLoad` alike, in this answer only.
    Ready,
    Missing,
    /// A download is in flight for it, whatever its file's size says.
    Downloading,
    Corrupted,
    /// Its status says it failed, or (on-device audio models) it is unknown or cannot hear audio.
    Error,
}

/// What `transcribe_recording_model_state` answers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RecordingModel {
    pub provider: String,
    /// The resolved name, even when it is not ready.
    pub model: String,
    pub state: RecordingModelState,
}

/// The resolver's answer. `NeedsLoad` is kept apart from `Ready`, because
/// [`transcribe_validate_model_ready`] loads only on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resolution {
    Ready(String),
    NeedsLoad(String),
    /// Not usable, with the message recording's pre-flight refuses with.
    NotReady { model: String, state: RecordingModelState, message: String },
}

/// What the resolver reads, gathered first, so that the resolution itself is a pure function.
pub(crate) struct ResolverInputs<'a> {
    pub provider: Option<&'a str>,
    pub configured: Option<&'a str>,
    /// The model resident in the engine, if one is.
    pub loaded: Option<&'a str>,
    /// Every catalogue model's name and status.
    pub catalogue: &'a [(String, ModelStatus)],
    pub downloading: &'a std::collections::HashSet<String>,
}

/// An on-device audio model's files, by name and whether each is on disk; `Err` with the message to
/// refuse with for an unknown model or one with no projector.
pub(crate) type BuiltinFiles = Result<Vec<(String, bool)>, String>;

/// Which model a recording would use, and whether it can, without loading anything. One resolver,
/// for recording's pre-flight and for the pre-check alike (#182).
///
/// - `builtin-ai`: the configured Gemma, or the default one, with both its files on disk.
/// - Otherwise `transcript_settings.model`, or `DEFAULT_TRANSCRIBE_MODEL` when empty. It is never
///   substituted: decode behaviour is a property of the model, not the app, and swapping a streaming
///   model for a batch-only one silently turns live transcription into per-utterance batches while
///   the UI still names the model the user picked.
/// - A download in flight is checked before the file's size. Past 90% a file reads `Available`
///   (`engine.rs:171`), and this used to let a partial file through to a load; now it refuses.
pub(crate) fn resolve_recording_model(inputs: &ResolverInputs, builtin: impl Fn(&str) -> BuiltinFiles) -> Resolution {
    use RecordingModelState as S;
    let chosen = |default: &str| inputs.configured.filter(|m| !m.is_empty()).unwrap_or(default).to_string();

    if inputs.provider.is_some_and(crate::config::is_builtin_transcript_provider) {
        let model = chosen(crate::config::DEFAULT_BUILTIN_TRANSCRIBE_MODEL);
        return match builtin(&model) {
            Err(message) => Resolution::NotReady { model, state: S::Error, message },
            Ok(files) => match files.iter().find(|(_, present)| !present) {
                Some((file, _)) => Resolution::NotReady {
                    message: format!("{} is not downloaded yet — {} is missing", model, file),
                    model,
                    state: S::Missing,
                },
                None => Resolution::Ready(model),
            },
        };
    }

    let model = chosen(DEFAULT_TRANSCRIBE_MODEL);
    if inputs.loaded == Some(model.as_str()) {
        return Resolution::Ready(model);
    }
    let refuse = |state| Resolution::NotReady {
        message: format!("Transcription model '{}' is not downloaded yet. Download it in Settings, then start recording.", model),
        model: model.clone(),
        state,
    };
    if inputs.downloading.contains(&model) {
        return refuse(S::Downloading);
    }
    match inputs.catalogue.iter().find(|(name, _)| *name == model).map(|(_, status)| status) {
        Some(ModelStatus::Available) => Resolution::NeedsLoad(model),
        Some(ModelStatus::Downloading { .. }) => refuse(S::Downloading),
        Some(ModelStatus::Corrupted { .. }) => refuse(S::Corrupted),
        Some(ModelStatus::Error(_)) => refuse(S::Error),
        // A stored name the catalogue does not list is as good as absent.
        Some(ModelStatus::Missing) | None => refuse(S::Missing),
    }
}

/// Gather what the resolver reads, and resolve. The provider comes back too, for the pre-check.
async fn resolve_now<R: Runtime>(app: AppHandle<R>) -> Result<(String, Resolution), String> {
    let stored = crate::api::api::api_get_transcript_config(app.clone(), app.state(), None).await;
    let (provider, configured) = stored_choice(&stored);
    let provider_name = provider.clone().unwrap_or_default();

    if provider.as_deref().is_some_and(crate::config::is_builtin_transcript_provider) {
        let app_data_dir = app.path().app_data_dir().map_err(|e| format!("Could not resolve the app data directory: {}", e))?;
        let inputs = ResolverInputs {
            provider: provider.as_deref(),
            configured: configured.as_deref(),
            loaded: None,
            catalogue: &[],
            downloading: &Default::default(),
        };
        let resolution = resolve_recording_model(&inputs, |model| builtin_files(&app_data_dir, model));
        return Ok((provider_name, resolution));
    }

    transcribe_init().await?;
    let engine = engine()?;
    Ok((provider_name, resolve_with_engine(&engine, provider.as_deref(), configured.as_deref()).await?))
}

/// The provider and model the stored transcript config names; neither when it cannot be read, or
/// says nothing, so the resolver falls back to the defaults.
fn stored_choice(stored: &Result<Option<crate::api::api::TranscriptConfig>, String>) -> (Option<String>, Option<String>) {
    match stored {
        Ok(Some(config)) => (Some(config.provider.clone()), Some(config.model.clone())),
        _ => (None, None),
    }
}

/// An on-device audio model's two files under `app_data_dir`, the weights first, each by name and
/// whether it is on disk; `Err` for an unknown model or one with no projector.
fn builtin_files(app_data_dir: &std::path::PathBuf, model: &str) -> BuiltinFiles {
    let weights = crate::summary::summary_engine::models::get_model_path(app_data_dir, model).map_err(|e| e.to_string())?;
    let projector = crate::summary::summary_engine::models::get_mmproj_path(app_data_dir, model)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{} cannot transcribe audio", model))?;
    Ok([weights, projector]
        .iter()
        .map(|p| (p.file_name().unwrap_or_default().to_string_lossy().into_owned(), p.exists()))
        .collect())
}

/// The catalogue half of what the resolver reads, gathered from `engine`, and resolved. Split out of
/// [`resolve_now`] so a test can run it against an engine on a temporary directory.
pub(crate) async fn resolve_with_engine(
    engine: &TranscribeEngine,
    provider: Option<&str>,
    configured: Option<&str>,
) -> Result<Resolution, String> {
    let loaded = if engine.is_model_loaded().await { engine.get_current_model().await } else { None };
    let catalogue: Vec<(String, ModelStatus)> = engine
        .discover_models()
        .await
        .map_err(|e| format!("Failed to discover models: {}", e))?
        .into_iter()
        .map(|m| (m.name, m.status))
        .collect();
    let downloading = engine.downloads_in_flight().await;
    let inputs = ResolverInputs { provider, configured, loaded: loaded.as_deref(), catalogue: &catalogue, downloading: &downloading };
    // An on-device audio model is resolved before the engine is reached, in `resolve_now`.
    Ok(resolve_recording_model(&inputs, |model| Err(format!("{} is not a catalogue model", model))))
}

/// The pre-flight's reading of a resolution: a needed load stays a needed load, because
/// [`transcribe_validate_model_ready`] loads only on it.
fn pre_flight(resolution: Resolution) -> Result<ModelReadiness, String> {
    match resolution {
        Resolution::Ready(model) => Ok(ModelReadiness::Ready(model)),
        Resolution::NeedsLoad(model) => Ok(ModelReadiness::NeedsLoad(model)),
        Resolution::NotReady { message, .. } => Err(message),
    }
}

/// The pre-check's reading of a resolution: a model that needs a load is ready to record with.
fn answer(provider: String, resolution: Resolution) -> RecordingModel {
    let (model, state) = match resolution {
        Resolution::Ready(model) | Resolution::NeedsLoad(model) => (model, RecordingModelState::Ready),
        Resolution::NotReady { model, state, .. } => (model, state),
    };
    RecordingModel { provider, model, state }
}

/// Resolve the configured transcription model and prove its files are on disk,
/// loading nothing.
///
/// Split out of [`transcribe_validate_model_ready`] so recording start can run
/// the cheap half — "is it downloaded?", the failure users actually hit — as a
/// pre-flight before the microphone opens, and pay for the load afterwards,
/// with audio already buffering behind it.
pub(crate) async fn transcribe_check_model_ready<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ModelReadiness, String> {
    pre_flight(resolve_now(app).await?.1)
}

/// The pre-check before a recording: the model the recording would use and its state, from the same
/// resolver as recording's pre-flight, loading nothing (#182). The frontend used to ask whether *any*
/// model was on disk, and whether *any* was downloading.
#[command]
pub async fn transcribe_recording_model_state<R: Runtime>(app: AppHandle<R>) -> Result<RecordingModel, String> {
    let (provider, resolution) = resolve_now(app).await?;
    Ok(answer(provider, resolution))
}

/// Ensure a model is loaded and ready before recording starts.
///
/// Emits `model-loading-started` / `-completed` / `-failed` around the load —
/// the same three events `transcribe_load_model` uses, so the record button's
/// "Loading model…" label works whichever route reaches the load. They fire
/// only when a load actually happens: a built-in audio LLM and an
/// already-resident model both come back `Ready` from the check above.
#[command]
pub async fn transcribe_validate_model_ready<R: Runtime>(
    app: AppHandle<R>,
) -> Result<String, String> {
    let model = match transcribe_check_model_ready(app.clone()).await? {
        ModelReadiness::Ready(model) => return Ok(model),
        ModelReadiness::NeedsLoad(model) => model,
    };

    // Resolved before the "started" event so a missing engine cannot leave the
    // button stuck on a load that never began.
    let engine = engine()?;

    let _ = app.emit(
        "model-loading-started",
        serde_json::json!({ "modelName": model }),
    );

    match engine.load_model(&model).await {
        Ok(()) => {
            let _ = app.emit(
                "model-loading-completed",
                serde_json::json!({ "modelName": model }),
            );
            Ok(model)
        }
        Err(e) => {
            let error = format!("Failed to load model '{}': {}", model, e);
            let _ = app.emit(
                "model-loading-failed",
                serde_json::json!({ "modelName": model, "error": error }),
            );
            Err(error)
        }
    }
}

/// Load the configured transcription model ahead of anyone pressing record.
///
/// Called on the call detector's intent edge, where the load overlaps the
/// seconds the nudge is already on screen rather than the seconds after Start.
///
/// Silent by construction: every failure is logged and dropped, because a
/// preload that did not happen is not a thing to tell the user about. Recording
/// start runs the same check and reports it there, where they are waiting.
pub(crate) async fn preload_configured_model<R: Runtime>(app: AppHandle<R>) {
    // Deliberately the same read as `transcribe_validate_model_ready`, not
    // `common::configured_local_model` — that one substitutes the default
    // catalog model when the provider is the built-in audio LLM, which here
    // would mean loading 716 MB for a user who never decodes with it.
    let model = match transcribe_check_model_ready(app).await {
        Ok(ModelReadiness::NeedsLoad(model)) => model,
        Ok(ModelReadiness::Ready(model)) => {
            log::debug!("Transcription preload: '{}' needs no load", model);
            return;
        }
        Err(e) => {
            log::info!("Transcription preload skipped: {}", e);
            return;
        }
    };

    let engine = match engine() {
        Ok(engine) => engine,
        Err(e) => {
            log::info!("Transcription preload skipped: {}", e);
            return;
        }
    };

    let _engine_lifecycle_guard = crate::audio::common::acquire_engine_lifecycle_lock().await;

    // Re-check under the lock. The user may have pressed record while we waited
    // for it, and recording start does its own load; a second one here would
    // fight it for the single in-flight compute transcribe.cpp allows.
    if crate::audio::recording_commands::is_recording_now() {
        return;
    }
    if engine.get_current_model().await.as_deref() == Some(model.as_str())
        && engine.is_model_loaded().await
    {
        return;
    }

    match engine.load_model(&model).await {
        Ok(()) => {
            log::info!("Preloaded transcription model '{}' ahead of recording", model);
            crate::audio::common::touch_engine_idle().await;
        }
        Err(e) => log::warn!("Transcription preload of '{}' failed: {}", model, e),
    }
}

/// Reveal the models directory in the OS file manager.
#[command]
pub async fn open_models_folder() -> Result<(), String> {
    let dir = get_models_directory().ok_or_else(|| "Models directory not initialized".to_string())?;

    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open models folder: {}", e))?;
    Ok(())
}

#[command]
pub async fn transcribe_transcribe_audio(
    audio_data: Vec<f32>,
    language: Option<String>,
) -> Result<String, String> {
    engine()?
        .transcribe_batch(audio_data, language)
        .await
        .map(|r| r.text)
        .map_err(|e| format!("Transcription failed: {}", e))
}

/// The built-in audio LLMs offered for transcription.
///
/// Exposed as a command rather than mirrored in TypeScript so audio-capable models
/// have exactly one definition (`summary_engine::models`). A model qualifies by
/// carrying an audio projector, so this list cannot drift from what can actually
/// transcribe. Download state and progress come from the existing built-in AI flow.
#[derive(serde::Serialize)]
pub struct BuiltinTranscribeModel {
    pub name: String,
    pub size_mb: u64,
    pub description: String,
}

#[command]
pub fn transcribe_builtin_models() -> Vec<BuiltinTranscribeModel> {
    crate::summary::summary_engine::models::get_available_models()
        .into_iter()
        .filter(|m| m.is_audio())
        .map(|m| BuiltinTranscribeModel {
            size_mb: m.total_size_mb(),
            name: m.name,
            description: m.description,
        })
        .collect()
}

/// Language codes the currently loaded model supports.
///
/// `None` when no model is loaded; an empty vec when the model advertises no
/// list, which means it is language-agnostic rather than language-less. This is
/// the authoritative source for the language picker — the catalog's `languages`
/// string is only a pre-download blurb.
#[command]
pub async fn transcribe_model_languages() -> Result<Option<Vec<String>>, String> {
    Ok(engine()?.model_languages().await)
}

#[cfg(test)]
mod recording_model_tests {
    //! The resolver the pre-flight and the pre-check share, as a pure function. (#182)
    use super::*;
    use std::collections::HashSet;
    use RecordingModelState as S;

    const X: &str = "whisper-tiny-q8";
    const OTHER: &str = "moonshine-tiny-q8";

    fn resolve(provider: Option<&str>, configured: Option<&str>, loaded: Option<&str>, catalogue: &[(&str, ModelStatus)], downloading: &[&str]) -> Resolution {
        let catalogue: Vec<(String, ModelStatus)> = catalogue.iter().map(|(n, s)| (n.to_string(), s.clone())).collect();
        let downloading: HashSet<String> = downloading.iter().map(|s| s.to_string()).collect();
        let inputs = ResolverInputs { provider, configured, loaded, catalogue: &catalogue, downloading: &downloading };
        resolve_recording_model(&inputs, |_| unreachable!("not a built-in provider"))
    }

    fn state(r: &Resolution) -> Option<S> {
        match r {
            Resolution::NotReady { state, .. } => Some(*state),
            _ => None,
        }
    }

    fn builtin(files: BuiltinFiles) -> Resolution {
        let inputs = ResolverInputs { provider: Some("builtin-ai"), configured: Some(""), loaded: None, catalogue: &[], downloading: &HashSet::new() };
        resolve_recording_model(&inputs, |_| files.clone())
    }

    #[test]
    fn an_on_device_model_is_ready_with_both_files_and_says_which_is_missing_otherwise() {
        let both = vec![("w.gguf".to_string(), true), ("mmproj.gguf".to_string(), true)];
        assert_eq!(builtin(Ok(both)), Resolution::Ready(crate::config::DEFAULT_BUILTIN_TRANSCRIBE_MODEL.to_string()));
        let no_projector = builtin(Ok(vec![("w.gguf".to_string(), true), ("mmproj.gguf".to_string(), false)]));
        assert_eq!(state(&no_projector), Some(S::Missing));
        assert!(matches!(&no_projector, Resolution::NotReady { message, .. } if message.ends_with("mmproj.gguf is missing")), "{no_projector:?}");
        let unknown = builtin(Err("gemma9 cannot transcribe audio".into()));
        assert_eq!(unknown, Resolution::NotReady { model: crate::config::DEFAULT_BUILTIN_TRANSCRIBE_MODEL.into(), state: S::Error, message: "gemma9 cannot transcribe audio".into() });
    }

    #[test]
    fn a_model_on_disk_needs_a_load_unless_it_is_the_one_resident() {
        assert_eq!(resolve(None, Some(X), None, &[(X, ModelStatus::Available)], &[]), Resolution::NeedsLoad(X.into()));
        // Another model resident is not this one: it needs a load, never `Ready` (validate loads only then).
        assert_eq!(resolve(None, Some(X), Some(OTHER), &[(X, ModelStatus::Available), (OTHER, ModelStatus::Available)], &[]), Resolution::NeedsLoad(X.into()));
        assert_eq!(resolve(None, Some(X), Some(X), &[(X, ModelStatus::Available)], &[]), Resolution::Ready(X.into()));
    }

    #[test]
    fn another_model_on_disk_does_not_make_the_chosen_one_ready() {
        let r = resolve(None, Some(X), None, &[(X, ModelStatus::Missing), (OTHER, ModelStatus::Available)], &[]);
        assert_eq!(state(&r), Some(S::Missing), "{r:?}");
        // Nor does another model downloading make it "downloading".
        let r = resolve(None, Some(X), None, &[(X, ModelStatus::Missing), (OTHER, ModelStatus::Downloading { progress: 40 })], &[OTHER]);
        assert_eq!(state(&r), Some(S::Missing), "{r:?}");
    }

    #[test]
    fn a_download_in_flight_is_downloading_below_and_above_ninety_percent() {
        let below = resolve(None, Some(X), None, &[(X, ModelStatus::Downloading { progress: 40 })], &[X]);
        assert_eq!(state(&below), Some(S::Downloading));
        // Past 90% the file reads `Available`; the download in flight is checked first.
        let above = resolve(None, Some(X), None, &[(X, ModelStatus::Available)], &[X]);
        assert_eq!(state(&above), Some(S::Downloading), "{above:?}");
        // Before its first bytes the file is absent, or short: still the download's.
        assert_eq!(state(&resolve(None, Some(X), None, &[(X, ModelStatus::Missing)], &[X])), Some(S::Downloading));
    }

    #[test]
    fn corrupted_and_failed_models_are_not_ready() {
        let corrupted = resolve(None, Some(X), None, &[(X, ModelStatus::Corrupted { file_size: 10, expected_min_size: 100 })], &[]);
        assert_eq!(state(&corrupted), Some(S::Corrupted));
        assert_eq!(state(&resolve(None, Some(X), None, &[(X, ModelStatus::Error("bad".into()))], &[])), Some(S::Error));
    }

    #[test]
    fn an_empty_model_falls_back_to_the_default_and_an_unlisted_name_is_missing() {
        assert_eq!(resolve(None, Some(""), None, &[(DEFAULT_TRANSCRIBE_MODEL, ModelStatus::Available)], &[]), Resolution::NeedsLoad(DEFAULT_TRANSCRIBE_MODEL.into()));
        assert_eq!(resolve(None, None, None, &[(DEFAULT_TRANSCRIBE_MODEL, ModelStatus::Available)], &[]), Resolution::NeedsLoad(DEFAULT_TRANSCRIBE_MODEL.into()));
        // `ConfigContext`'s fallback name, which the catalogue does not list.
        let r = resolve(None, Some("parakeet-tdt-0.6b-v3-int8"), None, &[(DEFAULT_TRANSCRIBE_MODEL, ModelStatus::Available)], &[]);
        assert_eq!(r.clone(), Resolution::NotReady {
            model: "parakeet-tdt-0.6b-v3-int8".into(),
            state: S::Missing,
            message: "Transcription model 'parakeet-tdt-0.6b-v3-int8' is not downloaded yet. Download it in Settings, then start recording.".into(),
        });
    }

    #[test]
    fn the_configured_on_device_model_is_the_one_examined() {
        let inputs = ResolverInputs { provider: Some("builtin-ai"), configured: Some("gemma4:e4b"), loaded: None, catalogue: &[], downloading: &HashSet::new() };
        let asked = std::cell::RefCell::new(Vec::new());
        let r = resolve_recording_model(&inputs, |m| {
            asked.borrow_mut().push(m.to_string());
            Ok(vec![("w.gguf".to_string(), true), ("mmproj.gguf".to_string(), true)])
        });
        assert_eq!(r, Resolution::Ready("gemma4:e4b".into()));
        assert_eq!(asked.into_inner(), vec!["gemma4:e4b".to_string()]);
        // The weights are checked as well as the projector.
        let no_weights = builtin(Ok(vec![("w.gguf".to_string(), false), ("mmproj.gguf".to_string(), true)]));
        assert!(matches!(&no_weights, Resolution::NotReady { state: S::Missing, message, .. } if message.ends_with("w.gguf is missing")), "{no_weights:?}");
    }

    /// The pre-flight keeps a needed load apart, since validation loads only on it; the pre-check's
    /// answer folds it into ready. (#182 v4, round 3's first point)
    #[test]
    fn the_pre_flight_keeps_a_needed_load_and_the_answer_folds_it() {
        assert_eq!(pre_flight(Resolution::NeedsLoad(X.into())), Ok(ModelReadiness::NeedsLoad(X.into())));
        assert_eq!(pre_flight(Resolution::Ready(X.into())), Ok(ModelReadiness::Ready(X.into())));
        assert_eq!(pre_flight(Resolution::NotReady { model: X.into(), state: S::Missing, message: "m".into() }), Err("m".to_string()));
        assert_eq!(answer("p".into(), Resolution::NeedsLoad(X.into())).state, S::Ready);
        assert_eq!(answer("p".into(), Resolution::Ready(X.into())).state, S::Ready);
        assert_eq!(answer("p".into(), Resolution::NotReady { model: X.into(), state: S::Corrupted, message: "m".into() }), RecordingModel { provider: "p".into(), model: X.into(), state: S::Corrupted });
    }

    /// The frontend reads these exact keys and strings (`useRecordingStart.ts`'s `RecordingModel`).
    #[test]
    fn the_answer_is_written_as_the_frontend_reads_it() {
        for (state, wire) in [(S::Ready, "ready"), (S::Missing, "missing"), (S::Downloading, "downloading"), (S::Corrupted, "corrupted"), (S::Error, "error")] {
            let json = serde_json::to_value(RecordingModel { provider: "transcribe-cpp".into(), model: X.into(), state }).unwrap();
            assert_eq!(json, serde_json::json!({ "provider": "transcribe-cpp", "model": X, "state": wire }));
        }
    }

    /// The engine half: the disk and the downloads in flight, read from a real engine on a temporary
    /// directory, so the headline change -- a file past its floor with a download in flight is refused --
    /// is held through the code that gathers it, not only through the pure resolver.
    #[tokio::test]
    async fn the_engine_half_reads_the_disk_and_the_downloads_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let engine = TranscribeEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
        let entry = &crate::config::TRANSCRIBE_MODEL_CATALOG[0];
        let other = &crate::config::TRANSCRIBE_MODEL_CATALOG[1];

        let r = resolve_with_engine(&engine, None, Some(entry.name)).await.unwrap();
        assert_eq!(state(&r), Some(S::Missing), "nothing on disk: {r:?}");

        // A sparse file at the catalogue size reads `Available` without writing its bytes.
        let full = entry.size_mb as u64 * 1024 * 1024;
        std::fs::File::create(dir.path().join(entry.filename)).unwrap().set_len(full).unwrap();
        assert_eq!(resolve_with_engine(&engine, None, Some(entry.name)).await.unwrap(), Resolution::NeedsLoad(entry.name.into()));

        // Another model's download in flight changes nothing for this one.
        engine.mark_download_in_flight(other.name).await;
        assert_eq!(resolve_with_engine(&engine, None, Some(entry.name)).await.unwrap(), Resolution::NeedsLoad(entry.name.into()));

        // Its own download in flight is refused, though the file reads `Available`.
        engine.mark_download_in_flight(entry.name).await;
        let r = resolve_with_engine(&engine, None, Some(entry.name)).await.unwrap();
        assert_eq!(state(&r), Some(S::Downloading), "{r:?}");
    }

    /// The stored config's provider and model reach the resolver: a pre-check that read neither would
    /// ask about the default model, which is #182's defect again (the gate's round-2 adversary, M8).
    #[test]
    fn the_stored_choice_is_what_the_resolver_is_asked_about() {
        use crate::api::api::TranscriptConfig;
        let stored = Ok(Some(TranscriptConfig { provider: "transcribe-cpp".into(), model: X.into(), api_key: None }));
        assert_eq!(stored_choice(&stored), (Some("transcribe-cpp".to_string()), Some(X.to_string())));
        assert_eq!(stored_choice(&Ok(None)), (None, None));
        assert_eq!(stored_choice(&Err("no database".into())), (None, None));
    }

    /// The production file list for an on-device model: the configured model's own files, the
    /// weights and the projector, each read from disk (M5, M6).
    #[test]
    fn an_on_device_models_files_are_its_own_and_both_are_read_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let app_data_dir = dir.path().to_path_buf();
        let paths = |model: &str| {
            let weights = crate::summary::summary_engine::models::get_model_path(&app_data_dir, model).unwrap();
            let projector = crate::summary::summary_engine::models::get_mmproj_path(&app_data_dir, model).unwrap().unwrap();
            (weights, projector)
        };
        let (e4b_weights, e4b_projector) = paths("gemma4:e4b");
        let (e2b_weights, _) = paths("gemma4:e2b");
        assert_ne!(e4b_weights, e2b_weights, "precondition: the two tiers have different weights");

        let names = |files: &BuiltinFiles| files.as_ref().unwrap().iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
        let present = |files: &BuiltinFiles| files.as_ref().unwrap().iter().map(|(_, p)| *p).collect::<Vec<_>>();
        let files = builtin_files(&app_data_dir, "gemma4:e4b");
        assert_eq!(
            names(&files),
            vec![e4b_weights.file_name().unwrap().to_string_lossy().into_owned(), e4b_projector.file_name().unwrap().to_string_lossy().into_owned()]
        );
        assert_eq!(present(&files), vec![false, false]);

        for p in [&e4b_weights, &e4b_projector] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        assert_eq!(present(&builtin_files(&app_data_dir, "gemma4:e4b")), vec![true, true]);
        std::fs::remove_file(&e4b_weights).unwrap();
        assert_eq!(present(&builtin_files(&app_data_dir, "gemma4:e4b")), vec![false, true], "the weights are read from disk too");
        assert!(builtin_files(&app_data_dir, "no-such-model").is_err());
    }

    /// Recording's pre-flight refuses every state but ready with today's message (#182 v4).
    #[test]
    fn the_pre_flight_refuses_each_state_with_todays_message() {
        let today = format!("Transcription model '{X}' is not downloaded yet. Download it in Settings, then start recording.");
        for (status, downloading) in [
            (ModelStatus::Missing, false),
            (ModelStatus::Available, true),
            (ModelStatus::Corrupted { file_size: 1, expected_min_size: 2 }, false),
            (ModelStatus::Error("x".into()), false),
        ] {
            let r = resolve(None, Some(X), None, &[(X, status.clone())], if downloading { &[X] } else { &[] });
            assert!(matches!(&r, Resolution::NotReady { message, .. } if *message == today), "{status:?}: {r:?}");
        }
    }
}


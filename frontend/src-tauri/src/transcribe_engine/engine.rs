// transcribe_engine/engine.rs
//
// Model management and transcription on top of transcribe.cpp. Replaces both
// WhisperEngine (whisper-rs) and ParakeetEngine (ONNX Runtime): one GGUF
// runtime covers both families, so there is one engine, one models directory
// layout, and one download path.
//
// Threading contract inherited from transcribe.cpp:
//   - `Model` is Arc-backed, Send + Sync, cheap to clone.
//   - `Session` is Send but NOT Sync; its mutating calls take &mut self.
//   - At most ONE in-flight compute (run OR active stream) per Model. A batch
//     run attempted while a stream is live fails with Error::Busy.
// This engine therefore owns the Model and hands out Sessions; whoever drives a
// stream owns its Session for the stream's lifetime.

use anyhow::{anyhow, Result};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use transcribe_cpp::{Diarize, Model, RunOptions, Session, Transcript};

use crate::config::{
    transcribe_model, DEFAULT_TRANSCRIBE_MODEL, TRANSCRIBE_MODEL_BASE_URL,
    TRANSCRIBE_MODEL_CATALOG,
};
// Same shape the summary-model download already reports; the UI renders both
// with the same MB/speed widgets, so there is one struct, not two.
pub use crate::summary::summary_engine::model_manager::DownloadProgress;

/// Mirrors the shape the frontend model manager already consumes, so the UI
/// keeps its existing status handling.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelStatus {
    Available,
    Missing,
    Downloading { progress: u8 },
    Error(String),
    Corrupted { file_size: u64, expected_min_size: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub path: PathBuf,
    pub size_mb: u32,
    pub accuracy: String,
    /// Measured WER for this quantization, and the set it was measured on.
    /// Always shown together — see `TranscribeModel::wer`.
    pub wer: Option<f32>,
    pub wer_set: String,
    pub speed: String,
    pub status: ModelStatus,
    pub description: String,
    /// Whether the picker may offer this model for live recording without the
    /// VAD-segmented fallback. Catalog metadata, so it is known before download.
    pub streaming: bool,
    /// The model's own advertised language codes, from the catalog's harvest of
    /// `general.languages`. The UI renders names from these and filters on them.
    pub languages: Vec<String>,
    /// Whether the picker marks this row "Recommended". Every row is listed
    /// either way — this is a label, not a filter.
    pub recommended: bool,
    pub diarizes: bool,
}

/// A batch transcription result.
///
/// `confidence` is the mean per-token probability transcribe.cpp reports. This comment used to say
/// *"every supported family provides it, so unlike the old Parakeet path it is never absent"*, and
/// that was false (#162): most families report none, and they encode it as a value rather than as an
/// absence. `gigaam-v3-ctc` leaves every `p` at the zero sentinel, so this field is **0.0** for it —
/// `import.rs` duly logs `avg confidence: 0.00` — and the 53 catalogue rows whose architecture builds
/// no token row at all get `mean_token_confidence`'s 1.0. Both callers (`import.rs:590`,
/// `retranscription.rs:492`) use it only in an `info!` line, and their row tuples have no confidence
/// field, so nothing decides on it. Anything that starts deciding must go through
/// `scored_confidence`, which answers `None` rather than a number nobody computed.
#[derive(Debug, Clone)]
pub struct BatchResult {
    pub text: String,
    pub confidence: f32,
    pub turns: Vec<SpeakerTurn>,
}

pub struct TranscribeEngine {
    models_dir: PathBuf,
    model: Arc<RwLock<Option<Model>>>,
    current_model: Arc<RwLock<Option<String>>>,
    available_models: Arc<RwLock<HashMap<String, ModelInfo>>>,
    cancel_download_flag: Arc<RwLock<Option<String>>>,
    active_downloads: Arc<RwLock<HashSet<String>>>,
}

impl TranscribeEngine {
    pub fn new() -> Result<Self> {
        Self::new_with_models_dir(None)
    }

    /// `models_dir` is provided by the caller in production (app data dir); the
    /// dev fallback mirrors what WhisperEngine did so local runs keep working.
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        // transcribe.cpp logs ggml/Metal kernel compilation to stderr at load.
        // It exposes a real logging switch, so the stderr-redirect hack the old
        // whisper path needed (_stderr_suppressor.rs) is not required here.
        transcribe_cpp::disable_logging();

        let models_dir = match models_dir {
            Some(dir) => dir,
            None => {
                let current_dir = std::env::current_dir()
                    .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;
                if cfg!(debug_assertions) {
                    if current_dir.join("models").exists() {
                        current_dir.join("models")
                    } else if current_dir.join("../models").exists() {
                        current_dir.join("../models")
                    } else {
                        current_dir.join("models")
                    }
                } else {
                    warn!("TranscribeEngine: No models directory provided, using fallback path");
                    dirs::data_dir()
                        .or_else(dirs::home_dir)
                        .ok_or_else(|| anyhow!("Could not find system data directory"))?
                        .join("Conversationaly")
                        .join("models")
                }
            }
        };

        info!("TranscribeEngine using models directory: {}", models_dir.display());
        if !models_dir.exists() {
            std::fs::create_dir_all(&models_dir)?;
        }

        Ok(Self {
            models_dir,
            model: Arc::new(RwLock::new(None)),
            current_model: Arc::new(RwLock::new(None)),
            available_models: Arc::new(RwLock::new(HashMap::new())),
            cancel_download_flag: Arc::new(RwLock::new(None)),
            active_downloads: Arc::new(RwLock::new(HashSet::new())),
        })
    }

    pub async fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }

    pub async fn discover_models(&self) -> Result<Vec<ModelInfo>> {
        let mut models = Vec::new();

        for entry in TRANSCRIBE_MODEL_CATALOG {
            let (name, filename, size_mb) = (entry.name, entry.filename, entry.size_mb);
            let path = self.models_dir.join(filename);
            let status = if path.exists() {
                let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                // 90% of the catalog size, same tolerance the whisper path used:
                // catches truncated downloads without tripping on quantization
                // rounding.
                let expected_min = (size_mb as u64 * 1024 * 1024 * 9) / 10;
                if file_size >= expected_min {
                    ModelStatus::Available
                } else if let ModelStatus::Downloading { progress } = self
                    .available_models
                    .read()
                    .await
                    .get(name)
                    .map(|m| m.status.clone())
                    .unwrap_or(ModelStatus::Missing)
                {
                    ModelStatus::Downloading { progress }
                } else {
                    warn!(
                        "Model {} is {} bytes, expected at least {}",
                        filename, file_size, expected_min
                    );
                    ModelStatus::Corrupted { file_size, expected_min_size: expected_min }
                }
            } else {
                ModelStatus::Missing
            };

            models.push(ModelInfo {
                name: name.to_string(),
                path,
                size_mb,
                accuracy: entry.accuracy.to_string(),
                wer: entry.wer,
                wer_set: entry.wer_set.to_string(),
                speed: entry.speed.to_string(),
                status,
                description: entry.description.to_string(),
                streaming: entry.streaming,
                languages: entry.languages.iter().map(|s| s.to_string()).collect(),
                recommended: crate::config::is_recommended_model(name),
                diarizes: crate::config::model_diarizes(name),
            });
        }

        let mut cache = self.available_models.write().await;
        cache.clear();
        for m in &models {
            cache.insert(m.name.clone(), m.clone());
        }
        Ok(models)
    }

    pub async fn load_model(&self, model_name: &str) -> Result<()> {
        let entry = transcribe_model(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;
        let path = self.models_dir.join(entry.filename);
        if !path.exists() {
            return Err(anyhow!(
                "Model '{}' is not downloaded. Download it from settings first.",
                model_name
            ));
        }

        info!("Loading model {} from {}", model_name, path.display());
        let started = std::time::Instant::now();
        // Model::load does GPU init and is blocking; keep it off the async
        // reactor so a slow first Metal kernel compile can't stall other tasks.
        let owned_path = path.clone();
        let model = tokio::task::spawn_blocking(move || Model::load(&owned_path))
            .await
            .map_err(|e| anyhow!("Model load task panicked: {}", e))?
            .map_err(|e| anyhow!("Failed to load model '{}': {}", model_name, e))?;

        // No streaming requirement here: most of the catalog is batch-only, and
        // the live path decodes those with VAD + `Session::run()` per segment
        // (see audio/transcription/stream_worker.rs).
        let caps = model.capabilities();
        info!(
            "Loaded {} in {:?} (backend {}, {} languages, streaming {})",
            model_name,
            started.elapsed(),
            model.backend(),
            caps.languages.len(),
            caps.supports_streaming
        );

        *self.model.write().await = Some(model);
        *self.current_model.write().await = Some(model_name.to_string());
        Ok(())
    }

    pub async fn unload_model(&self) -> bool {
        let had = self.model.write().await.take().is_some();
        *self.current_model.write().await = None;
        had
    }

    pub async fn is_model_loaded(&self) -> bool {
        self.model.read().await.is_some()
    }

    pub async fn get_current_model(&self) -> Option<String> {
        self.current_model.read().await.clone()
    }

    /// Hand out a Session for the caller to drive. The live recording path uses
    /// this and holds the Session for the meeting; batch callers should prefer
    /// [`transcribe_batch`].
    pub async fn open_session(&self) -> Result<Session> {
        let guard = self.model.read().await;
        let model = guard.as_ref().ok_or_else(|| anyhow!("No model loaded"))?;
        model.session().map_err(|e| anyhow!("Failed to open session: {}", e))
    }

    /// Language codes the loaded model advertises, read from GGUF metadata.
    ///
    /// Empty means the model is language-agnostic (it advertises no list), which
    /// callers should treat as "any language", not "no languages".
    pub async fn model_languages(&self) -> Option<Vec<String>> {
        let guard = self.model.read().await;
        Some(guard.as_ref()?.capabilities().languages)
    }

    /// Resolve a stored language preference against the loaded model.
    ///
    /// Every path that turns a user preference into `RunOptions::language` goes
    /// through here or through [`transcribe_batch`], because transcribe.cpp
    /// rejects an unrecognized code outright rather than ignoring it — and on
    /// the live path that kills the stream before a single sample decodes.
    pub async fn resolve_language(&self, preference: Option<String>) -> Option<String> {
        let preference = preference?;
        let advertised = self.model_languages().await.unwrap_or_default();
        let resolved = match_advertised_language(&advertised, &preference);
        if resolved.is_none() && !is_auto_language(&preference) {
            warn!(
                "Loaded model does not support language '{}' (it advertises {:?}); \
                 falling back to the model's own detection",
                preference, advertised
            );
        }
        resolved
    }

    /// One-shot transcription for import / retranscription.
    ///
    /// ponytail: shares the live path's Model, so this returns Error::Busy if a
    /// recording stream is active. Give the batch path its own `Model::load`
    /// (~300ms) if importing during a recording ever needs to work.
    pub async fn transcribe_batch(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> Result<BatchResult> {
        let language = self.resolve_language(language).await;
        let diarizes = self
            .get_current_model()
            .await
            .as_deref()
            .is_some_and(crate::config::model_diarizes);
        let mut session = self.open_session().await?;
        let options = RunOptions {
            language,
            diarize: if diarizes { Diarize::On } else { Diarize::Default },
            ..Default::default()
        };

        let transcript = tokio::task::spawn_blocking(move || {
            keep_partial_on_truncation(session.run(&audio, &options))
        })
            .await
            .map_err(|e| anyhow!("Transcription task panicked: {}", e))?
            .map_err(|e| anyhow!("Transcription failed: {}", e))?;

        Ok(BatchResult {
            confidence: mean_token_confidence(&transcript),
            text: transcript.text.trim().to_string(),
            turns: speaker_turns(&transcript),
        })
    }

    pub async fn download_model(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        let entry = transcribe_model(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;
        self.download_file(model_name, entry.hf_repo, entry.filename, progress_callback)
            .await
    }

    /// Download a GGUF by repo and filename, with no catalog lookup.
    ///
    /// The speaker diarizer is the only caller that is not a catalog row: it is
    /// not a transcription model and must never reach the picker, but it still
    /// wants this path's cancellation, progress reporting and — the part worth
    /// not reimplementing — the partial-file cleanup below.
    pub async fn download_file(
        &self,
        model_name: &str,
        repo: &str,
        filename: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        {
            let mut active = self.active_downloads.write().await;
            if !active.insert(model_name.to_string()) {
                return Err(anyhow!("Model '{}' is already downloading", model_name));
            }
        }
        // Clear any cancel request left over from a previous attempt.
        {
            let mut flag = self.cancel_download_flag.write().await;
            if flag.as_deref() == Some(model_name) {
                *flag = None;
            }
        }

        let result = self
            .download_inner(model_name, repo, filename, progress_callback)
            .await;

        self.active_downloads.write().await.remove(model_name);
        if result.is_err() {
            // Never leave a partial file behind: discover_models would report it
            // as Corrupted and the user would have to delete it by hand.
            let _ = fs::remove_file(self.models_dir.join(filename)).await;
        }
        result
    }

    async fn download_inner(
        &self,
        model_name: &str,
        repo: &str,
        filename: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        let url = format!(
            "{}/{}/resolve/main/{}",
            TRANSCRIBE_MODEL_BASE_URL, repo, filename
        );
        let file_path = self.models_dir.join(filename);
        info!("Downloading {} -> {}", url, file_path.display());

        if !self.models_dir.exists() {
            fs::create_dir_all(&self.models_dir).await?;
        }
        self.set_status(model_name, ModelStatus::Downloading { progress: 0 })
            .await;

        let response = reqwest::Client::new()
            .get(&url)
            .send()
            .await
            .map_err(|e| anyhow!("Failed to start download: {}", e))?;
        if !response.status().is_success() {
            return Err(anyhow!("Download failed with status: {}", response.status()));
        }

        let total_size = response.content_length().unwrap_or(0);
        let mut file = fs::File::create(&file_path).await?;

        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0u64;
        let mut last_reported = 0u8;
        let mut last_report_time = std::time::Instant::now();
        let mut bytes_since_report = 0u64;

        if let Some(ref cb) = progress_callback {
            cb(DownloadProgress::new(0, total_size, 0.0));
        }

        while let Some(chunk) = stream.next().await {
            if self.cancel_download_flag.read().await.as_deref() == Some(model_name) {
                *self.cancel_download_flag.write().await = None;
                return Err(anyhow!("Download cancelled by user"));
            }

            let chunk = chunk.map_err(|e| anyhow!("Failed to read chunk: {}", e))?;
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            bytes_since_report += chunk.len() as u64;

            if total_size > 0 {
                let progress = ((downloaded as f64 / total_size as f64) * 100.0) as u8;
                let elapsed = last_report_time.elapsed();
                // Percent alone ticks once per ~7 MB on a 716 MB model, which
                // leaves the speed readout stale; the 500 ms floor keeps it live.
                if progress > last_reported || elapsed.as_millis() >= 500 {
                    let speed_mbps = if elapsed.as_secs_f64() > 0.0 {
                        (bytes_since_report as f64 / 1048576.0) / elapsed.as_secs_f64()
                    } else {
                        0.0
                    };
                    last_reported = progress;
                    last_report_time = std::time::Instant::now();
                    bytes_since_report = 0;

                    self.set_status(model_name, ModelStatus::Downloading { progress })
                        .await;
                    if let Some(ref cb) = progress_callback {
                        cb(DownloadProgress::new(downloaded, total_size, speed_mbps));
                    }
                }
            }
        }

        file.flush().await?;
        drop(file);

        self.set_status(model_name, ModelStatus::Available).await;
        info!(
            "Downloaded {} ({:.1} MB)",
            model_name,
            downloaded as f64 / 1048576.0
        );
        Ok(())
    }

    pub async fn cancel_download(&self, model_name: &str) -> Result<()> {
        if !self.active_downloads.read().await.contains(model_name) {
            return Err(anyhow!("No active download for '{}'", model_name));
        }
        *self.cancel_download_flag.write().await = Some(model_name.to_string());
        Ok(())
    }

    pub async fn delete_model(&self, model_name: &str) -> Result<()> {
        let entry = transcribe_model(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;
        let path = self.models_dir.join(entry.filename);

        if self.get_current_model().await.as_deref() == Some(model_name) {
            self.unload_model().await;
        }
        if path.exists() {
            fs::remove_file(&path).await?;
            info!("Deleted model file {}", path.display());
        }
        self.set_status(model_name, ModelStatus::Missing).await;
        Ok(())
    }

    async fn set_status(&self, model_name: &str, status: ModelStatus) {
        if let Some(info) = self.available_models.write().await.get_mut(model_name) {
            info.status = status;
        }
    }

    /// Delete model files left over from the whisper-rs / ONNX engines.
    ///
    /// transcribe.cpp reads GGUF only, so legacy `ggml-*.bin` files and the
    /// Parakeet ONNX directory are dead weight — multiple GB of it for anyone
    /// who had large-v3. Runs once at startup; failures are logged, never fatal.
    pub fn purge_legacy_models(models_dir: &std::path::Path) -> u64 {
        let mut freed = 0u64;

        let entries = match std::fs::read_dir(models_dir) {
            Ok(e) => e,
            Err(e) => {
                warn!("Could not scan models directory for legacy files: {}", e);
                return 0;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Legacy whisper: ggml-<model>.bin at the top level.
            let is_legacy_whisper = name.starts_with("ggml-") && name.ends_with(".bin");
            // Legacy parakeet: a `parakeet` directory of .onnx files + vocab.txt.
            let is_legacy_parakeet = path.is_dir() && name == "parakeet";

            if !is_legacy_whisper && !is_legacy_parakeet {
                continue;
            }

            let size = dir_or_file_size(&path);
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };

            match removed {
                Ok(()) => {
                    info!("Removed legacy model {} ({:.1} MB)", name, size as f64 / 1048576.0);
                    freed += size;
                }
                Err(e) => warn!("Could not remove legacy model {}: {}", name, e),
            }
        }

        if freed > 0 {
            info!(
                "Reclaimed {:.1} MB from models that the previous engines used",
                freed as f64 / 1048576.0
            );
        }
        freed
    }
}

fn dir_or_file_size(path: &std::path::Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| dir_or_file_size(&e.path())).sum())
        .unwrap_or(0)
}

/// "Transcribe in whatever language you hear" sentinels the picker stores.
/// Neither is a language code, so neither may reach `RunOptions::language`.
fn is_auto_language(preference: &str) -> bool {
    matches!(preference.trim(), "" | "auto" | "auto-translate")
}

/// Match a stored language preference against the codes a model advertises.
///
/// transcribe.cpp compares `RunOptions::language` to the GGUF language list with
/// an exact `strcmp` and rejects a miss with `TRANSCRIBE_ERR_UNSUPPORTED_LANGUAGE`
/// — on the live path that aborts `stream()` before any audio decodes. Two things
/// make a miss the normal case rather than a rare one:
///   - the picker stores bare ISO-639-1 ("de") while models such as Nemotron
///     advertise locales ("de-DE"), and
///   - "auto"/"auto-translate" are UI sentinels, not codes.
///
/// `None` means "let the model detect it", which is also what a genuinely
/// unsupported language falls back to: a transcript in the wrong language beats
/// no transcript at all.
fn match_advertised_language(advertised: &[String], preference: &str) -> Option<String> {
    let pref = preference.trim();
    if is_auto_language(pref) {
        return None;
    }
    // An empty list means the model advertises nothing, i.e. language-agnostic —
    // not that it supports no languages. Pass the code through untouched.
    if advertised.is_empty() || advertised.iter().any(|l| l == pref) {
        return Some(pref.to_string());
    }
    // "de" -> "de-DE". First match wins: where a model lists several locales for
    // one language (en-US/en-GB, pt-BR/pt-PT) the order is the model's own, and
    // any of them transcribes that language.
    let primary = primary_subtag(pref);
    advertised
        .iter()
        .find(|l| primary_subtag(l).eq_ignore_ascii_case(primary))
        .cloned()
}

fn primary_subtag(code: &str) -> &str {
    code.split('-').next().unwrap_or(code)
}

/// Mean per-token probability. transcribe.cpp reports `p` on every token, so
/// this replaces the old provider-specific confidence handling (Whisper had a
/// score, Parakeet had none).
#[derive(Debug, Clone, PartialEq)]
pub struct SpeakerTurn {
    pub text: String,
    pub speaker_id: i32,
    pub start_ms: f64,
    pub end_ms: f64,
}

pub fn speaker_turns(transcript: &Transcript) -> Vec<SpeakerTurn> {
    if transcript.segments.iter().all(|s| s.speaker_id == 0) {
        return vec![];
    }

    let mut turns: Vec<SpeakerTurn> = Vec::new();
    for segment in &transcript.segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        match turns.last_mut() {
            Some(turn) if turn.speaker_id == segment.speaker_id => {
                turn.text.push(' ');
                turn.text.push_str(text);
                turn.end_ms = segment.t1_ms as f64;
            }
            _ => turns.push(SpeakerTurn {
                text: text.to_string(),
                speaker_id: segment.speaker_id,
                start_ms: segment.t0_ms as f64,
                end_ms: segment.t1_ms as f64,
            }),
        }
    }
    turns
}

/// The mean per-token probability, or `None` when this family filled none in.
///
/// **Measured 2026-09-10 (#162), on this machine, over `jfk.wav`:**
///
/// | family | tokens | `p` | mean |
/// | --- | --- | --- | --- |
/// | `parakeet-tdt-0.6b-v3-q8` (the default) | 38 | 0.92 … 1.0 | 0.9936 |
/// | `moonshine-tiny-q8` | 0 | — | 1.0, from the empty-token guard |
/// | `gigaam-v3-ctc-q8` | 91 | **every one exactly 0.0** | 0.0 |
///
/// The third row is the defect, and the value is not NaN. `transcribe-session.h:93` declares the
/// internal row as `float p = 0.0f;`, and `arch/gigaam/model.cpp:301-308` fills `id`, `text`, `t0_ms`
/// and `t1_ms` and never assigns `.p`. Upstream names the convention itself, in
/// `arch/moonshine_streaming/model.cpp:1032`: *"doesn't carry per-token timestamps or probabilities —
/// leave them at the **zero sentinel**"*. So the absence is encoded **inside the valid range**, where
/// no NaN check can see it, and `Some(0.0)` reached the UI as a red `0%` reading *Low confidence* on
/// every line of every recording.
///
/// A decode that produced ninety-one tokens of text did not assign exactly zero probability to all
/// ninety-one of them. All-zero across present rows is therefore read as "nobody filled these in",
/// which `ports.rs:54` already has a value for: *"`None` is not 'zero confidence' — it means this
/// decoder has nothing to report"*.
///
/// One nonzero token is enough to make the mean a real answer, so a model that genuinely scores a
/// line badly still warns. That distinction is the whole point: *nothing scored it* and *it scored
/// zero* are different facts, and only one of them is silence.
///
/// **An empty token list is the same answer, and it is the larger half.** Only five of eighteen
/// architectures construct a token row at all — `gigaam`, `medasr`, `moonshine_streaming`, `parakeet`
/// and `sensevoice` — and every other family returns none. Against `TRANSCRIBE_MODEL_CATALOG`'s 86
/// rows that is **53** which produce no tokens: Whisper 18, Granite Speech 8, Canary 5 + v2 2 +
/// Qwen 2, Qwen3-ASR 4, Voxtral 2 + Realtime 2, MOSS 2, Moonshine 2, FunASR 2 + 2, Cohere 2. For all
/// of them `mean_token_confidence` returns its "nothing was said" 1.0, and passing that on as a score
/// paints *"Decode confidence 100%"* in the timestamp tooltip and
/// `aria-label="Transcription confidence 100 percent, High confidence"` in the accessibility tree —
/// the exact thing `tauri_sink.rs:33` forbids, on the majority of the catalogue.
///
/// So `mean_token_confidence` keeps its 1.0, which is right for the question *it* answers (a decode
/// that produced nothing is not a decode that went badly), and this function does not turn that into
/// a claim about confidence.
///
/// NaN is still refused, because the ABI documents it for families that report nothing at all — and
/// `serde_json` cannot write a non-finite float, so `Some(NaN)` would reach the frontend as `null`.
pub fn scored_confidence(transcript: &Transcript) -> Option<f32> {
    if transcript.tokens.is_empty() || transcript.tokens.iter().all(|t| t.p == 0.0) {
        return None;
    }
    let mean = mean_token_confidence(transcript);
    mean.is_finite().then_some(mean)
}

pub fn mean_token_confidence(transcript: &Transcript) -> f32 {
    if transcript.tokens.is_empty() {
        // No tokens means no text; callers treat empty output as "nothing said"
        // rather than "low confidence", so don't report a misleading 0.0.
        return 1.0;
    }
    transcript.tokens.iter().map(|t| t.p).sum::<f32>() / transcript.tokens.len() as f32
}

/// Unwrap a `Session::run` outcome, keeping the text of a truncated decode.
///
/// A decode that reaches the model's generation budget before end-of-stream is
/// a partial result, not a failure: transcribe.cpp stops there and hands back
/// what it decoded on `Error::OutputTruncated`. Treating that as fatal threw
/// away usable text and aborted a whole import/retranscription on the first
/// dense segment that hit the cap.
pub fn keep_partial_on_truncation(
    outcome: std::result::Result<Transcript, transcribe_cpp::Error>,
) -> std::result::Result<Transcript, transcribe_cpp::Error> {
    match outcome {
        Err(transcribe_cpp::Error::OutputTruncated {
            message,
            partial: Some(partial),
        }) => {
            warn!("Decode hit the generation cap before end-of-stream ({message}); keeping the partial transcript for this segment");
            Ok(*partial)
        }
        other => other,
    }
}

/// The model the app falls back to when nothing is configured.
pub fn default_model_name() -> &'static str {
    DEFAULT_TRANSCRIBE_MODEL
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{RECOMMENDED_IMPORT_MODELS, RECOMMENDED_LIVE_MODELS};

    /// A segment whose decode hit the generation cap must still yield its text:
    /// dropping it aborted the entire retranscription of a meeting on one
    /// segment. Anything that is a real failure still has to fail.
    /// A decoder that scores nothing must say so, not score everything zero.
    ///
    /// Measured 2026-09-10 (#162): with `gigaam-v3-ctc-q8` every line of every recording carried a
    /// red `0%` "Low confidence" badge. `transcribe_cpp`'s own comment (`result.rs:77`) says
    /// `Token::p` is **NaN when the family produces none**; the mean of a set holding NaN is NaN;
    /// `segmented.rs:89` wrapped it in `Some`; `serde_json` cannot write a non-finite float so the
    /// event carried `confidence: null`; and the UI scored `null` as zero.
    ///
    /// `ports.rs:54` already says what the right answer is -- *"`None` is not zero confidence -- it
    /// means this decoder has nothing to report"*. This holds the producer to it.
    #[test]
    fn a_family_that_scores_nothing_reports_no_confidence() {
        let tok = |p: f32| transcribe_cpp::Token { p, ..Default::default() };

        // What `gigaam-v3-ctc` actually returns: present rows, every `p` left at the ABI's
        // zero-initialised value. Measured on jfk.wav — 91 tokens, 0 NaN, 91 exactly 0.0.
        let zeroed = Transcript {
            tokens: vec![tok(0.0), tok(0.0), tok(0.0)],
            text: "энд соу май фэл оу американс".to_string(),
            ..Default::default()
        };
        assert_eq!(
            scored_confidence(&zeroed),
            None,
            "ninety-one tokens of text at exactly zero probability is the zero-init rule showing \
             through, not a decode the model was certain was wrong"
        );

        // One real value among them makes the mean an answer again: a model that scores a line badly
        // must still warn. This is the assertion a careless "treat 0 as absent" fix breaks.
        let barely = Transcript { tokens: vec![tok(0.0), tok(0.0), tok(0.3)], ..Default::default() };
        let got = scored_confidence(&barely).expect("one real probability is a real mean");
        assert!((got - 0.1).abs() < 1e-6, "expected the mean 0.1, got {got}");

        // The ABI documents NaN as well, for a family that reports nothing at all.
        let unscored = Transcript { tokens: vec![tok(f32::NAN), tok(f32::NAN)], ..Default::default() };
        assert_eq!(
            scored_confidence(&unscored),
            None,
            "a family that reports no token probabilities must report no confidence, not zero"
        );

        // One NaN poisons the mean. A mean nobody can compute is still not a low score -- and this
        // is the smaller-blast-radius version of the same defect, so it is held separately.
        let partly = Transcript { tokens: vec![tok(0.9), tok(f32::NAN), tok(0.95)], ..Default::default() };
        assert_eq!(scored_confidence(&partly), None, "an uncomputable mean is not a score of zero");

        // A family that does score is untouched.
        let scored = Transcript { tokens: vec![tok(0.8), tok(0.6)], ..Default::default() };
        let got = scored_confidence(&scored).expect("a scored family still reports a number");
        assert!((got - 0.7).abs() < 1e-6, "expected the mean 0.7, got {got}");

        // No tokens at all is also nothing scored, and this is the larger half: 53 of
        // `TRANSCRIBE_MODEL_CATALOG`'s 86 rows come from an architecture that constructs no token row,
        // so `Some(1.0)` here painted "Decode confidence 100%" in the tooltip and *High confidence*
        // in the accessibility tree for most of the catalogue.
        //
        // This assertion used to require `Some(1.0)` and say *"an empty decode is 'nothing said', not
        // 'nothing scored'"*. Both halves of that sentence are true of `mean_token_confidence`, which
        // still answers 1.0 for its own question; neither makes 1.0 a confidence. The assertion was
        // encoding the defect, so it is inverted rather than kept (ADR 0023).
        assert_eq!(
            scored_confidence(&Transcript::default()),
            None,
            "a decode with no tokens scored nothing, whatever the mean of an empty set is called"
        );
    }

    #[test]
    fn truncated_decode_keeps_its_partial_transcript() {
        let kept = keep_partial_on_truncation(Err(transcribe_cpp::Error::OutputTruncated {
            message: "run: output truncated".to_string(),
            partial: Some(Box::new(Transcript {
                text: "half a sentence".to_string(),
                ..Default::default()
            })),
        }))
        .expect("a truncated decode still yields the text it produced");
        assert_eq!(kept.text, "half a sentence");

        assert!(keep_partial_on_truncation(Err(transcribe_cpp::Error::Busy(
            "a stream is active".to_string()
        )))
        .is_err());
    }

    #[test]
    fn catalog_rows_are_downloadable_and_defaults_resolve() {
        // The catalog is no longer streaming-only: batch-only families are
        // selectable because the live path falls back to VAD segmentation. What
        // still has to hold is that every row can actually be fetched and that
        // the names the app hardcodes exist.
        assert!(transcribe_model(DEFAULT_TRANSCRIBE_MODEL).is_some());
        for e in TRANSCRIBE_MODEL_CATALOG {
            assert!(e.filename.ends_with(".gguf"), "{} is not a GGUF file", e.name);
            assert!(e.size_mb > 0, "{} has no size", e.name);
            assert!(!e.hf_repo.is_empty(), "{} has no HF repo", e.name);
            assert!(!e.languages.is_empty(), "{} has no advertised languages", e.name);
            // The generator derives the name from the filename, so a mismatch
            // means a hand-edit crept into the generated block.
            let stem = e.filename.trim_end_matches(".gguf").to_lowercase();
            let (variant, quant) = e.name.rsplit_once('-').unwrap();
            assert!(
                stem.starts_with(variant) && stem.ends_with(&quant_suffix(quant)),
                "{} does not match its filename {}",
                e.name,
                e.filename
            );
        }
        assert!(
            TRANSCRIBE_MODEL_CATALOG.iter().any(|e| e.streaming),
            "no live-capable model left in the catalog"
        );
        // The default is the one deliberate exception: it trades streaming for
        // WER. Every other recommendation still has to stream, so a batch-only
        // row cannot pick up the label by accident.
        for name in RECOMMENDED_LIVE_MODELS {
            let m = transcribe_model(name).expect("recommended live model not in catalog");
            assert!(
                m.streaming || *name == DEFAULT_TRANSCRIBE_MODEL,
                "{} is recommended for live but cannot stream",
                name
            );
        }
        for name in RECOMMENDED_IMPORT_MODELS {
            assert!(
                transcribe_model(name).is_some(),
                "recommended import model {} not in catalog",
                name
            );
        }
    }

    fn quant_suffix(short: &str) -> String {
        match short {
            "q8" => "-q8_0".to_string(),
            "q4" => "-q4_k_m".to_string(),
            other => panic!("unexpected quantization suffix {other}"),
        }
    }

    #[tokio::test]
    async fn discovery_reports_missing_available_and_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let engine = TranscribeEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();

        // Nothing on disk yet.
        let models = engine.discover_models().await.unwrap();
        assert_eq!(models.len(), TRANSCRIBE_MODEL_CATALOG.len());
        assert!(models.iter().all(|m| matches!(m.status, ModelStatus::Missing)));

        let entry = &TRANSCRIBE_MODEL_CATALOG[0];
        let (name, filename, size_mb) = (entry.name, entry.filename, entry.size_mb);

        // A truncated download must not be reported as usable.
        std::fs::write(dir.path().join(filename), vec![0u8; 1024]).unwrap();
        let models = engine.discover_models().await.unwrap();
        let m = models.iter().find(|m| m.name == name).unwrap();
        assert!(
            matches!(m.status, ModelStatus::Corrupted { .. }),
            "a 1KB file for a {}MB model should be Corrupted, got {:?}",
            size_mb,
            m.status
        );

        // Full size (the catalog value) is Available.
        std::fs::write(
            dir.path().join(filename),
            vec![0u8; size_mb as usize * 1024 * 1024],
        )
        .unwrap();
        let models = engine.discover_models().await.unwrap();
        let m = models.iter().find(|m| m.name == name).unwrap();
        assert!(matches!(m.status, ModelStatus::Available), "got {:?}", m.status);
    }

    #[test]
    fn purge_removes_only_legacy_engine_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();

        // Legacy: must go.
        std::fs::write(p.join("ggml-large-v3-turbo.bin"), b"x".repeat(1000)).unwrap();
        std::fs::write(p.join("ggml-tiny.bin"), b"x".repeat(500)).unwrap();
        std::fs::create_dir(p.join("parakeet")).unwrap();
        std::fs::write(p.join("parakeet/encoder-model.int8.onnx"), b"x".repeat(200)).unwrap();

        // Must survive: the new models, and the summary LLMs which live in the
        // same directory and have nothing to do with transcription.
        std::fs::write(p.join("nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf"), b"keep").unwrap();
        std::fs::create_dir(p.join("summary")).unwrap();
        std::fs::write(p.join("summary/model.gguf"), b"keep").unwrap();

        let freed = TranscribeEngine::purge_legacy_models(p);

        assert_eq!(freed, 1700, "should report bytes actually reclaimed");
        assert!(!p.join("ggml-large-v3-turbo.bin").exists());
        assert!(!p.join("ggml-tiny.bin").exists());
        assert!(!p.join("parakeet").exists());
        assert!(p.join("nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf").exists());
        assert!(p.join("summary/model.gguf").exists(), "summary LLMs must not be touched");

        // Idempotent: a second launch finds nothing to do.
        assert_eq!(TranscribeEngine::purge_legacy_models(p), 0);
    }

    /// Exactly what Nemotron 3.5 streaming advertises in `general.languages`.
    fn nemotron_languages() -> Vec<String> {
        ["en-US", "en-GB", "es-US", "de-DE", "fr-FR", "fr-CA", "pt-BR", "pt-PT"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn bare_iso_code_resolves_to_the_advertised_locale() {
        // The bug: the picker stores "de", the model advertises "de-DE", and
        // transcribe.cpp strcmp's them and aborts the stream with status 10.
        let langs = nemotron_languages();
        assert_eq!(match_advertised_language(&langs, "de").as_deref(), Some("de-DE"));
        // Several locales for one language: the model's own order decides.
        assert_eq!(match_advertised_language(&langs, "en").as_deref(), Some("en-US"));
        assert_eq!(match_advertised_language(&langs, "pt").as_deref(), Some("pt-BR"));
    }

    #[test]
    fn exact_advertised_code_passes_through() {
        let langs = nemotron_languages();
        assert_eq!(match_advertised_language(&langs, "fr-CA").as_deref(), Some("fr-CA"));
    }

    #[test]
    fn picker_sentinels_are_not_language_codes() {
        let langs = nemotron_languages();
        // "auto-translate" is the shipped default, so this is the fresh-install path.
        for sentinel in ["auto", "auto-translate", "", "  "] {
            assert_eq!(
                match_advertised_language(&langs, sentinel),
                None,
                "'{sentinel}' must not reach RunOptions::language"
            );
        }
    }

    #[test]
    fn unsupported_language_falls_back_to_detection() {
        // Japanese against a model that does not list it: auto-detect rather
        // than a hard failure that leaves the meeting with no transcript.
        assert_eq!(match_advertised_language(&nemotron_languages(), "ja"), None);
    }

    #[test]
    fn model_that_advertises_nothing_is_language_agnostic() {
        assert_eq!(match_advertised_language(&[], "de").as_deref(), Some("de"));
    }

    #[test]
    fn catalog_names_are_unique() {
        let mut seen = HashSet::new();
        for e in TRANSCRIBE_MODEL_CATALOG {
            assert!(seen.insert(e.name), "duplicate catalog entry {}", e.name);
        }
    }
}

#[cfg(test)]
mod token_probability_measurement {
    //! What a family actually puts in `Token::p`, measured rather than assumed. (#162)
    //!
    //! The ABI says `p` is *"the per-token probability when the architecture produces one, or NaN
    //! when it does not"*, and names *"per-frame argmax probability for CTC"* — so a CTC family does
    //! produce one. The application shows a red `0%` badge on nearly every line of a `gigaam-v3-ctc`
    //! recording, and this is what settles whether that number is the model's answer or an artefact.
    //!
    //! Ignored: it needs a 259 MB model on disk. Run it by name, as the gate does for the other
    //! hardware tests, with `BC_MEASURE_MODEL` pointing at a `.gguf`.
    use super::*;

    #[test]
    #[ignore = "needs a model on disk; run by name with BC_MEASURE_MODEL=<path to a .gguf>"]
    fn what_a_family_puts_in_token_p() {
        let path = std::env::var("BC_MEASURE_MODEL")
            .expect("set BC_MEASURE_MODEL to a .gguf to measure");
        let wav = std::env::var("BC_MEASURE_WAV").unwrap_or_else(|_| {
            glob_first("~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav")
        });
        let mut samples = read_wav_mono_16k(&wav);
        // A live recording decodes VAD segments, not whole files, and a family may fill `p` for some
        // and not others. `BC_MEASURE_SECONDS` takes the first N seconds so a segment-sized decode can
        // be measured next to the whole-file one.
        if let Ok(secs) = std::env::var("BC_MEASURE_SECONDS") {
            let n = (secs.parse::<f32>().unwrap_or(0.0) * 16_000.0) as usize;
            if n > 0 && n < samples.len() { samples.truncate(n); }
        }
        eprintln!("model: {path}\nwav:   {wav}  ({} samples)", samples.len());

        let model = transcribe_cpp::Model::load(&path).expect("the model opens");
        let mut session = model.session().expect("a session opens");
        let transcript = session
            .run(&samples, &RunOptions::default())
            .expect("the decode runs");

        eprintln!("text:   {}", transcript.text.trim());
        eprintln!("tokens: {}", transcript.tokens.len());
        let ps: Vec<f32> = transcript.tokens.iter().map(|t| t.p).collect();
        let nan = ps.iter().filter(|p| p.is_nan()).count();
        let zero = ps.iter().filter(|p| **p == 0.0).count();
        let finite: Vec<f32> = ps.iter().copied().filter(|p| p.is_finite()).collect();
        let mean = if finite.is_empty() { f32::NAN } else { finite.iter().sum::<f32>() / finite.len() as f32 };
        eprintln!("p: {} NaN, {} exactly 0.0, {} finite; mean of finite = {mean}", nan, zero, finite.len());
        eprintln!("first 20 p: {:?}", &ps[..ps.len().min(20)]);
        eprintln!("mean_token_confidence = {}", mean_token_confidence(&transcript));
        eprintln!("scored_confidence     = {:?}", scored_confidence(&transcript));
    }

    fn glob_first(pattern: &str) -> String {
        let expanded = pattern.replace('~', &std::env::var("HOME").unwrap());
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("ls {expanded} 2>/dev/null | head -1"))
            .output()
            .expect("ls runs");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Minimal 16-bit PCM WAV reader: the fixture is 16 kHz mono, and pulling a crate in for a
    /// measurement would be a dependency this repository does not otherwise need.
    fn read_wav_mono_16k(path: &str) -> Vec<f32> {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        let mut i = 12; // past "RIFF....WAVE"
        while i + 8 <= bytes.len() {
            let id = &bytes[i..i + 4];
            let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
            if id == b"data" {
                return bytes[i + 8..(i + 8 + size).min(bytes.len())]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
                    .collect();
            }
            i += 8 + size + (size & 1);
        }
        panic!("no data chunk in {path}");
    }
}

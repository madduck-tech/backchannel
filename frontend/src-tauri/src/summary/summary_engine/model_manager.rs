// Model manager for built-in AI models - handles downloads and lifecycle
// Follows the same pattern as whisper_engine/whisper_engine.rs for consistency

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::RwLock;
use tokio::time::timeout;

use super::models::{get_available_models, get_model_by_name, PinnedFile, SUMMARY_MODEL_BASE_URL};

/// A download in flight is written here, beside its final file, and renamed over it only once it is
/// exactly its pin's length and sha256 (#191, the pattern #195 gave the transcription engine). The name
/// carries the pin's sha256, so a temporary file of another pin is never resumed, and startup removes it.
pub const PARTIAL_PREFIX: &str = ".partial-";

/// The temporary file of `file` at the pin whose sha256 is `sha256`.
pub fn partial_name(sha256: &str, file: &str) -> String {
    format!("{PARTIAL_PREFIX}{sha256}-{file}")
}

/// `(sha256, file)` when `name` is a temporary file's name, `None` otherwise.
pub fn parse_partial_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix(PARTIAL_PREFIX)?;
    let (sha, file) = rest.split_at_checked(64)?;
    let file = file.strip_prefix('-')?;
    (sha.chars().all(|c| c.is_ascii_hexdigit()) && !file.is_empty()).then_some((sha, file))
}

/// The sha256 of the file at `path`, read from byte `from`. Every caller passes 0: the hash covers the
/// whole file, a resumed head included.
async fn sha256_of(path: &std::path::Path, from: u64) -> Result<String> {
    use sha2::Digest;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = fs::File::open(path).await?;
    f.seek(std::io::SeekFrom::Start(from)).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Whether the file at `path` is exactly `pin`: its length first, then its sha256, each with an error of
/// its own (#191).
async fn verify(path: &std::path::Path, file: &str, pin: &PinnedFile) -> Result<()> {
    let len = fs::metadata(path).await?.len();
    if len != pin.size_bytes {
        return Err(anyhow!("{} is {} bytes, not the {} its pin expects", file, len, pin.size_bytes));
    }
    let sha256 = sha256_of(path, 0).await?;
    if sha256 != pin.sha256 {
        return Err(anyhow!("{} hashes to {}, not the pinned {}", file, sha256, pin.sha256));
    }
    log::info!("Verified {}: {} bytes, sha256 {}", file, len, sha256);
    Ok(())
}

// ============================================================================
// Model Status Types
// ============================================================================

/// Detailed download progress info (MB-based with speed)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    /// Bytes downloaded so far
    pub downloaded_bytes: u64,
    /// Total file size in bytes
    pub total_bytes: u64,
    /// Downloaded in MB (for display)
    pub downloaded_mb: f64,
    /// Total size in MB (for display)
    pub total_mb: f64,
    /// Download speed in MB/s
    pub speed_mbps: f64,
    /// Percentage complete (0-100)
    pub percent: u8,
}

/// One file to fetch for a model. Weights and projector differ only in these values, so the download
/// loop is written once against this.
struct DownloadTarget {
    url: String,
    file: String,
    size_mb: u64,
    pin: PinnedFile,
}

impl DownloadProgress {
    pub fn new(downloaded: u64, total: u64, speed_mbps: f64) -> Self {
        let percent = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0) as u8
        } else {
            0
        };
        Self {
            downloaded_bytes: downloaded,
            total_bytes: total,
            downloaded_mb: downloaded as f64 / (1024.0 * 1024.0),
            total_mb: total as f64 / (1024.0 * 1024.0),
            speed_mbps,
            percent,
        }
    }
}

/// Model status in the system
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelStatus {
    /// Model is not yet downloaded
    NotDownloaded,

    /// Model is currently being downloaded (progress 0-100)
    Downloading { progress: u8 },

    /// Model is downloaded and ready to use
    Available,

    /// Model file is corrupted and needs redownload
    Corrupted { file_size: u64, expected_min_size: u64 },

    /// Error occurred with the model
    Error(String),
}

/// Model information for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    /// Model name (e.g., "gemma4:e4b")
    pub name: String,

    /// Display name for UI
    pub display_name: String,

    /// Current status
    pub status: ModelStatus,

    /// File path (if available)
    pub path: PathBuf,

    /// Size in MB
    pub size_mb: u64,

    /// Context window size in tokens
    pub context_size: u32,

    /// Description
    pub description: String,

    /// GGUF filename on disk
    pub gguf_file: String,
}

// ============================================================================
// Model Manager
// ============================================================================

pub struct ModelManager {
    /// Directory where models are stored
    models_dir: PathBuf,

    /// Currently available models with their status
    available_models: Arc<RwLock<HashMap<String, ModelInfo>>>,

    /// Active downloads (model names)
    active_downloads: Arc<RwLock<HashSet<String>>>,

    /// Cancellation flag for current download
    cancel_download_flag: Arc<RwLock<Option<String>>>,

    /// Where the files are fetched from: [`SUMMARY_MODEL_BASE_URL`], or a test's local server (#191).
    base_url: String,
    /// Whether the client reads the system proxy: production does; a test's local server is reached directly.
    system_proxy: bool,
    /// How long a download waits for the next part of a file before it gives up. 30 s; a test sets less.
    stall_timeout: Duration,
}

impl ModelManager {
    /// Create a new model manager with default models directory
    pub fn new() -> Result<Self> {
        Self::new_with_models_dir(None)
    }

    /// Create a new model manager with custom models directory
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        let models_dir = if let Some(dir) = models_dir {
            dir
        } else {
            // Fallback: Use current directory in development
            let current_dir = std::env::current_dir()
                .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;

            if cfg!(debug_assertions) {
                // Development mode
                current_dir.join("models").join("summary")
            } else {
                // Production mode fallback (caller should provide path)
                log::warn!("ModelManager: No models directory provided, using fallback path");
                dirs::data_dir()
                    .or_else(dirs::home_dir)
                    .ok_or_else(|| anyhow!("Could not find system data directory"))?
                    .join("Backchannel")
                    .join("models")
                    .join("summary")
            }
        };

        log::info!(
            "Built-in AI ModelManager using directory: {}",
            models_dir.display()
        );

        Ok(Self {
            models_dir,
            available_models: Arc::new(RwLock::new(HashMap::new())),
            active_downloads: Arc::new(RwLock::new(HashSet::new())),
            cancel_download_flag: Arc::new(RwLock::new(None)),
            base_url: SUMMARY_MODEL_BASE_URL.to_string(),
            system_proxy: true,
            stall_timeout: Duration::from_secs(30),
        })
    }

    /// The manager fetching from a local server, with a client that reads no proxy (#191).
    #[cfg(test)]
    pub(crate) fn with_base_url(mut self, base_url: &str) -> Self {
        self.base_url = base_url.to_string();
        self.system_proxy = false;
        self
    }

    /// The manager with a shorter stall timeout, for a test whose server stops sending.
    #[cfg(test)]
    pub(crate) fn with_stall_timeout(mut self, stall_timeout: Duration) -> Self {
        self.stall_timeout = stall_timeout;
        self
    }

    /// Remove every temporary file in the models directory that names no current pin of any of the 9
    /// files (#191). It touches temporary files only: a name that does not parse as one is left alone.
    async fn remove_stale_partials(&self) {
        let current: HashSet<(String, String)> = get_available_models()
            .into_iter()
            .flat_map(|m| {
                let mut pins = vec![(m.weights.sha256.clone(), m.gguf_file.clone())];
                if let Some(p) = m.mmproj {
                    pins.push((p.pin.sha256.clone(), p.file.clone()));
                }
                pins
            })
            .collect();
        let Ok(mut dir) = fs::read_dir(&self.models_dir).await else { return };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some((sha, file)) = parse_partial_name(&name) {
                if !current.contains(&(sha.to_string(), file.to_string())) {
                    match fs::remove_file(entry.path()).await {
                        Ok(()) => log::info!("Removed {}, a temporary file of no current pin", name),
                        Err(e) => log::warn!("Could not remove {}: {}", name, e),
                    }
                }
            }
        }
    }

    /// The temporary file of `file` at `pin`, in the models directory.
    fn partial_path(&self, file: &str, pin: &PinnedFile) -> PathBuf {
        self.models_dir.join(partial_name(&pin.sha256, file))
    }

    /// Initialize and scan for existing models
    pub async fn init(&self) -> Result<()> {
        // Create models directory if it doesn't exist
        if !self.models_dir.exists() {
            fs::create_dir_all(&self.models_dir).await?;
            log::info!("Created models directory: {}", self.models_dir.display());
        }

        // Temporary files of no current pin first, so the scan never reads one (#191).
        self.remove_stale_partials().await;

        // Scan for existing models
        self.scan_models().await?;

        Ok(())
    }

    /// Scan models directory and update status
    pub async fn scan_models(&self) -> Result<()> {
        let start = std::time::Instant::now();

        log::info!(
            "Starting model scan in directory: {}",
            self.models_dir.display()
        );

        let model_defs = get_available_models();
        let mut models_map = HashMap::new();

        for model_def in model_defs {
            let model_path = self.models_dir.join(&model_def.gguf_file);
            log::debug!(
                "Checking model '{}' at path: {}",
                model_def.name,
                model_path.display()
            );

            let is_actively_downloading = {
                let active = self.active_downloads.read().await;
                active.contains(&model_def.name)
            };

            // If actively downloading, preserve existing status from memory
            if is_actively_downloading {
                let existing_info = {
                    let models = self.available_models.read().await;
                    models.get(&model_def.name).cloned()
                };

                if let Some(info) = existing_info {
                    // Preserve existing status (should be Downloading)
                    models_map.insert(model_def.name.clone(), info);
                    log::debug!(
                        "Model '{}': Preserving Downloading status during scan",
                        model_def.name
                    );
                    continue;
                }
            }

            let status = self.status_of(&model_def).await;

            let model_info = ModelInfo {
                name: model_def.name.clone(),
                display_name: model_def.display_name.clone(),
                status,
                path: model_path,
                // What the user has to download, so the UI quotes weights + projector.
                size_mb: model_def.total_size_mb(),
                context_size: model_def.context_size,
                description: model_def.description.clone(),
                gguf_file: model_def.gguf_file.clone(),
            };

            models_map.insert(model_def.name.clone(), model_info);
        }

        let model_count = models_map.len();

        let mut models = self.available_models.write().await;
        *models = models_map;

        let elapsed = start.elapsed();
        log::info!(
            "Model scan complete: {} models checked in {:?}",
            model_count,
            elapsed
        );
        Ok(())
    }

    /// What one file of a model reads as on disk (#191): its final file inside the 10% window of
    /// `size_mb` reads `Ok(())`; one outside it, or a temporary file with no final file, reads
    /// `Corrupted` with that file's size, so its row keeps Retry and Delete; nothing at all is `None`.
    async fn file_status(&self, model: &str, file: &str, size_mb: u64, pin: &PinnedFile) -> Option<std::result::Result<(), ModelStatus>> {
        const MIB: u64 = 1024 * 1024;
        let expected_min = (size_mb as f64 * 0.9) as u64;
        let expected_max = (size_mb as f64 * 1.1) as u64;
        let final_path = self.models_dir.join(file);
        if let Ok(m) = fs::metadata(&final_path).await {
            let mb = m.len() / MIB;
            log::info!("Model '{}': {} is {} MB (expected {}-{} MB)", model, file, mb, expected_min, expected_max);
            return Some(if mb >= expected_min && mb <= expected_max {
                Ok(())
            } else {
                log::warn!("Model '{}': CORRUPTED ({} is {} MB, expected {} MB)", model, file, mb, size_mb);
                Err(ModelStatus::Corrupted { file_size: mb, expected_min_size: expected_min })
            });
        }
        let partial = fs::metadata(self.partial_path(file, pin)).await.ok()?;
        log::info!("Model '{}': {} is a temporary file of {} MB, not yet whole", model, file, partial.len() / MIB);
        Some(Err(ModelStatus::Corrupted { file_size: partial.len() / MIB, expected_min_size: expected_min }))
    }

    /// What a model reads as: both of its files whole is Available, either one partial or out of its
    /// window is Corrupted, nothing of it NotDownloaded.
    async fn status_of(&self, model_def: &super::models::ModelDef) -> ModelStatus {
        match self.file_status(&model_def.name, &model_def.gguf_file, model_def.size_mb, &model_def.weights).await {
            None => {
                log::debug!("Model '{}': NOT FOUND", model_def.name);
                ModelStatus::NotDownloaded
            }
            Some(Err(corrupted)) => corrupted,
            // An audio model is only usable with its projector, and only inside its window: weights alone
            // would scan as Available and then fail at the first transcription instead of offering a
            // download.
            Some(Ok(())) => match &model_def.mmproj {
                None => ModelStatus::Available,
                Some(p) => match self.file_status(&model_def.name, &p.file, p.size_mb, &p.pin).await {
                    None => {
                        log::warn!("Model '{}': projector {} missing, needs download", model_def.name, p.file);
                        ModelStatus::NotDownloaded
                    }
                    Some(Err(corrupted)) => corrupted,
                    Some(Ok(())) => {
                        log::info!("Model '{}': AVAILABLE", model_def.name);
                        ModelStatus::Available
                    }
                },
            },
        }
    }

    /// Get list of all models with their status
    pub async fn list_models(&self) -> Vec<ModelInfo> {
        self.available_models
            .read()
            .await
            .values()
            .cloned()
            .collect()
    }

    /// Get info for a specific model
    pub async fn get_model_info(&self, model_name: &str) -> Option<ModelInfo> {
        self.available_models
            .read()
            .await
            .get(model_name)
            .cloned()
    }

    /// Check if a model is ready to use
    /// If refresh=true, scans filesystem before checking (slower but accurate)
    pub async fn is_model_ready(&self, model_name: &str, refresh: bool) -> bool {
        if refresh {
            if let Err(e) = self.scan_models().await {
                log::error!("Failed to scan models: {}", e);
                return false;
            }
        }

        if let Some(info) = self.get_model_info(model_name).await {
            info.status == ModelStatus::Available
        } else {
            false
        }
    }

    /// Download a model with simple percentage callback (backward compatible)
    pub async fn download_model(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(u8) + Send + Sync>>,
    ) -> Result<()> {
        // Wrap the simple callback to use detailed progress internally
        let detailed_callback: Option<Box<dyn Fn(DownloadProgress) + Send + Sync>> =
            progress_callback.map(|cb| {
                Box::new(move |p: DownloadProgress| cb(p.percent)) as Box<dyn Fn(DownloadProgress) + Send + Sync>
            });
        self.download_model_detailed(model_name, detailed_callback).await
    }

    /// Download a model with detailed progress (MB, speed, etc.)
    ///
    /// An audio-capable model is two files — weights plus projector — fetched in
    /// sequence and reported as one progress bar, because from the user's side it is
    /// one "download this model" action.
    pub async fn download_model_detailed(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send + Sync>>,
    ) -> Result<()> {
        log::info!("Starting download for model: {}", model_name);

        // Check if already downloading
        {
            let active = self.active_downloads.read().await;
            if active.contains(model_name) {
                log::warn!("Download already in progress for model: {}", model_name);
                return Err(anyhow!("Download already in progress"));
            }
        }

        // Get model definition
        let model_def = get_model_by_name(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;

        // Add to active downloads
        {
            let mut active = self.active_downloads.write().await;
            active.insert(model_name.to_string());
        }

        // Clear cancellation flag
        {
            let mut cancel_flag = self.cancel_download_flag.write().await;
            *cancel_flag = None;
        }

        // Update status to downloading
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 0 };
            }
        }

        let mut targets = vec![DownloadTarget {
            url: model_def.weights.url(&self.base_url, &model_def.gguf_file),
            file: model_def.gguf_file.clone(),
            size_mb: model_def.size_mb,
            pin: model_def.weights.clone(),
        }];
        if let Some(projector) = &model_def.mmproj {
            targets.push(DownloadTarget {
                url: projector.pin.url(&self.base_url, &projector.file),
                file: projector.file.clone(),
                size_mb: projector.size_mb,
                pin: projector.pin.clone(),
            });
        }

        const MIB: u64 = 1024 * 1024;
        let grand_total = targets.iter().map(|t| t.size_mb).sum::<u64>() * MIB;
        let weights_path = self.models_dir.join(&model_def.gguf_file);

        let mut offset: u64 = 0;
        for target in &targets {
            self.download_one(model_name, target, offset, grand_total, &progress_callback)
                .await?;
            offset += target.size_mb * MIB;
        }

        if let Some(ref callback) = progress_callback {
            callback(DownloadProgress::new(grand_total, grand_total, 0.0));
        }

        // Update status to available
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Available;
                model_info.path = weights_path;
            }
        }

        // Remove from active downloads
        {
            let mut active = self.active_downloads.write().await;
            active.remove(model_name);
        }

        Ok(())
    }

    /// Fetch one file of a model, reporting progress against the model's grand total.
    ///
    /// `progress_offset` is how many bytes of earlier files are already done, so a
    /// two-file model still shows a single monotonic bar.
    ///
    /// The file is written to its temporary name and renamed over the final path only once it is exactly
    /// its pin (#191). A file at the final path that the window reads whole is left as it is, so a file
    /// the sidecar may have mapped is never replaced; one under the window is an earlier build's partial,
    /// and is moved to its temporary name and resumed. A resume that fails its check is discarded and
    /// fetched once more from zero.
    async fn download_one(
        &self,
        model_name: &str,
        target: &DownloadTarget,
        progress_offset: u64,
        grand_total: u64,
        progress_callback: &Option<Box<dyn Fn(DownloadProgress) + Send + Sync>>,
    ) -> Result<()> {
        let file_path = self.models_dir.join(&target.file);
        let partial = self.partial_path(&target.file, &target.pin);

        // Progress is always reported against the whole model, never this one file.
        let report = |downloaded: u64, speed: f64| {
            DownloadProgress::new(
                (progress_offset + downloaded).min(grand_total),
                grand_total,
                speed,
            )
        };

        // What the final path holds already.
        if let Ok(metadata) = fs::metadata(&file_path).await {
            let file_size_mb = metadata.len() / (1024 * 1024);
            let expected_min = (target.size_mb as f64 * 0.9) as u64;
            let expected_max = (target.size_mb as f64 * 1.1) as u64;

            if file_size_mb >= expected_min && file_size_mb <= expected_max {
                log::info!(
                    "'{}' already exists and is valid ({} MB), skipping download",
                    target.file,
                    file_size_mb
                );
                if let Some(ref callback) = progress_callback {
                    callback(report(metadata.len(), 0.0));
                }
                return Ok(());
            } else if file_size_mb > expected_max {
                // File is LARGER than expected - possibly corrupted or wrong file
                // Delete and re-download in this case
                log::warn!(
                    "'{}' exists but is too large ({} MB, expected max {} MB), deleting and re-downloading",
                    target.file,
                    file_size_mb,
                    expected_max
                );
                if let Err(e) = fs::remove_file(&file_path).await {
                    log::warn!("Failed to delete oversized model file: {}", e);
                }
            } else if !partial.exists() {
                // An earlier build left a partial at the final path: it becomes this pin's temporary
                // file and is resumed. Its bytes may be another pin's; the check after the resume says so.
                log::info!(
                    "'{}' exists but is incomplete ({} MB, expected min {} MB), moving it to its temporary name to resume",
                    target.file,
                    file_size_mb,
                    expected_min
                );
                fs::rename(&file_path, &partial).await?;
            } else {
                log::info!("'{}' is incomplete and a temporary file already exists; removing the older partial", target.file);
                fs::remove_file(&file_path).await?;
            }
        }

        // Create models directory if needed
        if !self.models_dir.exists() {
            fs::create_dir_all(&self.models_dir).await?;
        }

        // A temporary file already whole, or longer, is checked before any request: a Range at or past
        // its length would be answered 416.
        if let Ok(m) = fs::metadata(&partial).await {
            if m.len() >= target.pin.size_bytes {
                match verify(&partial, &target.file, &target.pin).await {
                    Ok(()) => {
                        fs::rename(&partial, &file_path).await?;
                        if let Some(ref callback) = progress_callback {
                            callback(report(target.pin.size_bytes, 0.0));
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        log::warn!("Discarding the temporary {}: {}; fetching it from zero", target.file, e);
                        fs::remove_file(&partial).await?;
                    }
                }
            }
        }

        // One fetch, and once more from zero when a resumed one fails its check.
        let mut retried = false;
        loop {
            let resumed = self.fetch(model_name, target, &partial, &report, progress_callback).await?;
            match verify(&partial, &target.file, &target.pin).await {
                Ok(()) => break,
                Err(e) => {
                    let _ = fs::remove_file(&partial).await;
                    if resumed && !retried {
                        log::warn!("Discarding the resumed {}: {}; fetching it from zero", target.file, e);
                        retried = true;
                        continue;
                    }
                    self.active_downloads.write().await.remove(model_name);
                    return Err(e);
                }
            }
        }

        if let Err(e) = self.validate_gguf_file(&partial).await {
            log::error!("Downloaded file failed validation: {}", e);
            let _ = fs::remove_file(&partial).await;
            {
                let mut models = self.available_models.write().await;
                if let Some(model_info) = models.get_mut(model_name) {
                    model_info.status = ModelStatus::Error(format!("Validation failed: {}", e));
                }
            }
            self.active_downloads.write().await.remove(model_name);
            return Err(anyhow!("File validation failed: {}", e));
        }

        fs::rename(&partial, &file_path).await?;
        log::info!("Download completed: {}", target.file);

        if let Some(ref callback) = progress_callback {
            callback(report(target.pin.size_bytes, 0.0));
        }

        // Small delay to ensure UI receives the progress event
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        Ok(())
    }

    /// One request for `target` into its temporary file `partial`: ranged from the file's length when
    /// it has one, written from zero otherwise. Returns whether the bytes were appended to a resumed head.
    /// A cancel, a stall or a stream error keeps the temporary file and never touches the final path.
    async fn fetch(
        &self,
        model_name: &str,
        target: &DownloadTarget,
        partial: &std::path::Path,
        report: &(dyn Fn(u64, f64) -> DownloadProgress + Sync),
        progress_callback: &Option<Box<dyn Fn(DownloadProgress) + Send + Sync>>,
    ) -> Result<bool> {
        let file_path = partial;
        let overall_percent = |downloaded: u64| -> u8 { report(downloaded, 0.0).percent };

        log::info!("Downloading from: {}", target.url);
        log::info!("Saving to: {}", file_path.display());

        // Check for existing partial download to resume
        let existing_size: u64 = fs::metadata(file_path).await.map(|m| m.len()).unwrap_or(0);

        // Download the file with optimized client settings
        let builder = Client::builder()
            .tcp_nodelay(true) // Disable Nagle's algorithm for faster streaming
            .pool_max_idle_per_host(1) // Keep connection alive
            .timeout(Duration::from_secs(3600)) // 1 hour timeout for large files
            .connect_timeout(Duration::from_secs(30));
        let client = if self.system_proxy { builder } else { builder.no_proxy() }
            .build()
            .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

        // Build request with Range header if resuming
        let mut request = client.get(&target.url);
        if existing_size > 0 {
            log::info!(
                "Resuming download from byte {} ({:.1} MB)",
                existing_size,
                existing_size as f64 / (1024.0 * 1024.0)
            );
            request = request.header("Range", format!("bytes={}-", existing_size));
        }

        let response = request
            .send()
            .await
            .map_err(|e| anyhow!("Failed to start download: {}", e))?;

        // Check response status - 200 OK (full download) or 206 Partial Content (resume)
        let (total_size, resuming) = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            // Server supports resume - total size = existing + remaining
            let remaining = response.content_length().unwrap_or(0);
            log::info!("Server supports resume, {} MB remaining", remaining / (1024 * 1024));
            (existing_size + remaining, true)
        } else if response.status().is_success() {
            // Server doesn't support resume or fresh download
            if existing_size > 0 {
                log::warn!("Server doesn't support resume, starting fresh download");
            }
            (response.content_length().unwrap_or(0), false)
        } else {
            let mut active = self.active_downloads.write().await;
            active.remove(model_name);
            return Err(anyhow!("Download failed with status: {}", response.status()));
        };

        log::info!("Total size: {} MB", total_size / (1024 * 1024));

        // Open file for append if resuming, or create new
        let file = if resuming {
            OpenOptions::new()
                .write(true)
                .append(true)
                .open(file_path)
                .await
                .map_err(|e| anyhow!("Failed to open file for append: {}", e))?
        } else {
            fs::File::create(file_path)
                .await
                .map_err(|e| anyhow!("Failed to create file: {}", e))?
        };

        // Use 8MB buffer to reduce disk I/O syscalls (major performance improvement)
        let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);

        let mut downloaded: u64 = if resuming { existing_size } else { 0 };

        // Emit initial progress (showing resumed position if applicable)
        if let Some(ref callback) = progress_callback {
            callback(report(downloaded, 0.0));
        }
        log::info!(
            "Starting at {:.1} MB / {:.1} MB",
            downloaded as f64 / (1024.0 * 1024.0),
            total_size as f64 / (1024.0 * 1024.0)
        );

        let mut last_progress_percent = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u8
        } else {
            0
        };
        let mut last_report_time = std::time::Instant::now();
        let mut bytes_since_last_report: u64 = 0;
        let download_start_time = std::time::Instant::now();
        let start_downloaded = downloaded;

        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();

        loop {
            // Check for cancellation
            {
                let cancel_flag = self.cancel_download_flag.read().await;
                if cancel_flag.as_ref() == Some(&model_name.to_string()) {
                    log::info!("Download cancelled for model: {}", model_name);

                    // Flush and keep partial file for resume on next attempt
                    let _ = writer.flush().await;
                    drop(writer);

                    // Remove from active downloads
                    let mut active = self.active_downloads.write().await;
                    active.remove(model_name);

                    // Update status
                    {
                        let mut models = self.available_models.write().await;
                        if let Some(model_info) = models.get_mut(model_name) {
                            model_info.status = ModelStatus::NotDownloaded;
                        }
                    }

                    // Use special marker prefix to distinguish cancellation from other errors
                    return Err(anyhow!("CANCELLED: Download cancelled by user"));
                }
            }

            // Add per-chunk timeout (30 seconds) to detect stalled connections
            let next_result = timeout(self.stall_timeout, stream.next()).await;

            let chunk = match next_result {
                // Timeout - no data received for 30 seconds
                Err(_) => {
                    log::warn!("Download timeout for {}: no data received for {} seconds", model_name, self.stall_timeout.as_secs());
                    let _ = writer.flush().await;

                    // Cleanup: Remove from active downloads
                    let mut active = self.active_downloads.write().await;
                    active.remove(model_name);

                    // Set model status to Error (NOT NotDownloaded) so UI can show retry button
                    {
                        let mut models = self.available_models.write().await;
                        if let Some(model_info) = models.get_mut(model_name) {
                            model_info.status = ModelStatus::Error("Download timeout - No data received for 30 seconds".to_string());
                        }
                    }

                    return Err(anyhow!("Download timeout - No data received for 30 seconds"));
                },
                // Stream ended
                Ok(None) => break,
                // Got chunk result
                Ok(Some(chunk_result)) => {
                    match chunk_result {
                        Ok(c) => c,
                        // Detect error type for better user feedback
                        Err(e) => {
                            log::error!("Download error for {}: {:?}", model_name, e);
                            let _ = writer.flush().await;

                            // Cleanup: Remove from active downloads
                            let mut active = self.active_downloads.write().await;
                            active.remove(model_name);

                            // Categorize error for user-friendly message
                            let error_msg = if e.is_timeout() {
                                "Connection timeout - Check your internet"
                            } else if e.is_connect() {
                                "Connection failed - Check your internet"
                            } else if e.is_body() {
                                "Stream interrupted - Network unstable"
                            } else {
                                "Download error"
                            };

                            // Set model status to Error (NOT NotDownloaded) so UI can show retry button
                            {
                                let mut models = self.available_models.write().await;
                                if let Some(model_info) = models.get_mut(model_name) {
                                    model_info.status = ModelStatus::Error(error_msg.to_string());
                                }
                            }

                            return Err(anyhow!("{}: {}", error_msg, e));
                        }
                    }
                }
            };
            let chunk_len = chunk.len() as u64;
            writer
                .write_all(&chunk)
                .await
                .map_err(|e| anyhow!("Error writing to file: {}", e))?;

            downloaded += chunk_len;
            bytes_since_last_report += chunk_len;

            // Calculate progress
            let progress_percent = if total_size > 0 {
                let exact_percent = (downloaded as f64 / total_size as f64) * 100.0;
                exact_percent.min(100.0) as u8
            } else {
                0
            };

            let elapsed_since_report = last_report_time.elapsed();
            let is_download_complete = downloaded >= total_size;
            let should_report = progress_percent > last_progress_percent
                || is_download_complete  // Force report on completion
                || elapsed_since_report.as_millis() >= 500;

            if should_report {
                // Calculate speed based on bytes downloaded since last report
                let speed_mbps = if elapsed_since_report.as_secs_f64() > 0.0 {
                    (bytes_since_last_report as f64 / (1024.0 * 1024.0)) / elapsed_since_report.as_secs_f64()
                } else {
                    // Fallback to overall average speed
                    let total_elapsed = download_start_time.elapsed().as_secs_f64();
                    if total_elapsed > 0.0 {
                        ((downloaded - start_downloaded) as f64 / (1024.0 * 1024.0)) / total_elapsed
                    } else {
                        0.0
                    }
                };

                log::info!(
                    "Download: {:.1} MB / {:.1} MB ({:.1} MB/s)",
                    downloaded as f64 / (1024.0 * 1024.0),
                    total_size as f64 / (1024.0 * 1024.0),
                    speed_mbps
                );

                // Update status
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model_info) = models.get_mut(model_name) {
                        model_info.status = ModelStatus::Downloading {
                            progress: overall_percent(downloaded)
                        };
                    }
                }

                // Call progress callback with detailed info
                if let Some(ref callback) = progress_callback {
                    callback(report(downloaded, speed_mbps));
                }

                last_progress_percent = progress_percent;
                last_report_time = std::time::Instant::now();
                bytes_since_last_report = 0;
            }
        }

        writer.flush().await?;
        drop(writer);

        if let Some(ref callback) = progress_callback {
            callback(report(total_size, 0.0));
        }
        Ok(resuming)
    }

    /// Validate that a file is a valid GGUF model
    async fn validate_gguf_file(&self, path: &PathBuf) -> Result<()> {
        let mut file = fs::File::open(path).await?;

        // Read first 4 bytes to check for GGUF magic number
        use tokio::io::AsyncReadExt;
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).await?;

        // GGUF magic number is "GGUF" (0x47475546)
        if &magic == b"GGUF" {
            Ok(())
        } else if &magic == b"ggjt" || &magic == b"ggla" || &magic == b"ggml" {
            // Older formats (GGML, GGJT)
            Ok(())
        } else {
            Err(anyhow!(
                "Invalid model file: magic number {:?} doesn't match GGUF/GGML",
                magic
            ))
        }
    }

    /// Cancel an ongoing download
    pub async fn cancel_download(&self, model_name: &str) -> Result<()> {
        log::info!("Cancelling download for model: {}", model_name);

        // Set cancellation flag - download loop will detect this and handle cleanup
        {
            let mut cancel_flag = self.cancel_download_flag.write().await;
            *cancel_flag = Some(model_name.to_string());
        }

        // Note: active_downloads cleanup is handled by the download loop when it detects
        // the cancellation flag. This avoids double-removal race condition.

        // Update status immediately for UI responsiveness
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::NotDownloaded;
            }
        }

        // Brief delay to let download loop detect cancellation
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        Ok(())
    }

    /// Delete a corrupted or available model file
    pub async fn delete_model(&self, model_name: &str) -> Result<()> {
        log::info!("Deleting model: {}", model_name);

        let model_def = get_model_by_name(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;

        // Both files, and every temporary file of either, whatever pin it names (#191).
        let mut files = vec![model_def.gguf_file.clone()];
        if let Some(p) = &model_def.mmproj {
            files.push(p.file.clone());
        }
        for file in &files {
            let file_path = self.models_dir.join(file);
            if file_path.exists() {
                fs::remove_file(&file_path).await?;
                log::info!("Deleted model file: {}", file_path.display());
            }
        }
        if let Ok(mut dir) = fs::read_dir(&self.models_dir).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if parse_partial_name(&name).is_some_and(|(_, f)| files.iter().any(|x| x == f)) {
                    fs::remove_file(entry.path()).await?;
                    log::info!("Deleted temporary file: {}", name);
                }
            }
        }

        // Update status
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::NotDownloaded;
            }
        }

        Ok(())
    }

    /// Get models directory path
    pub fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod download_tests;

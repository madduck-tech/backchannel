use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use anyhow::Result;
#[cfg(target_os = "macos")]
use log::error;

#[cfg(target_os = "macos")]
use crate::audio::capture::AudioCaptureBackend;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingPreferences {
    pub save_folder: PathBuf,
    pub auto_save: bool,
    pub file_format: String,
    #[serde(default)]
    pub preferred_mic_device: Option<String>,
    #[serde(default)]
    pub preferred_system_device: Option<String>,
    #[cfg(target_os = "macos")]
    #[serde(default)]
    pub system_audio_backend: Option<String>,
}

impl Default for RecordingPreferences {
    fn default() -> Self {
        Self {
            save_folder: get_default_recordings_folder(),
            auto_save: true,
            file_format: "mp4".to_string(),
            preferred_mic_device: None,
            preferred_system_device: None,
            #[cfg(target_os = "macos")]
            system_audio_backend: Some("coreaudio".to_string()),
        }
    }
}

/// Get the default recordings folder based on platform.
///
/// Never returns a relative path. It used to fall back to `PathBuf::from(".")` when the
/// platform's media directory was unknown, and under the AppImage that is fatal rather than
/// merely untidy: the AppImage runtime chdirs into its own read-only FUSE mount, so
/// `./conversationaly-recordings` resolves inside it, `mkdir` returns EROFS, and the
/// recording then runs with no meeting folder at all -- no audio, no transcript files. The
/// application logged the error and carried on, so the only symptom was an empty folder.
fn recordings_dir_fallback() -> PathBuf {
    // The home directory is writable wherever the media directories are not, and unlike the
    // process CWD it does not depend on how the application was launched.
    dirs::home_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("conversationaly-recordings")
}

pub fn get_default_recordings_folder() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        // Windows: %USERPROFILE%\Music\conversationaly-recordings
        if let Some(music_dir) = dirs::audio_dir() {
            music_dir.join("conversationaly-recordings")
        } else {
            // Fallback to Documents if Music folder is not available
            dirs::document_dir()
                .map(|d| d.join("conversationaly-recordings"))
                .unwrap_or_else(recordings_dir_fallback)
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: ~/Movies/conversationaly-recordings
        if let Some(movies_dir) = dirs::video_dir() {
            movies_dir.join("conversationaly-recordings")
        } else {
            // Fallback to Documents if Movies folder is not available
            dirs::document_dir()
                .map(|d| d.join("conversationaly-recordings"))
                .unwrap_or_else(recordings_dir_fallback)
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux/Others: ~/Documents/conversationaly-recordings
        dirs::document_dir()
            .map(|d| d.join("conversationaly-recordings"))
            .unwrap_or_else(recordings_dir_fallback)
    }
}

/// Ensure the recordings directory exists
pub fn ensure_recordings_directory(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
        info!("Created recordings directory: {:?}", path);
    }
    Ok(())
}

/// Generate a unique filename for a recording
pub fn generate_recording_filename(format: &str) -> String {
    let now = chrono::Utc::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    format!("recording_{}.{}", timestamp, format)
}

/// Load recording preferences from store
pub async fn load_recording_preferences<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<RecordingPreferences> {
    // Try to load from Tauri store
    let store = match app.store("recording_preferences.json") {
        Ok(store) => store,
        Err(e) => {
            warn!("Failed to access store: {}, using defaults", e);
            return Ok(RecordingPreferences::default());
        }
    };

    // Try to get the preferences from store
    let prefs = if let Some(value) = store.get("preferences") {
        match serde_json::from_value::<RecordingPreferences>(value.clone()) {
            // `mut` is used only by the `#[cfg(target_os = "macos")]` block below, so on
            // every other platform rustc calls it needless. Removing it would break the
            // macOS build, which no check in this repository runs on a pull request.
            #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
            Ok(mut p) => {
                info!("Loaded recording preferences from store");
                // Update macOS backend to current value if needed
                #[cfg(target_os = "macos")]
                {
                    let backend = crate::audio::capture::get_current_backend();
                    p.system_audio_backend = Some(backend.to_string());
                }
                p
            }
            Err(e) => {
                warn!("Failed to deserialize preferences: {}, using defaults", e);
                RecordingPreferences::default()
            }
        }
    } else {
        info!("No stored preferences found, using defaults");
        RecordingPreferences::default()
    };

    info!("Loaded recording preferences: save_folder={:?}, auto_save={}, format={}, mic={:?}, system={:?}",
          prefs.save_folder, prefs.auto_save, prefs.file_format,
          prefs.preferred_mic_device, prefs.preferred_system_device);
    Ok(prefs)
}

/// Save recording preferences to store
pub async fn save_recording_preferences<R: Runtime>(
    app: &AppHandle<R>,
    preferences: &RecordingPreferences,
) -> Result<()> {
    info!("Saving recording preferences: save_folder={:?}, auto_save={}, format={}, mic={:?}, system={:?}",
          preferences.save_folder, preferences.auto_save, preferences.file_format,
          preferences.preferred_mic_device, preferences.preferred_system_device);

    // Get or create store
    let store = app
        .store("recording_preferences.json")
        .map_err(|e| anyhow::anyhow!("Failed to access store: {}", e))?;

    // Serialize preferences to JSON value
    let prefs_value = serde_json::to_value(preferences)
        .map_err(|e| anyhow::anyhow!("Failed to serialize preferences: {}", e))?;

    // Save to store
    store.set("preferences", prefs_value);

    // Persist to disk
    store
        .save()
        .map_err(|e| anyhow::anyhow!("Failed to save store to disk: {}", e))?;

    info!("Successfully persisted recording preferences to disk");

    // Save backend preference to global config
    #[cfg(target_os = "macos")]
    if let Some(backend_str) = &preferences.system_audio_backend {
        if let Some(backend) = AudioCaptureBackend::from_string(backend_str) {
            info!("Setting audio capture backend to: {:?}", backend);
            crate::audio::capture::set_current_backend(backend);
        }
    }

    // Ensure the directory exists
    ensure_recordings_directory(&preferences.save_folder)?;

    Ok(())
}

/// Tauri commands for recording preferences
#[tauri::command]
pub async fn get_recording_preferences<R: Runtime>(
    app: AppHandle<R>,
) -> Result<RecordingPreferences, String> {
    load_recording_preferences(&app)
        .await
        .map_err(|e| format!("Failed to load recording preferences: {}", e))
}

#[tauri::command]
pub async fn set_recording_preferences<R: Runtime>(
    app: AppHandle<R>,
    preferences: RecordingPreferences,
) -> Result<(), String> {
    save_recording_preferences(&app, &preferences)
        .await
        .map_err(|e| format!("Failed to save recording preferences: {}", e))
}

#[tauri::command]
pub async fn get_default_recordings_folder_path() -> Result<String, String> {
    let path = get_default_recordings_folder();
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_recordings_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let preferences = load_recording_preferences(&app)
        .await
        .map_err(|e| format!("Failed to load preferences: {}", e))?;

    // Ensure directory exists before trying to open it
    ensure_recordings_directory(&preferences.save_folder)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let folder_path = preferences.save_folder.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    info!("Opened recordings folder: {}", folder_path);
    Ok(())
}


// Backend selection commands


/// Get current audio capture backend
#[tauri::command]
pub async fn get_current_audio_backend() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let backend = crate::audio::capture::get_current_backend();
        Ok(backend.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok("screencapturekit".to_string())
    }
}

/// Set audio capture backend
#[tauri::command]
pub async fn set_audio_backend(backend: String) -> Result<(), String> {
    use crate::audio::capture::{AudioCaptureBackend, Platform};

    // One rule, asked once. This used to be two `cfg` branches: the macOS one parsed the id,
    // and the other compared against the bare string "screencapturekit" — a fourth hand-written
    // copy of the availability rule that nothing checked against the other three.
    let backend_enum = AudioCaptureBackend::from_string(&backend)
        .ok_or_else(|| format!("Invalid backend: {}", backend))?;

    if !backend_enum.is_available_on(Platform::CURRENT) {
        return Err(format!(
            "Backend {} not available on this platform",
            backend
        ));
    }

    // Everything above is platform-independent and tested as such. Only the permission dance
    // below needs a macOS compiler, because only macOS has the permission.
    #[cfg(target_os = "macos")]
    {
        use crate::audio::permissions::{
            check_screen_recording_permission, request_screen_recording_permission,
        };

        if backend_enum == AudioCaptureBackend::CoreAudio {
            info!("🔐 Core Audio backend requires Audio Capture permission (macOS 14.4+)");
            info!("📍 Permission dialog will appear automatically when recording starts");

            if !check_screen_recording_permission() {
                warn!("⚠️  Audio Capture permission may not be granted");

                if let Err(e) = request_screen_recording_permission() {
                    error!("Failed to open System Settings: {}", e);
                }

                return Err(
                    "Core Audio requires Audio Capture permission. \
                    The permission dialog will appear when you start recording. \
                    If already denied, enable it in System Settings → Privacy & Security → Audio Capture, \
                    then restart the app.".to_string()
                );
            }

            info!(
                "✅ Core Audio backend selected - permission check will occur at recording start"
            );
        }

        info!("Setting audio backend to: {:?}", backend_enum);
        crate::audio::capture::set_current_backend(backend_enum);
    }

    Ok(())
}

/// Get backend information (name and description)
#[derive(Serialize)]
pub struct BackendInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub async fn get_audio_backend_info() -> Result<Vec<BackendInfo>, String> {
    use crate::audio::capture::AudioCaptureBackend;

    // Derived from the availability rule, not written out beside it. Both branches this
    // replaced listed backends by hand — the macOS one named two, the other named one — so
    // the list the frontend renders could disagree with the list `set_audio_backend` accepts
    // and nothing would have said so.
    Ok(AudioCaptureBackend::available_backends()
        .into_iter()
        .map(|backend| BackendInfo {
            id: backend.id().to_string(),
            name: backend.name().to_string(),
            description: backend.description().to_string(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every id this command hands the frontend must parse back into the backend it names.
    ///
    /// It is the pair to `the_stored_id_round_trips_and_is_not_the_display_label` in
    /// `capture/backend_config.rs`, and it exists because the call sites here were the ones
    /// actually at risk: while an inherent `to_string` shadowed `Display`, `id: X.to_string()`
    /// was correct only by that shadow, and **no test covered these lines at all**. The lint
    /// found them; nothing else would have.
    #[tokio::test]
    async fn every_backend_id_parses_back_to_its_backend() {
        use crate::audio::capture::AudioCaptureBackend;

        let backends = get_audio_backend_info().await.expect("backend info");
        assert!(!backends.is_empty(), "at least one backend must be offered");

        for info in backends {
            assert_eq!(
                AudioCaptureBackend::from_string(&info.id).map(|b| b.id().to_string()),
                Some(info.id.clone()),
                "the id {:?} handed to the frontend does not parse back; a stored preference \
                 written from it would resolve to nothing",
                info.id
            );
            assert_ne!(
                info.id, info.name,
                "the stored id and the human label must stay distinguishable"
            );
        }
    }

    /// The behaviour change this refactor makes, held.
    ///
    /// `AudioCaptureBackend::CoreAudio` is now a variant on every platform, so
    /// `from_string("coreaudio")` returns `Some` here where it used to return `None`. That is
    /// deliberate — it is what makes the macOS mapping testable from Linux — but it must not
    /// turn into a machine accepting a backend it cannot drive. Parsing and offering are two
    /// questions and only the second one gates.
    #[tokio::test]
    async fn a_backend_this_platform_does_not_offer_is_rejected_even_though_its_id_parses() {
        use crate::audio::capture::{AudioCaptureBackend, Platform};

        for backend in [
            AudioCaptureBackend::ScreenCaptureKit,
            AudioCaptureBackend::CoreAudio,
        ] {
            assert_eq!(
                AudioCaptureBackend::from_string(backend.id()),
                Some(backend),
                "every backend's id parses on every platform"
            );

            let offered = backend.is_available_on(Platform::CURRENT);
            let result = set_audio_backend(backend.id().to_string()).await;
            assert_eq!(
                result.is_ok(),
                offered,
                "set_audio_backend({:?}) returned {:?}, but this platform ({:?}) {} it",
                backend.id(),
                result,
                Platform::CURRENT,
                if offered { "offers" } else { "does not offer" }
            );
        }
    }

    /// The list the frontend renders and the list the command accepts are the same list.
    /// They were written out by hand in four places before, with nothing comparing them.
    #[tokio::test]
    async fn what_is_offered_is_exactly_what_is_accepted() {
        use crate::audio::capture::{AudioCaptureBackend, Platform};

        let offered: Vec<String> = get_audio_backend_info()
            .await
            .expect("backend info")
            .into_iter()
            .map(|i| i.id)
            .collect();
        let expected: Vec<String> = AudioCaptureBackend::available_on(Platform::CURRENT)
            .into_iter()
            .map(|b| b.id().to_string())
            .collect();
        assert_eq!(offered, expected);
    }
}


// Backend configuration for system audio capture
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use once_cell::sync::Lazy;
use log::info;

/// Available audio capture backends
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCaptureBackend {
    /// ScreenCaptureKit backend (macOS default)
    /// Uses CPAL with ScreenCaptureKit host for system audio
    ScreenCaptureKit,

    /// Core Audio backend (macOS only)
    /// Uses direct Core Audio API with aggregate device + tap
    #[cfg(target_os = "macos")]
    CoreAudio,
}

impl AudioCaptureBackend {
    /// Get human-readable name
    pub fn name(&self) -> &'static str {
        match self {
            AudioCaptureBackend::ScreenCaptureKit => "ScreenCaptureKit",
            #[cfg(target_os = "macos")]
            AudioCaptureBackend::CoreAudio => "Core Audio",
        }
    }

    /// Get description
    pub fn description(&self) -> &'static str {
        match self {
            AudioCaptureBackend::ScreenCaptureKit => {
                "Apple's ScreenCaptureKit framework - Higher level API with good compatibility"
            }
            #[cfg(target_os = "macos")]
            AudioCaptureBackend::CoreAudio => {
                "Direct Core Audio API - Lower latency, more control over audio pipeline"
            }
        }
    }

    /// Get backend from string
    pub fn from_string(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "screencapturekit" => Some(AudioCaptureBackend::ScreenCaptureKit),
            #[cfg(target_os = "macos")]
            "coreaudio" | "core_audio" => Some(AudioCaptureBackend::CoreAudio),
            _ => None,
        }
    }

    /// The stored identifier: lowercase, stable, and what [`from_string`] parses.
    ///
    /// It used to be an inherent `to_string`, which shadowed this type's own `Display`
    /// (`clippy::inherent_to_string_shadow_display`, deny-by-default). The two were not the
    /// same string and were never meant to be — `Display` writes the human label
    /// ("ScreenCaptureKit"), this writes the id that goes in `recording_preferences.json`
    /// ("screencapturekit") — so a caller reaching one instead of the other silently got the
    /// wrong one. Renamed rather than allowed, because the round trip below is the thing
    /// that must hold.
    ///
    /// [`from_string`]: Self::from_string
    pub fn id(&self) -> &'static str {
        match self {
            AudioCaptureBackend::ScreenCaptureKit => "screencapturekit",
            #[cfg(target_os = "macos")]
            AudioCaptureBackend::CoreAudio => "coreaudio",
        }
    }

    /// Get all available backends for current platform
    pub fn available_backends() -> Vec<Self> {
        #[cfg(target_os = "macos")]
        {
            vec![AudioCaptureBackend::ScreenCaptureKit, AudioCaptureBackend::CoreAudio]
        }

        #[cfg(not(target_os = "macos"))]
        {
            vec![AudioCaptureBackend::ScreenCaptureKit]
        }
    }

    /// The backend this platform uses when nothing is stored.
    ///
    /// Named `for_platform` rather than `default`, which is what it used to be called.
    /// `impl Default for AudioCaptureBackend` below reads `Self::default()`, and that
    /// resolved to *this* method only because Rust prefers an inherent method to a trait
    /// one. Renaming this — which is exactly what `clippy::should_implement_trait`
    /// suggests — would have turned that line into unbounded recursion and a stack overflow
    /// at runtime, with nothing in the type system to say so. So the rename and the caller
    /// move together, and `Default` now names what it calls.
    pub fn for_platform() -> Self {
        #[cfg(target_os = "macos")]
        return AudioCaptureBackend::CoreAudio;

        #[cfg(not(target_os = "macos"))]
        return AudioCaptureBackend::ScreenCaptureKit;
    }
}

impl Default for AudioCaptureBackend {
    fn default() -> Self {
        Self::for_platform()
    }
}

impl std::fmt::Display for AudioCaptureBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name())
    }
}

/// Global backend configuration
pub struct BackendConfig {
    current_backend: RwLock<AudioCaptureBackend>,
}

impl BackendConfig {
    fn new() -> Self {
        Self {
            current_backend: RwLock::new(AudioCaptureBackend::for_platform()),
        }
    }

    /// Get current backend
    pub fn get(&self) -> AudioCaptureBackend {
        *self.current_backend.read().unwrap()
    }

    /// Set current backend
    pub fn set(&self, backend: AudioCaptureBackend) {
        info!("Switching audio capture backend to: {:?}", backend);
        *self.current_backend.write().unwrap() = backend;
    }

    /// Get available backends
    pub fn available(&self) -> Vec<AudioCaptureBackend> {
        AudioCaptureBackend::available_backends()
    }

    /// Reset to default
    pub fn reset(&self) {
        self.set(AudioCaptureBackend::for_platform());
    }
}

/// Global backend configuration instance
pub static BACKEND_CONFIG: Lazy<Arc<BackendConfig>> = Lazy::new(|| {
    Arc::new(BackendConfig::new())
});

/// Get current backend
pub fn get_current_backend() -> AudioCaptureBackend {
    BACKEND_CONFIG.get()
}

/// Set current backend
pub fn set_current_backend(backend: AudioCaptureBackend) {
    BACKEND_CONFIG.set(backend);
}

/// Get available backends
pub fn get_available_backends() -> Vec<AudioCaptureBackend> {
    BACKEND_CONFIG.available()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The round trip the rename exists to protect.
    ///
    /// `id()` is what goes into `recording_preferences.json` and what `from_string` parses
    /// back; `Display` is the human label. They are deliberately different strings, and
    /// while an inherent `to_string` shadowed `Display` nobody could tell from a call site
    /// which of the two they were getting. Two call sites in
    /// `recording_preferences.rs` were writing `id: X.to_string()` — correct only by the
    /// shadow, and silently wrong the moment it was removed.
    #[test]
    fn the_stored_id_round_trips_and_is_not_the_display_label() {
        let backends = [
            AudioCaptureBackend::ScreenCaptureKit,
            #[cfg(target_os = "macos")]
            AudioCaptureBackend::CoreAudio,
        ];

        for backend in backends {
            assert_eq!(
                AudioCaptureBackend::from_string(backend.id()),
                Some(backend),
                "the stored id {:?} must parse back to the backend that wrote it",
                backend.id()
            );
            assert_ne!(
                backend.id(),
                backend.to_string(),
                "the id and the Display label are different strings by design; if they ever \
                 become equal, a call site reaching the wrong one stops being detectable"
            );
        }
    }

    #[test]
    fn test_backend_to_string() {
        assert_eq!(AudioCaptureBackend::ScreenCaptureKit.id(), "screencapturekit");
        #[cfg(target_os = "macos")]
        assert_eq!(AudioCaptureBackend::CoreAudio.id(), "coreaudio");
    }

    #[test]
    fn test_backend_from_string() {
        assert_eq!(
            AudioCaptureBackend::from_string("screencapturekit"),
            Some(AudioCaptureBackend::ScreenCaptureKit)
        );
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                AudioCaptureBackend::from_string("coreaudio"),
                Some(AudioCaptureBackend::CoreAudio)
            );
            assert_eq!(
                AudioCaptureBackend::from_string("core_audio"),
                Some(AudioCaptureBackend::CoreAudio)
            );
        }
    }

    #[test]
    fn test_available_backends() {
        let backends = AudioCaptureBackend::available_backends();
        assert!(backends.contains(&AudioCaptureBackend::ScreenCaptureKit));

        #[cfg(target_os = "macos")]
        assert!(backends.contains(&AudioCaptureBackend::CoreAudio));
    }

    #[test]
    fn test_default_backend() {
        #[cfg(target_os = "macos")]
        assert_eq!(AudioCaptureBackend::for_platform(), AudioCaptureBackend::CoreAudio);

        #[cfg(not(target_os = "macos"))]
        assert_eq!(AudioCaptureBackend::for_platform(), AudioCaptureBackend::ScreenCaptureKit);
    }

    #[test]
    fn test_backend_config() {
        let config = BackendConfig::new();

        // Should start with default
        #[cfg(target_os = "macos")]
        assert_eq!(config.get(), AudioCaptureBackend::CoreAudio);

        #[cfg(not(target_os = "macos"))]
        assert_eq!(config.get(), AudioCaptureBackend::ScreenCaptureKit);

        #[cfg(target_os = "macos")]
        {
            // Test setting CoreAudio
            config.set(AudioCaptureBackend::CoreAudio);
            assert_eq!(config.get(), AudioCaptureBackend::CoreAudio);
        }

        // Test reset
        config.reset();
        #[cfg(target_os = "macos")]
        assert_eq!(config.get(), AudioCaptureBackend::CoreAudio);

        #[cfg(not(target_os = "macos"))]
        assert_eq!(config.get(), AudioCaptureBackend::ScreenCaptureKit);
    }
}
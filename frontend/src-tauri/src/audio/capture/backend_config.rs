// Backend configuration for system audio capture
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use once_cell::sync::Lazy;
use log::info;

/// The operating system a decision is being made *for*.
///
/// This exists so that "which backends does macOS have" is a question anyone can ask from
/// anywhere, instead of a fact only a macOS compiler can see. Before it, the availability
/// rule was written four times — `available_backends`, `for_platform`,
/// `set_audio_backend`'s non-macOS branch (as the bare string `"screencapturekit"`) and
/// `get_audio_backend_info` — with nothing checking that the four agreed, and none of them
/// reachable by a test on Linux.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

impl Platform {
    /// The platform this binary was compiled for.
    ///
    /// **This is the only place in this module where a `cfg` decides anything.** Everything
    /// below takes a `Platform` and is therefore testable for every platform on any machine.
    #[cfg(target_os = "macos")]
    pub const CURRENT: Platform = Platform::MacOs;
    #[cfg(target_os = "windows")]
    pub const CURRENT: Platform = Platform::Windows;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub const CURRENT: Platform = Platform::Linux;
}

/// Available audio capture backends
///
/// Every variant exists on every platform. Which of them a given platform *offers* is
/// [`AudioCaptureBackend::available_on`], and whether the machine can actually drive one is a
/// separate question answered by the capture implementation — `CoreAudioCapture` is still
/// macOS-only code. Gating the variant itself meant `from_string("coreaudio")` returned
/// `None` off macOS, which reads as "no such backend" rather than "not available here", and
/// it made the id/label round trip untestable for the one variant the round trip was about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCaptureBackend {
    /// ScreenCaptureKit backend (macOS default)
    /// Uses CPAL with ScreenCaptureKit host for system audio
    ScreenCaptureKit,

    /// Core Audio backend (macOS only)
    /// Uses direct Core Audio API with aggregate device + tap
    CoreAudio,
}

impl AudioCaptureBackend {
    /// Get human-readable name
    pub fn name(&self) -> &'static str {
        match self {
            AudioCaptureBackend::ScreenCaptureKit => "ScreenCaptureKit",
            AudioCaptureBackend::CoreAudio => "Core Audio",
        }
    }

    /// Get description
    pub fn description(&self) -> &'static str {
        match self {
            AudioCaptureBackend::ScreenCaptureKit => {
                "Apple's ScreenCaptureKit framework - Higher level API with good compatibility"
            }
            AudioCaptureBackend::CoreAudio => {
                "Direct Core Audio API - Lower latency, more control over audio pipeline"
            }
        }
    }

    /// Get backend from string
    pub fn from_string(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "screencapturekit" => Some(AudioCaptureBackend::ScreenCaptureKit),
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
            AudioCaptureBackend::CoreAudio => "coreaudio",
        }
    }

    /// Which backends a given platform offers. Pure, and the single source of that rule.
    pub fn available_on(platform: Platform) -> Vec<Self> {
        match platform {
            Platform::MacOs => vec![
                AudioCaptureBackend::ScreenCaptureKit,
                AudioCaptureBackend::CoreAudio,
            ],
            Platform::Windows | Platform::Linux => vec![AudioCaptureBackend::ScreenCaptureKit],
        }
    }

    /// Whether a platform offers this backend. The one rule `set_audio_backend` rejects on.
    pub fn is_available_on(self, platform: Platform) -> bool {
        Self::available_on(platform).contains(&self)
    }

    /// Get all available backends for current platform
    pub fn available_backends() -> Vec<Self> {
        Self::available_on(Platform::CURRENT)
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
        Self::default_on(Platform::CURRENT)
    }

    /// What a given platform uses when nothing is stored. Pure, and testable for a platform
    /// you are not running on.
    pub fn default_on(platform: Platform) -> Self {
        match platform {
            Platform::MacOs => AudioCaptureBackend::CoreAudio,
            Platform::Windows | Platform::Linux => AudioCaptureBackend::ScreenCaptureKit,
        }
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

    /// The tests this refactor exists for: **every one of them asserts a macOS answer while
    /// running on Linux.** Before `Platform` was a parameter, none of them could be written —
    /// the rule lived inside `#[cfg(target_os = "macos")]`, so a Linux machine could not ask
    /// what macOS does, and the CI that never compiled macOS could not either.
    #[test]
    fn the_macos_answer_is_available_from_any_machine() {
        assert_eq!(
            AudioCaptureBackend::available_on(Platform::MacOs),
            vec![
                AudioCaptureBackend::ScreenCaptureKit,
                AudioCaptureBackend::CoreAudio
            ],
            "macOS offers both backends. This assertion runs on whatever platform you are on; \
             if it only held on macOS it would be worth nothing, because macOS is where it was \
             already true."
        );
        assert_eq!(
            AudioCaptureBackend::default_on(Platform::MacOs),
            AudioCaptureBackend::CoreAudio,
            "macOS defaults to Core Audio"
        );
    }

    #[test]
    fn the_platforms_that_offer_one_backend_offer_the_same_one() {
        for platform in [Platform::Linux, Platform::Windows] {
            assert_eq!(
                AudioCaptureBackend::available_on(platform),
                vec![AudioCaptureBackend::ScreenCaptureKit],
                "{platform:?} offers exactly one backend"
            );
            assert_eq!(
                AudioCaptureBackend::default_on(platform),
                AudioCaptureBackend::ScreenCaptureKit,
                "{platform:?} defaults to the one it offers"
            );
        }
    }

    /// A default nobody offers is the shape of a preference that resolves to something the
    /// machine cannot do — the class `stale_preference_from_the_alsa_era_does_not_silently_resolve`
    /// covers for devices. Checked for all three platforms from one machine.
    #[test]
    fn every_platform_defaults_to_something_it_offers() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
            let default = AudioCaptureBackend::default_on(platform);
            assert!(
                default.is_available_on(platform),
                "{platform:?} defaults to {default:?}, which it does not offer"
            );
        }
    }

    /// `CoreAudio` is now a variant on every platform, which is what makes the round trip
    /// above testable here. Availability is a separate question and must stay separate: the
    /// id parsing back does **not** mean this machine can drive it.
    #[test]
    fn parsing_a_backend_is_not_the_same_question_as_offering_it() {
        let parsed = AudioCaptureBackend::from_string("coreaudio")
            .expect("`coreaudio` is a backend that exists, on every platform");
        assert_eq!(parsed, AudioCaptureBackend::CoreAudio);
        assert!(
            !parsed.is_available_on(Platform::Linux),
            "Linux must not offer Core Audio, however well its id parses"
        );
        assert!(parsed.is_available_on(Platform::MacOs));
    }

    /// The compiled-in constant agrees with the platform this test is running on. The only
    /// `cfg` left in this module is the one that sets it, so this is the assertion that keeps
    /// it honest.
    #[test]
    fn current_names_the_platform_this_binary_was_built_for() {
        let expected = if cfg!(target_os = "macos") {
            Platform::MacOs
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Linux
        };
        assert_eq!(Platform::CURRENT, expected);
        assert_eq!(
            AudioCaptureBackend::available_backends(),
            AudioCaptureBackend::available_on(Platform::CURRENT)
        );
        assert_eq!(
            AudioCaptureBackend::for_platform(),
            AudioCaptureBackend::default_on(Platform::CURRENT)
        );
    }

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
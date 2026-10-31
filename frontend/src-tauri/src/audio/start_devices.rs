//! Which devices a recording start opens (#242).
//!
//! Resolved from the stored preferences at the moment of the start, on every route. The record
//! button, the sidebar, the tray and the call nudge all reach one command, and the frontend sends it
//! no devices: its copy of the preferences went stale whenever Settings changed a device, and the tray
//! and the nudge reload the window before they start, so they sent none at all. Until #242 the
//! devices the frontend did send never arrived either (snake_case keys to a camelCase command), so
//! every start already read the store; this keeps that, and makes it the only way.

use anyhow::Result;
use log::{info, warn};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

/// What a start opens.
#[derive(Debug, PartialEq, Eq)]
pub struct StartDevices<D> {
    pub microphone: D,
    /// `None` when there is no system audio to record; `warning` then says why.
    pub system: Option<D>,
    pub warning: Option<String>,
}

/// Default (`None`) is the default device, for either side.
///
/// - A named microphone that is missing fails the start. The default is not put in its place (#9):
///   recording a microphone the person did not pick, without saying so, is worse than not starting.
/// - A named system device that is missing leaves the system side out, with a warning, and the
///   microphone records. So does a default system device that cannot be found.
pub fn resolve<D>(
    microphone: Option<&str>,
    system: Option<&str>,
    by_name: impl Fn(&str) -> Result<D>,
    default_microphone: impl FnOnce() -> Result<D>,
    default_system: impl FnOnce() -> Result<D>,
) -> Result<StartDevices<D>, String> {
    let microphone = match microphone {
        None => default_microphone().map_err(|e| format!("No microphone device available: {e}"))?,
        Some(name) => by_name(name).map_err(|e| format!("The microphone '{name}' is not available: {e}"))?,
    };
    let (system, warning) = match system {
        None => match default_system() {
            Ok(device) => (Some(device), None),
            Err(e) => (None, Some(format!("No default system audio device ({e}); recording the microphone only"))),
        },
        Some(name) => match by_name(name) {
            Ok(device) => (Some(device), None),
            Err(e) => (None, Some(format!("The system audio device '{name}' is not available ({e}); recording the microphone only"))),
        },
    };
    Ok(StartDevices { microphone, system, warning })
}

/// What a start records with: the devices, and where and whether it saves.
#[derive(Debug, PartialEq, Eq)]
pub struct Start<D> {
    pub devices: StartDevices<D>,
    pub auto_save: bool,
    pub save_folder: Option<PathBuf>,
}

/// The start's preferences, read from `store` now, and the devices they name, resolved by [`resolve`].
/// Every start calls this, so a device picked in Settings is the one the next start opens, and a
/// start made before the window has read the store (the tray, the call nudge) still opens it.
/// Preferences that cannot be read are the defaults, as they always were.
pub async fn from_store<R: Runtime, D>(
    app: &AppHandle<R>,
    store: &Path,
    by_name: impl Fn(&str) -> Result<D>,
    default_microphone: impl FnOnce() -> Result<D>,
    default_system: impl FnOnce() -> Result<D>,
) -> Result<Start<D>, String> {
    let (auto_save, microphone, system, save_folder) =
        match super::recording_preferences::load_recording_preferences_from(app, store).await {
            Ok(prefs) => {
                info!("📋 Loaded recording preferences: auto_save={}, save_folder={:?}, preferred_mic={:?}, preferred_system={:?}",
                      prefs.auto_save, prefs.save_folder, prefs.preferred_mic_device, prefs.preferred_system_device);
                (prefs.auto_save, prefs.preferred_mic_device, prefs.preferred_system_device, Some(prefs.save_folder))
            }
            Err(e) => {
                warn!("Failed to load recording preferences, using defaults: {}", e);
                (true, None, None, None)
            }
        };
    let devices = resolve(microphone.as_deref(), system.as_deref(), by_name, default_microphone, default_system)?;
    Ok(Start { devices, auto_save, save_folder })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Devices are names here: the lookups are what a machine has. "Mic A" and "Monitor B" exist,
    // "default mic" and "default monitor" are what the defaults return; anything else is missing.
    const MIC: &str = "Mic A (input)";
    const SYS: &str = "Monitor B (output)";
    const GONE_MIC: &str = "Unplugged mic (input)";
    const GONE_SYS: &str = "Unplugged monitor (output)";

    fn by_name(name: &str) -> Result<String> {
        match name {
            MIC | SYS => Ok(name.to_string()),
            _ => Err(anyhow::anyhow!("Device not found: {name}")),
        }
    }
    fn run(mic: Option<&str>, sys: Option<&str>) -> Result<StartDevices<String>, String> {
        resolve(mic, sys, by_name, || Ok("default mic".to_string()), || Ok("default monitor".to_string()))
    }
    fn both(mic: &str, sys: &str) -> Result<StartDevices<String>, String> {
        Ok(StartDevices { microphone: mic.to_string(), system: Some(sys.to_string()), warning: None })
    }

    #[test]
    fn default_and_default_open_both_defaults() {
        assert_eq!(run(None, None), both("default mic", "default monitor"));
    }

    #[test]
    fn default_microphone_and_a_named_system_device_open_both() {
        assert_eq!(run(None, Some(SYS)), both("default mic", SYS));
    }

    #[test]
    fn a_named_microphone_and_the_default_system_device_open_both() {
        assert_eq!(run(Some(MIC), None), both(MIC, "default monitor"));
    }

    #[test]
    fn named_and_named_open_both() {
        assert_eq!(run(Some(MIC), Some(SYS)), both(MIC, SYS));
    }

    #[test]
    fn default_microphone_and_a_missing_system_device_record_the_microphone_only() {
        let r = run(None, Some(GONE_SYS)).unwrap();
        assert_eq!((r.microphone.as_str(), r.system), ("default mic", None));
        assert!(r.warning.as_deref().is_some_and(|w| w.contains(GONE_SYS)), "no warning names the missing device: {:?}", r.warning);
    }

    #[test]
    fn a_named_microphone_and_a_missing_system_device_record_the_microphone_only() {
        let r = run(Some(MIC), Some(GONE_SYS)).unwrap();
        assert_eq!((r.microphone.as_str(), r.system), (MIC, None));
        assert!(r.warning.as_deref().is_some_and(|w| w.contains(GONE_SYS)), "no warning names the missing device: {:?}", r.warning);
    }

    #[test]
    fn a_missing_microphone_fails_the_start_and_is_not_replaced_by_the_default() {
        for sys in [None, Some(SYS), Some(GONE_SYS)] {
            let r = run(Some(GONE_MIC), sys);
            assert!(matches!(&r, Err(e) if e.contains(GONE_MIC)), "system {sys:?}: a missing microphone gave {r:?}");
        }
    }

    #[test]
    fn no_default_system_device_records_the_microphone_only() {
        let r = resolve(None, None, by_name, || Ok("default mic".to_string()), || Err(anyhow::anyhow!("no output"))).unwrap();
        assert_eq!((r.microphone.as_str(), r.system), ("default mic", None));
        assert!(r.warning.is_some());
    }

    #[test]
    fn no_default_microphone_fails_the_start() {
        let r = resolve(None, Some(SYS), by_name, || Err(anyhow::anyhow!("no input")), || Ok("default monitor".to_string()));
        assert!(r.is_err(), "{r:?}");
    }

    /// The start as the app makes it, over a store on disk: a mock app with the store plugin, and
    /// the preferences file at an absolute path in a temporary directory, never the app-data one.
    mod from_the_store {
        use super::*;
        use crate::audio::recording_preferences::{save_recording_preferences_to, RecordingPreferences};

        const A: &str = "Monitor A (output)";
        const B: &str = "Monitor B (output)";

        fn by_name(name: &str) -> Result<String> {
            match name {
                MIC | A | B => Ok(name.to_string()),
                _ => Err(anyhow::anyhow!("Device not found: {name}")),
            }
        }

        /// A store file holding `system` before the app is built: what was stored at launch.
        fn app_with(system: Option<&str>) -> (tempfile::TempDir, std::path::PathBuf, tauri::App<tauri::test::MockRuntime>) {
            let dir = tempfile::tempdir().unwrap();
            let store = dir.path().join("recording_preferences.json");
            let prefs = RecordingPreferences { preferred_system_device: system.map(str::to_string), save_folder: dir.path().join("recordings"), ..Default::default() };
            std::fs::write(&store, serde_json::json!({ "preferences": prefs }).to_string()).unwrap();
            let app = tauri::test::mock_builder()
                .plugin(tauri_plugin_store::Builder::new().build())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            (dir, store, app)
        }

        async fn start(app: &tauri::App<tauri::test::MockRuntime>, store: &Path) -> Option<String> {
            let s = from_store(app.handle(), store, by_name, || Ok("default mic".to_string()), || Ok("default monitor".to_string())).await.unwrap();
            s.devices.system
        }

        /// What Settings does with a pick: `set_recording_preferences`, which writes the same store.
        async fn pick(app: &tauri::App<tauri::test::MockRuntime>, store: &Path, system: Option<&str>) {
            let mut prefs = crate::audio::recording_preferences::load_recording_preferences_from(app.handle(), store).await.unwrap();
            prefs.preferred_system_device = system.map(str::to_string);
            save_recording_preferences_to(app.handle(), store, &prefs).await.unwrap();
        }

        #[tokio::test]
        async fn a_device_picked_in_settings_is_the_one_the_next_start_opens() {
            let (_dir, store, app) = app_with(Some(A));
            assert_eq!(start(&app, &store).await.as_deref(), Some(A), "the first start, with A stored at launch");
            pick(&app, &store, Some(B)).await;
            assert_eq!(start(&app, &store).await.as_deref(), Some(B), "B was picked in Settings after a start opened A");
        }

        #[tokio::test]
        async fn default_picked_in_settings_is_the_default_device_at_the_next_start() {
            let (_dir, store, app) = app_with(Some(A));
            assert_eq!(start(&app, &store).await.as_deref(), Some(A), "the first start, with A stored at launch");
            pick(&app, &store, None).await;
            assert_eq!(start(&app, &store).await.as_deref(), Some("default monitor"), "Default was picked in Settings after a start opened A");
        }

        /// The tray and the call nudge reload the window and start before it has read anything: the
        /// start's own read is what opens the stored device.
        #[tokio::test]
        async fn a_start_with_nothing_read_yet_opens_the_stored_device() {
            let (_dir, store, app) = app_with(Some(B));
            assert_eq!(start(&app, &store).await.as_deref(), Some(B));
        }
    }
}

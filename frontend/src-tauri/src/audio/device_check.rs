//! Prove a capture device works, before a meeting depends on it.
//!
//! #111 cycle C. The first run used to hand a new user a device list and no way to tell whether any
//! of it worked; the first evidence arrived in the middle of a real meeting.
//!
//! **A level meter is not proof.** It moves for any device that is delivering samples, and #10 is
//! the case where eleven inputs share one display name — a meter confirms *something* is open, not
//! that it is the thing the user selected. Text is proof: words come back only if the device
//! carrying speech is the one being read.
//!
//! Nothing here creates a meeting or writes a file. `RecordingManager::start_recording` with
//! `auto_save: false` and no folder makes `RecordingSaver` write nothing, which is the same
//! arrangement `dictation_probe` uses.

use crate::audio::devices::{list_audio_devices, AudioDevice, DeviceType};
use crate::audio::recording_commands::is_recording_now;
use crate::audio::{AudioChunk, RecordingManager};
use crate::transcribe_engine::TRANSCRIBE_ENGINE;
use log::{info, warn};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a check listens before deciding. Long enough for a sentence, short enough that a user
/// who selected the wrong device does not sit through it twice.
const LISTEN: Duration = Duration::from_secs(6);

/// What a check found.
#[derive(Debug, Serialize)]
pub struct DeviceCheck {
    /// The device that was actually opened, by the name the enumerator gave it.
    pub device: String,
    /// Whether any audio arrived at all. False means the device is silent, not that it is wrong.
    pub heard_audio: bool,
    /// What the decoder made of it. Empty when nothing was said, or nothing intelligible was.
    pub text: String,
}

fn find(devices: Vec<AudioDevice>, name: &str, kind: DeviceType) -> Option<AudioDevice> {
    devices
        .into_iter()
        .find(|d| d.name == name && d.device_type == kind)
}

/// Capture from one named device and transcribe what it heard.
///
/// `system` selects which half of the pipeline is opened: the microphone, or the output monitor that
/// carries what the other side says. Only one is opened, so the returned text belongs to that device
/// and to no other.
#[tauri::command]
pub async fn check_capture_device(name: String, system: bool) -> Result<DeviceCheck, String> {
    // Refuse rather than disturb a meeting. A second stream on the same `Model` fails with
    // `Error::Busy`, and a second microphone stream is real damage to a recording in progress.
    if is_recording_now() {
        return Err(
            "A recording is in progress. Stop it before checking a device — this would open a \
             second stream on the same model."
                .to_string(),
        );
    }

    let engine = {
        let guard = TRANSCRIBE_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    }
    .ok_or_else(|| "No transcription model is loaded yet.".to_string())?;

    let kind = if system { DeviceType::Output } else { DeviceType::Input };
    let devices = list_audio_devices()
        .await
        .map_err(|e| format!("Could not list audio devices: {e}"))?;
    let device = find(devices, &name, kind)
        .ok_or_else(|| format!("No {} device called {name:?} is available.", if system { "output" } else { "input" }))?;
    let device_name = device.name.clone();

    let mut manager = RecordingManager::new();
    let device = Arc::new(device);
    let mut capture = if system {
        manager.start_recording(None, Some(device), false, None).await
    } else {
        manager.start_recording(Some(device), None, false, None).await
    }
    .map_err(|e| format!("Could not open {device_name}: {e}"))?;

    // Collect for a fixed window. The pipeline hands over 16 kHz mono, which is what the decoder
    // wants, so nothing is resampled here.
    let mut samples: Vec<f32> = Vec::new();
    let deadline = Instant::now() + LISTEN;
    while Instant::now() < deadline {
        match tokio::time::timeout(deadline - Instant::now(), capture.recv()).await {
            Ok(Some(chunk)) => samples.extend_from_slice(chunk_samples(&chunk)),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    // `stop_streams_only`, not `stop_recording`: the latter saves, and this check has nothing to
    // save. It is idempotent and takes no AppHandle, which is also why this command needs none.
    if let Err(e) = manager.stop_streams_only().await {
        warn!("Device check: could not stop capture cleanly: {e}");
    }

    let heard_audio = samples.iter().any(|s| s.abs() > 0.002);
    info!(
        "Device check on {device_name}: {} samples, audio={heard_audio}",
        samples.len()
    );

    if !heard_audio {
        return Ok(DeviceCheck { device: device_name, heard_audio: false, text: String::new() });
    }

    let result = engine
        .transcribe_batch(samples, None)
        .await
        .map_err(|e| format!("Could not transcribe what {device_name} heard: {e}"))?;

    Ok(DeviceCheck {
        device: device_name,
        heard_audio: true,
        text: result.text.trim().to_string(),
    })
}

/// The mixed mono samples a chunk carries.
fn chunk_samples(chunk: &AudioChunk) -> &[f32] {
    &chunk.data
}

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

use crate::audio::devices::{default_input_device, list_audio_devices, AudioDevice, DeviceType};
use crate::audio::recording_commands::is_recording_now;
use crate::audio::recording_state::DeviceType as Channel;
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
    /// Whether the device opened is the system default input, read when it was proven, by the function a
    /// start uses when no microphone is stored. First run keeps a non-default microphone it proved, and
    /// clears a stored one when the default was proven instead (#299). Always false for a system check,
    /// and false when no default can be read. Compared by name, so it inherits #10.
    pub is_default: bool,
}

/// The one place a check's result is built, so both of the command's results say whether the device
/// was the default, and a test can hold the comparison without a device.
fn check_result(
    device: String,
    system: bool,
    heard_audio: bool,
    text: String,
    default_input: anyhow::Result<AudioDevice>,
) -> DeviceCheck {
    let is_default = !system && default_input.map(|d| d.name == device).unwrap_or(false);
    DeviceCheck { device, heard_audio, text, is_default }
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

    // Held until this function returns: the idle unloader leaves the model alone while it is set,
    // and resets its clock when it is released.
    let _holds_engine = crate::audio::common::DeviceCheckHoldsEngine::take();

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

    // Collect one side for a fixed window. The channel is 16 kHz, which is what the decoder wants,
    // so nothing is resampled here; see `take_side` for why only one side is kept.
    let side = side_checked(system);
    let mut samples: Vec<f32> = Vec::new();
    let deadline = Instant::now() + LISTEN;
    while Instant::now() < deadline {
        match tokio::time::timeout(deadline - Instant::now(), capture.recv()).await {
            Ok(Some(chunk)) => take_side(&mut samples, &chunk, &side),
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
        return Ok(check_result(device_name, system, false, String::new(), default_input_device()));
    }

    let result = engine
        .transcribe_batch(samples, None)
        .await
        .map_err(|e| format!("Could not transcribe what {device_name} heard: {e}"))?;

    Ok(check_result(device_name, system, true, result.text.trim().to_string(), default_input_device()))
}

/// Which side of the transcription channel a check reads. A function of its own because nothing else
/// holds the mapping: the unit tests below pass a side to `take_side` themselves, so a check that
/// always read the microphone would pass them and report every system device as silent.
fn side_checked(system: bool) -> Channel {
    if system { Channel::System } else { Channel::Microphone }
}

/// Keep a chunk only if it belongs to the side being checked.
///
/// The transcription channel carries **both** sides of every window, as two chunks tagged by
/// `device_type`, and the side a check did not open arrives as a zero window (`pipeline.rs`,
/// `forward_mixed`). This used to append every chunk, under a comment calling the channel "mixed
/// mono", which had been false since #30. So the decoder heard 50 ms of speech, then 50 ms of
/// zeros, over and over: 195 198 samples for a six-second window, measured 2026-10-24 (#168).
fn take_side(samples: &mut Vec<f32>, chunk: &AudioChunk, side: &Channel) {
    if &chunk.device_type == side {
        samples.extend_from_slice(&chunk.data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::pipeline::transcription_chunks_for_test;

    /// One constant per side, so a sample says which side it came from by its value alone.
    const MIC: f32 = 0.25;
    const SYS: f32 = 0.5;
    const WINDOW: usize = 1600;

    fn collect(chunks: &[AudioChunk], side: Channel) -> Vec<f32> {
        let mut samples = Vec::new();
        for chunk in chunks {
            take_side(&mut samples, chunk, &side);
        }
        samples
    }

    // `tokio::test`: the pipeline's metrics batcher spawns onto a reactor.
    #[tokio::test]
    async fn a_microphone_check_hears_the_microphone_and_nothing_else() {
        // What a microphone check receives: the system side was never opened, so the mixer fills it
        // with a zero window, and the pipeline sends that window as a chunk of its own.
        let chunks = transcription_chunks_for_test(&[
            (&[MIC; WINDOW], &[0.0; WINDOW]),
            (&[MIC; WINDOW], &[0.0; WINDOW]),
            (&[MIC; WINDOW], &[0.0; WINDOW]),
        ]);
        // The sentinel: both sides really are on the channel, so the assertion below is about
        // which ones were kept, not about a fixture that only ever held one.
        assert_eq!(chunks.len(), 6, "three windows, two sides each");

        let heard = collect(&chunks, Channel::Microphone);
        assert_eq!(
            heard,
            vec![MIC; 3 * WINDOW],
            "the decoder must get the microphone's samples alone, in order. {} of {} samples were \
             zeros from the side this check never opened",
            heard.iter().filter(|&&s| s == 0.0).count(),
            heard.len()
        );
    }

    #[tokio::test]
    async fn a_system_check_hears_the_system_side_and_nothing_else() {
        let chunks = transcription_chunks_for_test(&[
            (&[0.0; WINDOW], &[SYS; WINDOW]),
            (&[0.0; WINDOW], &[SYS; WINDOW]),
        ]);
        assert_eq!(chunks.len(), 4);
        assert_eq!(collect(&chunks, Channel::System), vec![SYS; 2 * WINDOW]);
    }

    #[tokio::test]
    async fn each_side_is_kept_whole_when_both_carry_sound() {
        // The check never opens both, but the channel is shared with recording, where both carry
        // sound. Taking every other chunk would pass the two tests above for one side and not this.
        let chunks = transcription_chunks_for_test(&[
            (&[MIC; WINDOW], &[SYS; WINDOW]),
            (&[MIC; WINDOW], &[SYS; WINDOW]),
        ]);
        assert_eq!(collect(&chunks, Channel::Microphone), vec![MIC; 2 * WINDOW]);
        assert_eq!(collect(&chunks, Channel::System), vec![SYS; 2 * WINDOW]);
    }

    #[tokio::test]
    async fn a_silent_device_stays_one_side_long() {
        // Silence is still decided on one side's samples: the length is what the `Device check on`
        // log line reports, and the gate reads that line.
        let chunks = transcription_chunks_for_test(&[
            (&[0.0; WINDOW], &[0.0; WINDOW]),
            (&[0.0; WINDOW], &[0.0; WINDOW]),
        ]);
        let heard = collect(&chunks, Channel::Microphone);
        assert_eq!(heard.len(), 2 * WINDOW);
        assert!(heard.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn the_system_row_reads_the_system_side() {
        assert_eq!(side_checked(true), Channel::System);
        assert_eq!(side_checked(false), Channel::Microphone);
    }

    fn named(name: &str) -> anyhow::Result<AudioDevice> {
        Ok(AudioDevice::new(name.to_string(), DeviceType::Input))
    }

    #[test]
    fn a_microphone_check_on_the_default_says_so() {
        assert!(check_result("Digital Microphone".into(), false, true, "hi".into(), named("Digital Microphone")).is_default);
    }

    #[test]
    fn a_microphone_check_on_another_device_is_not_the_default() {
        assert!(!check_result("Headset Microphone".into(), false, true, "hi".into(), named("Digital Microphone")).is_default);
    }

    #[test]
    fn no_default_to_read_is_not_the_default() {
        let none = Err(anyhow::anyhow!("No default input device found"));
        assert!(!check_result("Digital Microphone".into(), false, true, "hi".into(), none).is_default);
    }

    #[test]
    fn a_system_check_is_never_the_default_input() {
        // A monitor may share a name with an input; the system row is not a microphone either way.
        assert!(!check_result("Digital Microphone".into(), true, true, "hi".into(), named("Digital Microphone")).is_default);
    }

    #[test]
    fn the_result_carries_is_default_by_that_name() {
        let value = serde_json::to_value(check_result("Digital Microphone".into(), false, false, String::new(), named("Digital Microphone"))).unwrap();
        assert_eq!(value.get("is_default"), Some(&serde_json::Value::Bool(true)), "{value}");
        assert_eq!(value.get("device"), Some(&serde_json::Value::String("Digital Microphone".into())));
    }

    #[tokio::test]
    async fn a_short_tail_keeps_its_own_length() {
        // The pipeline's flush forwards whatever is left of each side (`pipeline.rs`, the tail
        // `forward_mixed`), and the two need not be the same length.
        let chunks = transcription_chunks_for_test(&[
            (&[MIC; WINDOW], &[0.0; WINDOW]),
            (&[MIC; 400], &[0.0; 1200]),
        ]);
        assert_eq!(collect(&chunks, Channel::Microphone), vec![MIC; WINDOW + 400]);
    }
}

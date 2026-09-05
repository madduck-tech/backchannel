use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, warn};

use super::configuration::AudioDevice;
// Only the non-Linux branch below still resolves devices by display name; on Linux
// `configure_linux_audio` returns both roles and nothing is appended after it.
#[cfg(not(target_os = "linux"))]
use super::configuration::{device_name, DeviceType};
use super::host::audio_host;
use super::platform;

/// List all available audio devices on the system
pub async fn list_audio_devices() -> Result<Vec<AudioDevice>> {
    let host = audio_host();

    // Platform-specific device enumeration
    #[cfg_attr(target_os = "linux", allow(unused_mut))]
    let mut devices = {
        #[cfg(target_os = "windows")]
        {
            platform::configure_windows_audio(&host)?
        }

        #[cfg(target_os = "linux")]
        {
            platform::configure_linux_audio(&host)?
        }

        #[cfg(target_os = "macos")]
        {
            platform::configure_macos_audio(&host)?
        }
    };

    // Add any additional devices from the default host.
    //
    // Not on Linux: `configure_linux_audio` already enumerates both roles from this same
    // host, and `host.devices()` there also yields the sinks. A sink is an output, and
    // cpal's PulseAudio backend can only build an input stream from a source
    // (`build_input_stream_raw` passes a `source_index`), so adding sinks to the
    // system-audio list would offer entries that cannot be recorded. What *can* be
    // recorded is the sink's monitor, which the enumeration above already returns.
    #[cfg(not(target_os = "linux"))]
    if let Ok(other_devices) = host.devices() {
        for device in other_devices {
            if let Ok(name) = device_name(&device) {
                if !devices.iter().any(|d| d.name == name) {
                    devices.push(AudioDevice::new(name, DeviceType::Output));
                }
            }
        }
    }

    Ok(devices)
}

/// Trigger audio permission request on platforms that require it
/// Returns Ok(true) if permission is granted, Ok(false) if denied, Err if something went wrong
pub fn trigger_audio_permission() -> Result<bool> {
    use log::info;

    let host = audio_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            info!("[trigger_audio_permission] No default input device found - permission likely denied");
            return Ok(false);
        }
    };

    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            info!("[trigger_audio_permission] Failed to get input config: {} - permission likely denied", e);
            return Ok(false);
        }
    };

    // Measure while the stream runs, rather than discarding the samples.
    //
    // This callback used to be empty: the probe opened the device, slept, and reported
    // "permission granted" -- which onboarding renders as "Microphone: authorized". On a
    // machine whose default source delivers digital zeros, and this one does, that is a
    // report about half a second of silence. The samples are already arriving; summing them
    // costs nothing and turns the probe into an answer to the question the user is being
    // asked, which is whether the microphone works.
    let peak = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let peak_in_cb = peak.clone();
    let stream = match device.build_input_stream(
        config.into(),
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            let mut local = 0.0f32;
            for sample in data {
                let magnitude = sample.abs();
                if magnitude > local {
                    local = magnitude;
                }
            }
            // Stored as bits because there is no AtomicF32; only ever compared as f32.
            let scaled = (local * 1_000_000.0) as u32;
            peak_in_cb.fetch_max(scaled, std::sync::atomic::Ordering::Relaxed);
        },
        |err| error!("Error in audio stream: {}", err),
        None,
    ) {
        Ok(s) => s,
        Err(e) => {
            info!("[trigger_audio_permission] Failed to build input stream: {} - permission likely denied", e);
            return Ok(false);
        }
    };

    // Start the stream to actually trigger the permission dialog
    if let Err(e) = stream.play() {
        info!("[trigger_audio_permission] Failed to play stream: {} - permission likely denied", e);
        return Ok(false);
    }

    // Sleep briefly to allow the permission dialog to appear and for stream to actually work
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Permission is granted -- the stream opened and ran. Whether the device is delivering
    // anything is a different question, and the log now answers it instead of implying it.
    let measured = peak.load(std::sync::atomic::Ordering::Relaxed) as f32 / 1_000_000.0;
    if measured > 0.0 {
        info!(
            "[trigger_audio_permission] Stream played successfully - permission granted, peak {:.6}",
            measured
        );
    } else {
        warn!(
            "[trigger_audio_permission] Permission granted, but the device delivered digital \
             silence for 500 ms (peak 0.0). The microphone may be muted, unplugged, or routed \
             elsewhere -- a recording started now would capture nothing."
        );
    }

    // Stop the stream
    drop(stream);

    Ok(true)
}
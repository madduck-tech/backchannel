use anyhow::{anyhow, Result};
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::AtomicU64;

lazy_static! {
    pub static ref LAST_AUDIO_CAPTURE: AtomicU64 = AtomicU64::new(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );
}

#[derive(Clone, Debug, PartialEq)]
pub enum AudioTranscriptionEngine {
    Deepgram,
    WhisperTiny,
    WhisperDistilLargeV3,
    WhisperLargeV3Turbo,
    WhisperLargeV3,
}

impl fmt::Display for AudioTranscriptionEngine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AudioTranscriptionEngine::Deepgram => write!(f, "Deepgram"),
            AudioTranscriptionEngine::WhisperTiny => write!(f, "WhisperTiny"),
            AudioTranscriptionEngine::WhisperDistilLargeV3 => write!(f, "WhisperLarge"),
            AudioTranscriptionEngine::WhisperLargeV3Turbo => write!(f, "WhisperLargeV3Turbo"),
            AudioTranscriptionEngine::WhisperLargeV3 => write!(f, "WhisperLargeV3"),
        }
    }
}

impl Default for AudioTranscriptionEngine {
    fn default() -> Self {
        AudioTranscriptionEngine::WhisperLargeV3Turbo
    }
}

#[derive(Clone, Debug)]
pub struct DeviceControl {
    pub is_running: bool,
    pub is_paused: bool,
}

#[derive(Clone, Eq, PartialEq, Hash, Serialize, Debug, Deserialize)]
pub enum DeviceType {
    Input,
    Output,
}

#[derive(Clone, Eq, PartialEq, Hash, Serialize, Debug)]
pub struct AudioDevice {
    pub name: String,
    pub device_type: DeviceType,
}

impl AudioDevice {
    pub fn new(name: String, device_type: DeviceType) -> Self {
        AudioDevice { name, device_type }
    }

    pub fn from_name(name: &str) -> Result<Self> {
        if name.trim().is_empty() {
            return Err(anyhow!("Device name cannot be empty"));
        }

        let (name, device_type) = if name.to_lowercase().ends_with("(input)") {
            (
                name.trim_end_matches("(input)").trim().to_string(),
                DeviceType::Input,
            )
        } else if name.to_lowercase().ends_with("(output)") {
            (
                name.trim_end_matches("(output)").trim().to_string(),
                DeviceType::Output,
            )
        } else {
            return Err(anyhow!(
                "Device type (input/output) not specified in the name"
            ));
        };

        Ok(AudioDevice::new(name, device_type))
    }
}

impl fmt::Display for AudioDevice {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "{} ({})",
            self.name,
            match self.device_type {
                DeviceType::Input => "input",
                DeviceType::Output => "output",
            }
        )
    }
}

/// Parse audio device from string name
pub fn parse_audio_device(name: &str) -> Result<AudioDevice> {
    AudioDevice::from_name(name)
}

/// The device's human-readable name.
///
/// Replaces `DeviceTrait::name()`, removed in cpal 0.18. cpal's own suggested
/// replacement is `device.to_string()`, but its `Display` impl folds a failed
/// `description()` into `fmt::Error`, which makes `to_string()` panic on a
/// disconnected device. Devices get unplugged mid-meeting, so this keeps the
/// fallible signature the old `name()` had and every call site keeps handling it.
pub fn device_name(device: &cpal::Device) -> Result<String, cpal::Error> {
    use cpal::traits::DeviceTrait;
    device.description().map(|d| d.name().to_string())
}

/// Get device and config for audio operations
pub async fn get_device_and_config(
    audio_device: &AudioDevice,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig)> {
    #[cfg(target_os = "windows")]
    {
        return super::platform::get_windows_device(audio_device);
    }

    #[cfg(not(target_os = "windows"))]
    {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = super::host::audio_host();

        match audio_device.device_type {
            DeviceType::Input => {
                for device in host.input_devices()? {
                    if let Ok(name) = device_name(&device) {
                        if name == audio_device.name {
                            let default_config = device
                                .default_input_config()
                                .map_err(|e| anyhow!("Failed to get default input config: {}", e))?;
                            return Ok((device, default_config));
                        }
                    }
                }

                // The default input device does not round-trip through its own name on every
                // host. cpal's ALSA backend answers `default_input_device()` with a synthetic
                // device described "Default Audio Device", and `input_devices()` never yields
                // that description — it enumerates ALSA hints. So on Linux a recording started
                // with no stored preference used to die here with "Device not found" before any
                // audio was touched.
                //
                // Fall back to the device object itself, and *only* when the name we were asked
                // for is the default's own. A stale stored preference naming a device that has
                // gone away must keep erroring: silently recording a different microphone than
                // the one the user picked is worse than failing to start. Where the round-trip
                // already works (macOS, and any host whose default appears in its enumeration)
                // the loop above matches first and this is dead code.
                if let Some(default_device) = host.default_input_device() {
                    let is_default_by_name = device_name(&default_device)
                        .map(|name| name == audio_device.name)
                        .unwrap_or(false);
                    if is_default_by_name {
                        let default_config = default_device.default_input_config().map_err(|e| {
                            anyhow!("Failed to get default input config: {}", e)
                        })?;
                        log::info!(
                            "Default input device '{}' is not in the enumeration; using it directly",
                            audio_device.name
                        );
                        return Ok((default_device, default_config));
                    }
                }
            }
            DeviceType::Output => {
                #[cfg(target_os = "macos")]
                {
                    // Use default host for all macOS output devices
                    // Core Audio backend uses direct cidre API for system capture, not cpal
                    for device in host.output_devices()? {
                        if let Ok(name) = device_name(&device) {
                            if name == audio_device.name {
                                let default_config = device
                                    .default_output_config()
                                    .map_err(|e| anyhow!("Failed to get output config: {}", e))?;
                                return Ok((device, default_config));
                            }
                        }
                    }
                }

                #[cfg(target_os = "linux")]
                {
                    // System audio on Linux is a sink's monitor, and a monitor is a *source*:
                    // it is opened as an input stream, which is why this arm searches
                    // `input_devices()` while the device is typed as an Output.
                    //
                    // It used to open its own `host_from_id(HostId::Alsa)` regardless of which
                    // host enumerated the device, so a monitor listed by the PulseAudio host
                    // could never be found again here (#13). It now uses the same host as the
                    // enumeration.
                    for device in host.input_devices()? {
                        if let Ok(name) = device_name(&device) {
                            if name == audio_device.name {
                                let default_config = device
                                    .default_input_config()
                                    .map_err(|e| anyhow!("Failed to get default input config: {}", e))?;
                                return Ok((device, default_config));
                            }
                        }
                    }
                }
            }
        }

        Err(anyhow!("Device not found: {}", audio_device.name))
    }
}
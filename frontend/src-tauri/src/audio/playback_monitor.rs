// Audio playback device monitoring for Bluetooth detection
use serde::Serialize;
use anyhow::Result;

#[cfg(target_os = "macos")]
use log::debug;

#[derive(Debug, Clone, Serialize)]
pub struct AudioOutputInfo {
    pub device_name: String,
    pub is_bluetooth: bool,
    pub sample_rate: Option<u32>,
    pub device_type: String,
}


/// Whether a device name looks like a Bluetooth endpoint.
///
/// One list, taking the name as data (#60). There were **three**, at what were lines 52, 97 and
/// 136 — one per platform, with different keywords, so a Bose headset was Bluetooth on macOS and
/// not on Windows, and a `headset` was Bluetooth on Windows and not on Linux. Nothing compared
/// them and only one was ever compiled, so two of the three could not be wrong in any way a test
/// could notice. Same shape as ADR 0017's three copies of the template registry and #47's four
/// copies of the backend availability rule.
///
/// This is the **union** of the three, which changes behaviour on two platforms; every keyword
/// that only one list carried is named in #60 with what it now does elsewhere. It remains a
/// guess — deciding Bluetooth by substring is a heuristic, and a better answer asks the OS. What
/// changed is that the guess is singular and testable.
pub fn looks_bluetooth(device_name: &str) -> bool {
    const KEYWORDS: [&str; 13] = [
        // shared by all three lists
        "bluetooth",
        "wireless",
        "airpods",
        "wh-",
        // macOS only
        "beats",
        "bose",
        "jabra",
        "jbl",
        "anker",
        // Windows only
        "bt ",
        "headset",
        // Linux only (PulseAudio/PipeWire naming)
        "bluez",
        "a2dp",
    ];
    let name = device_name.to_lowercase();
    KEYWORDS.iter().any(|keyword| name.contains(keyword))
}

/// How a device name reads as a kind. Was written out identically under all three platforms.
pub fn describe_device_type(device_name: &str) -> String {
    let name = device_name.to_lowercase();
    // The macOS copy also knew "display", "airpod" and "earbud"; the other two did not, and
    // dropping them to unify would have been a silent regression on the one platform that had
    // them. Folded in instead, which is a change for Windows and Linux and is tested below.
    if name.contains("speaker") || name.contains("display") {
        "Speaker".to_string()
    } else if name.contains("headphone")
        || name.contains("headset")
        || name.contains("airpod")
        || name.contains("earbud")
    {
        "Headphones".to_string()
    } else {
        "Unknown".to_string()
    }
}

/// Get information about the current audio output device
pub async fn get_active_audio_output() -> Result<AudioOutputInfo> {
    #[cfg(target_os = "macos")]
    {
        get_macos_output().await
    }

    #[cfg(target_os = "windows")]
    {
        get_windows_output().await
    }

    #[cfg(target_os = "linux")]
    {
        get_linux_output().await
    }
}

#[cfg(target_os = "macos")]
async fn get_macos_output() -> Result<AudioOutputInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};

    // Get default output device using cpal
    let host = crate::audio::devices::host::audio_host();
    let device = host.default_output_device()
        .ok_or_else(|| anyhow::anyhow!("No default output device found"))?;

    let device_name = crate::audio::devices::device_name(&device).unwrap_or_else(|_| "Unknown".to_string());

    // Get sample rate
    let sample_rate = device.default_output_config()
        .ok()
        .map(|config| config.sample_rate());

    // Heuristic: Check if device name contains bluetooth-related keywords
    let is_bluetooth = looks_bluetooth(&device_name);

    let device_type = describe_device_type(&device_name);

    debug!("Active output device: {} (Bluetooth: {}, Type: {}, Rate: {:?} Hz)",
           device_name, is_bluetooth, device_type, sample_rate);

    Ok(AudioOutputInfo {
        device_name,
        is_bluetooth,
        sample_rate,
        device_type,
    })
}

#[cfg(target_os = "windows")]
async fn get_windows_output() -> Result<AudioOutputInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = crate::audio::devices::host::audio_host();
    let device = host.default_output_device()
        .ok_or_else(|| anyhow::anyhow!("No default output device found"))?;

    let device_name = crate::audio::devices::device_name(&device).unwrap_or_else(|_| "Unknown".to_string());

    let sample_rate = device.default_output_config()
        .ok()
        .map(|config| config.sample_rate());

    let is_bluetooth = looks_bluetooth(&device_name);

    let device_type = describe_device_type(&device_name);

    Ok(AudioOutputInfo {
        device_name,
        is_bluetooth,
        sample_rate,
        device_type,
    })
}

#[cfg(target_os = "linux")]
async fn get_linux_output() -> Result<AudioOutputInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = crate::audio::devices::host::audio_host();
    let device = host.default_output_device()
        .ok_or_else(|| anyhow::anyhow!("No default output device found"))?;

    let device_name = crate::audio::devices::device_name(&device).unwrap_or_else(|_| "Unknown".to_string());

    let sample_rate = device.default_output_config()
        .ok()
        .map(|config| config.sample_rate());

    let is_bluetooth = looks_bluetooth(&device_name);

    let device_type = describe_device_type(&device_name);

    Ok(AudioOutputInfo {
        device_name,
        is_bluetooth,
        sample_rate,
        device_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Names each platform's former list judged differently. Every one of these runs on every
    /// machine now; before, two of the three lists could not be wrong in any way a test could
    /// notice, because only one was ever compiled (#60).
    #[test]
    fn every_keyword_any_platform_knew_is_still_bluetooth() {
        for (name, whose) in [
            ("AirPods Pro", "all three"),
            ("Bluetooth Headphones", "all three"),
            ("Some Wireless Thing", "all three"),
            ("Sony WH-1000XM5", "all three"),
            ("Beats Studio", "macOS only"),
            ("Bose QuietComfort", "macOS only"),
            ("Jabra Evolve", "macOS only"),
            ("JBL Flip", "macOS only"),
            ("Anker Soundcore", "macOS only"),
            ("BT Speaker", "Windows only"),
            ("USB Headset", "Windows only"),
            ("bluez_output.AA_BB_CC", "Linux only"),
            ("a2dp-sink", "Linux only"),
        ] {
            assert!(
                looks_bluetooth(name),
                "{name:?} was Bluetooth to {whose} and must stay Bluetooth to everyone"
            );
        }
    }

    /// The other half, and the one a union quietly breaks: merging three lists can only make
    /// more things Bluetooth, so what needs holding is what must stay wired.
    #[test]
    fn a_wired_device_is_not_bluetooth() {
        for name in [
            "sof-hda-dsp Speaker + Headphones",
            "Built-in Output",
            "HDMI / DisplayPort 1 Output",
            "Digital Microphone",
            "",
        ] {
            assert!(!looks_bluetooth(name), "{name:?} is not a Bluetooth device");
        }
    }

    #[test]
    fn the_device_kind_keeps_every_platforms_keywords() {
        // macOS knew these three and the other two did not; folding them in is a change for
        // Windows and Linux, and this is where that change is stated.
        assert_eq!(describe_device_type("Studio Display"), "Speaker");
        assert_eq!(describe_device_type("AirPods Pro"), "Headphones");
        assert_eq!(describe_device_type("Galaxy Earbuds"), "Headphones");
        // and what all three already agreed on
        assert_eq!(describe_device_type("Built-in Speaker"), "Speaker");
        assert_eq!(describe_device_type("USB Headset"), "Headphones");
        assert_eq!(describe_device_type("Some Headphone"), "Headphones");
        assert_eq!(describe_device_type("Anonymous Device"), "Unknown");
    }

    /// Needs an audio output device, and now says so.
    ///
    /// It failed on the first Windows run this repository ever did (#46, PR #58): a hosted
    /// runner has no output device, `default_output_device()` returns `None`, and
    /// `get_active_audio_output` errors. Green on Linux forever because this laptop has
    /// speakers — a hardware test wearing no label, which is the class
    /// `ignored-tests-are-run.test.mjs` exists to make visible.
    ///
    /// It also asserted nothing: `is_ok()` then `println!`, which on a machine with a device
    /// cannot fail on either branch. Now it asserts the fields.
    #[tokio::test]
    #[ignore = "needs a real audio output device; run by gopnik.json stage 1"]
    async fn the_active_output_device_reports_usable_fields() {
        let info = get_active_audio_output()
            .await
            .expect("this machine has an audio output device");

        assert!(!info.device_name.trim().is_empty(), "the device reported no name");
        assert!(
            ["Speaker", "Headphones", "Unknown"].contains(&info.device_type.as_str()),
            "device_type was {:?}, which describe_device_type cannot produce",
            info.device_type
        );
        assert_eq!(
            info.is_bluetooth,
            looks_bluetooth(&info.device_name),
            "the reported Bluetooth flag disagrees with the shared classification for {:?}",
            info.device_name
        );
        if let Some(rate) = info.sample_rate {
            assert!(rate > 0, "a stated sample rate of 0 Hz");
        }
        eprintln!(
            "output: {:?} bluetooth={} type={} rate={:?}",
            info.device_name, info.is_bluetooth, info.device_type, info.sample_rate
        );
    }
}

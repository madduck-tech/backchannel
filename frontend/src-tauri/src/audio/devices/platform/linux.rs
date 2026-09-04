use anyhow::Result;
use cpal::traits::HostTrait;

use crate::audio::devices::configuration::{device_name, AudioDevice, DeviceType};
use crate::audio::devices::host::is_monitor;

/// Enumerate Linux audio devices: real inputs as microphones, sink monitors as system audio.
///
/// Both roles come from the same host and the same `input_devices()` call, because in the
/// PulseAudio model a sink's monitor *is* a source. What separates them is `is_monitor`,
/// which reads the device id rather than its display name.
///
/// Three things this function used to do, and why it no longer does them (#13):
///
/// * It opened its own `host_from_id(HostId::Alsa)` for the monitor pass, so it could not
///   see monitors even when the caller's host could.
/// * It filtered with `name.contains("monitor")` against the display description. That is
///   case-sensitive, and every PulseAudio description reads "Monitor of …", so the filter
///   matched nothing and the system-audio list was always empty.
/// * It advertised monitors as `"<name> (System Audio)"` while every lookup compared the
///   unsuffixed description, so a device picked in the UI could never be resolved again.
///   The suffix is gone: the role is already carried by `DeviceType`, and putting
///   presentation inside an identity string is what broke the round trip.
pub fn configure_linux_audio(host: &cpal::Host) -> Result<Vec<AudioDevice>> {
    let mut devices = Vec::new();

    for device in host.input_devices()? {
        let Ok(name) = device_name(&device) else {
            continue;
        };

        if is_monitor(&device) {
            // A monitor is an input as far as the audio API is concerned, but offering it
            // as a microphone would put four "Monitor of …" entries in the microphone
            // picker on this machine alone.
            devices.push(AudioDevice::new(name, DeviceType::Output));
        } else {
            devices.push(AudioDevice::new(name, DeviceType::Input));
        }
    }

    Ok(devices)
}

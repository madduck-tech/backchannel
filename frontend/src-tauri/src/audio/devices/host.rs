//! Which cpal host the Linux audio paths run on, decided once per process.
//!
//! `cpal::default_host()` prefers the PulseAudio host over ALSA when the feature is on
//! (`cpal::platform::default_host`), and that preference is what makes sink monitors and
//! distinct microphone names exist at all on a PipeWire machine (#13). Two things make
//! calling it directly the wrong move:
//!
//! * It caches nothing, and the application calls it at sixteen sites. On a healthy machine
//!   that is sixteen client connections; on a machine whose PulseAudio socket exists but
//!   whose server never answers, it is sixteen two-second stalls and sixteen leaked
//!   threads, because cpal's `Host::new` gives up on a timeout and cannot join the thread
//!   it started (`cpal/src/host/pulseaudio/mod.rs`, "no other option than to leak the
//!   thread").
//! * Its availability check only stats the socket file, so a hung server is offered and
//!   then fails. Falling back is correct, but paying for the discovery every time is not.
//!
//! So the decision is made once and remembered: probe, and if the preferred host cannot be
//! constructed, record ALSA and never try again in this process.

use std::sync::OnceLock;

use cpal::traits::DeviceTrait;

static HOST_ID: OnceLock<cpal::HostId> = OnceLock::new();

/// The host every device path in this crate should use.
///
/// Equivalent to `cpal::default_host()` on the first call; afterwards it reuses the host
/// that first call settled on, so a host that is advertised but unusable costs one timeout
/// per process rather than one per call site.
pub fn audio_host() -> cpal::Host {
    let id = *HOST_ID.get_or_init(|| {
        let host = cpal::default_host();
        let id = host.id();
        log::info!("Audio host selected for this process: {:?}", id);
        id
    });

    cpal::host_from_id(id).unwrap_or_else(|e| {
        // `host_from_id` can only fail if the host became unavailable after the probe.
        // ALSA is unconditional in cpal on Linux, so this cannot recurse into nothing.
        log::warn!("Audio host {:?} is no longer available ({}), falling back", id, e);
        cpal::default_host()
    })
}

/// Whether this device is a loopback of something being played, rather than a real input.
///
/// The identity used is the device **id**, not its display name. On the PulseAudio host the
/// id is the node name — `alsa_output.<card>.monitor` — while `description()` returns the
/// human string "Monitor of <sink>". Matching the description is what the previous code did
/// (`name.contains("monitor")`), and it matched nothing: `str::contains` is case-sensitive
/// and every PulseAudio description capitalises it. The id is also the part a user cannot
/// change, where the description follows the sink's name.
///
/// The description is still consulted as a fallback, case-insensitively, because the ALSA
/// host has no comparable id — an `.asoundrc` PCM is whatever it was written as, and the
/// repository's own Stage 2 harness writes one whose description carries "monitor".
pub fn is_monitor(device: &cpal::Device) -> bool {
    if let Ok(id) = device.id() {
        if id.id().to_ascii_lowercase().ends_with(".monitor") {
            return true;
        }
    }

    device
        .description()
        .map(|d| d.name().to_ascii_lowercase().contains("monitor"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host is decided once, not per call site.
    ///
    /// This is the guard on the bound stated in #13's oracle item 5. `default_host()`
    /// caches nothing and the application calls it at sixteen sites; against a PulseAudio
    /// socket that exists but never answers, each construction costs `INIT_TIMEOUT` (2 s in
    /// cpal 0.18.1) and leaks the thread it could not join. Sixteen of those is a
    /// half-minute stall and sixteen leaked threads; one is a bounded cost paid once.
    ///
    /// Asserting identity rather than elapsed time on purpose: a wall-clock assertion would
    /// be flaky on a loaded machine and would measure the test runner as much as the code.
    /// What has to hold is that every call site sees the same decision.
    #[test]
    fn audio_host_is_decided_once() {
        let first = audio_host().id();
        for _ in 0..16 {
            assert_eq!(
                audio_host().id(),
                first,
                "the host changed between call sites; the decision is not memoized"
            );
        }
    }
}

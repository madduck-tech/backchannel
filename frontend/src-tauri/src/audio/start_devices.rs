//! Which devices a recording start opens (#242).
//!
//! Resolved from the stored preferences at the moment of the start, on every route. The record
//! button, the sidebar, the tray and the call nudge all reach one command, and the frontend sends it
//! no devices: its copy of the preferences went stale whenever Settings changed a device, and the tray
//! and the nudge reload the window before they start, so they sent none at all. Until #242 the
//! devices the frontend did send never arrived either (snake_case keys to a camelCase command), so
//! every start already read the store; this keeps that, and makes it the only way.

use anyhow::Result;

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
}

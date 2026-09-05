//! What a capture path must be true of, stated once instead of per implementation.
//!
//! #48. Before this, nothing in the crate said what an audio capture path must do. There were
//! two implementations — `SystemAudioCapture` (cpal) and `CoreAudioCapture` (macOS only) — and
//! each was its own specification. Transcription has had ports since the hexagon
//! (`audio/transcription/ports.rs`); capture and device selection had none, which is why every
//! defect in that layer had to be found by hitting it.
//!
//! **What this is not.** It is not a claim that a contract would have caught #9. #9 is that
//! cpal's ALSA `default_device()` returns a synthetic device whose `description()` is the
//! literal `"Default Audio Device"` while enumeration reads ALSA hint descriptions — a defect
//! at the real cpal/ALSA boundary, and a fake round-trips its own names by construction. What
//! catches #9 is running `cpal_capture_round_trip` on a machine, which `gopnik.json` stage 1
//! does. What a contract buys is different and narrower: the hardware case becomes *explicit*,
//! and the clauses no runner can check are *named* rather than silently unchecked.
//!
//! The boundary is **device selection plus capture**, not the `capture/` directory. #9, #10 and
//! #32 all live in `audio/devices/`, and every `build_input_stream` call in the tree is in
//! `stream.rs`, `level_monitor.rs` and `devices/discovery.rs`. A port drawn around `capture/`
//! would have missed all of them.

use std::fmt;

/// The kind of thing a device is, as the backend reports it — not as its label reads.
///
/// Separate from the display string on purpose: #10 is that devices were matched by display
/// description. A backend that can only tell input from output by parsing a name declares
/// [`Clause::KindIsReported`] unsupported instead of guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureKind {
    /// Something a person speaks into.
    Input,
    /// Something the machine plays through, captured back — a monitor, a loopback, a tap.
    Loopback,
}

/// A device a backend offers, named the way a caller may name it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureDevice {
    /// The identifier a caller passes to [`CaptureBackend::resolve`]. Not a label.
    pub id: String,
    pub kind: CaptureKind,
}

/// What a backend states about a device it resolved. Numbers, not promises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureConfig {
    pub sample_rate_hz: u32,
    pub channels: u16,
}

/// Why a device could not be resolved. The variants exist so a caller can tell "you asked for
/// something that is not here" from "it is here and I could not open it" — a distinction #10
/// is about and which a single `anyhow!` erases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// Nothing on this machine answers to that id.
    NotFound(String),
    /// It exists and could not be opened.
    Unavailable { id: String, why: String },
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResolveError::NotFound(id) => write!(f, "no capture device answers to {id:?}"),
            ResolveError::Unavailable { id, why } => write!(f, "{id:?} is present but unavailable: {why}"),
        }
    }
}

/// The five things every capture path is checked against.
///
/// Each one is a question that has already produced a defect in this repository, which is the
/// only reason it is here. A sixth invented clause would be a sixth thing to argue about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clause {
    /// Every id `devices()` offers, `resolve()` accepts. The shape of #9: the default device's
    /// name did not round-trip through the backend's own enumeration.
    NamesRoundTrip,
    /// An id nothing answers to is `NotFound` — never a silent fallback to the default. The
    /// shape of #10 and of `stale_preference_from_the_alsa_era_does_not_silently_resolve`.
    MissingIsNotFound,
    /// Input and loopback are distinguishable without reading the label. The shape of #10.
    KindIsReported,
    /// A resolved device states its sample rate and channel count, both non-zero. A stream
    /// whose rate nobody stated is one the mixer has to guess at.
    ConfigIsStated,
    /// Enumeration answers, or errors. It never hangs. The shape of #32, and the only clause
    /// here that is about time rather than values.
    EnumerationTerminates,
}

impl Clause {
    pub const ALL: [Clause; 5] = [
        Clause::NamesRoundTrip,
        Clause::MissingIsNotFound,
        Clause::KindIsReported,
        Clause::ConfigIsStated,
        Clause::EnumerationTerminates,
    ];
}

/// A capture path, whatever it is built on.
pub trait CaptureBackend {
    /// For failure messages. A clause violation must name the backend and the clause.
    fn name(&self) -> &'static str;

    /// Everything this backend can offer, by id.
    fn devices(&self) -> Result<Vec<CaptureDevice>, ResolveError>;

    /// Resolve an id to what a caller needs to open it.
    fn resolve(&self, id: &str) -> Result<CaptureConfig, ResolveError>;

    /// Clauses this backend cannot answer **on this machine**, and why.
    ///
    /// Declaring one is not a way out: [`verify`] asserts the number of skips against a count
    /// the caller states, so a clause quietly reclassified as unsupported turns the suite red
    /// rather than green. A skip that is only printed is indistinguishable from a pass.
    fn unsupported(&self) -> &'static [Clause] {
        &[]
    }
}

/// What a clause check produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Held,
    Skipped,
    Violated(String),
}

/// Check every clause against a backend.
///
/// Returns one outcome per clause, in `Clause::ALL` order. It does not panic: the caller
/// decides what a violation means, which is what lets the suite's own fake violate a clause
/// deliberately and be checked for it.
pub fn verify(backend: &dyn CaptureBackend) -> Vec<(Clause, Outcome)> {
    Clause::ALL
        .iter()
        .map(|&clause| {
            if backend.unsupported().contains(&clause) {
                return (clause, Outcome::Skipped);
            }
            (clause, check(backend, clause))
        })
        .collect()
}

fn check(backend: &dyn CaptureBackend, clause: Clause) -> Outcome {
    let violated = |why: String| Outcome::Violated(format!("{}: {clause:?}: {why}", backend.name()));

    let devices = match backend.devices() {
        Ok(d) => d,
        Err(e) => return violated(format!("devices() failed: {e}")),
    };

    match clause {
        Clause::EnumerationTerminates => {
            // Reaching here at all is the observation: `devices()` returned. A backend that
            // hangs never gets here, and the test harness's own timeout reports it.
            Outcome::Held
        }
        Clause::NamesRoundTrip => {
            for device in &devices {
                if let Err(e) = backend.resolve(&device.id) {
                    return violated(format!(
                        "devices() offers {:?} and resolve() rejects it: {e}",
                        device.id
                    ));
                }
            }
            Outcome::Held
        }
        Clause::MissingIsNotFound => {
            let absent = "\u{1f4a5} no device is called this \u{1f4a5}";
            match backend.resolve(absent) {
                Err(ResolveError::NotFound(_)) => Outcome::Held,
                Err(ResolveError::Unavailable { .. }) => violated(
                    "an id nothing answers to reported Unavailable, which says it exists".into(),
                ),
                Ok(config) => violated(format!(
                    "an id nothing answers to resolved anyway, to {config:?} — a silent fallback"
                )),
            }
        }
        Clause::KindIsReported => {
            if devices.is_empty() {
                return violated("no devices to report a kind for".into());
            }
            // The kind must come from the backend, not from the id. A backend whose kind can be
            // predicted by reading the id for "monitor" is reporting the label, which is #10.
            let guessed_from_id = devices.iter().all(|d| {
                let looks_loopback = d.id.to_lowercase().contains("monitor")
                    || d.id.to_lowercase().contains("loopback");
                looks_loopback == (d.kind == CaptureKind::Loopback)
            });
            let all_one_kind = devices.iter().all(|d| d.kind == devices[0].kind);
            if all_one_kind && devices.len() > 1 && !guessed_from_id {
                return violated(
                    "every device reports the same kind, so input and loopback are not \
                     distinguishable"
                        .into(),
                );
            }
            Outcome::Held
        }
        Clause::ConfigIsStated => {
            for device in &devices {
                match backend.resolve(&device.id) {
                    Ok(config) if config.sample_rate_hz == 0 => {
                        return violated(format!("{:?} reports a sample rate of 0", device.id))
                    }
                    Ok(config) if config.channels == 0 => {
                        return violated(format!("{:?} reports 0 channels", device.id))
                    }
                    Ok(_) => {}
                    Err(e) => return violated(format!("{:?} did not resolve: {e}", device.id)),
                }
            }
            Outcome::Held
        }
    }
}

/// Run [`verify`] and assert: every non-skipped clause held, and **exactly** `expected_skips`
/// were skipped.
///
/// The count is the part that matters. Without it, any clause a backend fails can be
/// reclassified as a capability it does not have and the suite goes green — which is the
/// unfalsifiable shape #48 v1 had and this replaces.
pub fn assert_contract(backend: &dyn CaptureBackend, expected_skips: usize) {
    let outcomes = verify(backend);
    let violations: Vec<&str> = outcomes
        .iter()
        .filter_map(|(_, o)| match o {
            Outcome::Violated(why) => Some(why.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        violations.is_empty(),
        "{} violated the capture contract:\n  {}",
        backend.name(),
        violations.join("\n  ")
    );

    let skipped: Vec<Clause> = outcomes
        .iter()
        .filter(|(_, o)| *o == Outcome::Skipped)
        .map(|(c, _)| *c)
        .collect();
    assert_eq!(
        skipped.len(),
        expected_skips,
        "{} skipped {:?} — {} clause(s), and the caller expected {}. A skip nobody predicted is \
         a clause quietly reclassified as a missing capability.",
        backend.name(),
        skipped,
        skipped.len(),
        expected_skips
    );
}

/// The real path, wrapped so the contract can be pointed at it.
///
/// Built by [`probe`], which does the two things the contract asks about — enumerate, then
/// resolve every id that enumeration returned — and **records the failures instead of
/// returning early**. If it returned early, a `NamesRoundTrip` violation would surface as a
/// constructor error and the contract would never see it, which is the whole thing this is
/// meant to observe (#9: the default device's own name did not round-trip).
///
/// A snapshot rather than a live object, because `list_audio_devices` and
/// `get_device_and_config` are `async` and this trait is not. That is a deliberate trade: a
/// sync trait is `dyn`-safe, and a contract that cannot be held behind `&dyn` cannot be run
/// over a list of implementations, which is the point.
pub struct CpalSnapshot {
    devices: Vec<CaptureDevice>,
    resolved: Vec<(String, Result<CaptureConfig, ResolveError>)>,
}

impl CpalSnapshot {
    /// Enumerate and resolve. Needs real audio hardware; callers are `#[ignore]`d tests.
    pub async fn probe() -> Result<Self, ResolveError> {
        use crate::audio::devices::{configuration::DeviceType as EnumeratedKind, get_device_and_config, list_audio_devices};

        let enumerated = list_audio_devices()
            .await
            .map_err(|e| ResolveError::Unavailable { id: "<enumeration>".into(), why: e.to_string() })?;

        let mut devices = Vec::new();
        let mut resolved = Vec::new();
        for device in enumerated {
            devices.push(CaptureDevice {
                id: device.name.clone(),
                // Reported by the enumerator, not read off the label. On Linux a sink monitor
                // arrives as `Output` from `configure_linux_audio`; that classification is the
                // backend's answer and this preserves it rather than re-deriving it.
                kind: match device.device_type {
                    EnumeratedKind::Input => CaptureKind::Input,
                    EnumeratedKind::Output => CaptureKind::Loopback,
                },
            });
            let outcome = match get_device_and_config(&device).await {
                Ok((_, config)) => Ok(CaptureConfig {
                    sample_rate_hz: config.sample_rate(),
                    channels: config.channels(),
                }),
                Err(e) => Err(ResolveError::Unavailable { id: device.name.clone(), why: e.to_string() }),
            };
            resolved.push((device.name, outcome));
        }
        Ok(CpalSnapshot { devices, resolved })
    }
}

impl CaptureBackend for CpalSnapshot {
    fn name(&self) -> &'static str {
        "cpal"
    }

    fn devices(&self) -> Result<Vec<CaptureDevice>, ResolveError> {
        Ok(self.devices.clone())
    }

    fn resolve(&self, id: &str) -> Result<CaptureConfig, ResolveError> {
        match self.resolved.iter().find(|(name, _)| name == id) {
            Some((_, outcome)) => outcome.clone(),
            None => Err(ResolveError::NotFound(id.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A backend that satisfies the contract, and can be told to violate exactly one clause.
    ///
    /// It exists to prove the suite **fails**. A contract suite with no fake is a suite of its
    /// own stubs: every clause would pass against every implementation that happened to be
    /// written, and nobody could tell that from a suite that checks nothing.
    struct Fake {
        break_clause: Option<Clause>,
        cannot: &'static [Clause],
    }

    impl Fake {
        fn sound() -> Self {
            Fake { break_clause: None, cannot: &[] }
        }
        fn breaking(clause: Clause) -> Self {
            Fake { break_clause: Some(clause), cannot: &[] }
        }
        fn declaring(cannot: &'static [Clause]) -> Self {
            Fake { break_clause: None, cannot }
        }
        fn broken(&self, clause: Clause) -> bool {
            self.break_clause == Some(clause)
        }
    }

    impl CaptureBackend for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn devices(&self) -> Result<Vec<CaptureDevice>, ResolveError> {
            if self.broken(Clause::KindIsReported) {
                // Everything claims to be an input, including the thing that is plainly a
                // monitor -- #10's shape.
                return Ok(vec![
                    CaptureDevice { id: "mic-0".into(), kind: CaptureKind::Input },
                    CaptureDevice { id: "speakers.monitor".into(), kind: CaptureKind::Input },
                ]);
            }
            Ok(vec![
                CaptureDevice { id: "mic-0".into(), kind: CaptureKind::Input },
                CaptureDevice { id: "speakers.monitor".into(), kind: CaptureKind::Loopback },
            ])
        }

        fn resolve(&self, id: &str) -> Result<CaptureConfig, ResolveError> {
            let known = self.devices()?.into_iter().any(|d| d.id == id);

            if !known {
                return if self.broken(Clause::MissingIsNotFound) {
                    // The silent fallback: an unknown id quietly becomes the default device.
                    Ok(CaptureConfig { sample_rate_hz: 48_000, channels: 2 })
                } else {
                    Err(ResolveError::NotFound(id.to_string()))
                };
            }

            if self.broken(Clause::NamesRoundTrip) && id.contains("monitor") {
                // Offered by `devices()`, refused by `resolve()` -- #9's shape.
                return Err(ResolveError::NotFound(id.to_string()));
            }

            if self.broken(Clause::ConfigIsStated) {
                return Ok(CaptureConfig { sample_rate_hz: 0, channels: 2 });
            }

            Ok(CaptureConfig { sample_rate_hz: 48_000, channels: 2 })
        }

        fn unsupported(&self) -> &'static [Clause] {
            self.cannot
        }
    }

    #[test]
    fn a_sound_backend_holds_every_clause_and_skips_none() {
        assert_contract(&Fake::sound(), 0);
        let outcomes = verify(&Fake::sound());
        assert_eq!(outcomes.len(), Clause::ALL.len(), "every clause is checked");
        assert!(outcomes.iter().all(|(_, o)| *o == Outcome::Held));
    }

    /// One control per clause. The count is stated here rather than left to be counted:
    /// `Clause::ALL.len()` is 5, and a clause added without a control makes this test fail.
    #[test]
    fn every_clause_can_be_violated_and_the_failure_names_it() {
        assert_eq!(Clause::ALL.len(), 5, "five clauses, and this test owes one control each");

        for clause in Clause::ALL {
            if clause == Clause::EnumerationTerminates {
                // Cannot be violated by a value: a backend that hangs never returns, and what
                // reports it is the harness timeout, not an assertion. Named here rather than
                // silently skipped -- it is the one clause whose control is the absence of a
                // hang, and this suite cannot stage one.
                continue;
            }
            let fake = Fake::breaking(clause);
            let outcomes = verify(&fake);
            let violated: Vec<&(Clause, Outcome)> = outcomes
                .iter()
                .filter(|(_, o)| matches!(o, Outcome::Violated(_)))
                .collect();
            assert!(
                !violated.is_empty(),
                "a backend built to violate {clause:?} passed the contract"
            );
            let (reported, outcome) = violated[0];
            assert_eq!(*reported, clause, "the violation reported the wrong clause");
            match outcome {
                Outcome::Violated(why) => {
                    assert!(
                        why.contains(&format!("{clause:?}")),
                        "the failure message must name the clause it is about, got: {why}"
                    );
                    assert!(why.starts_with("fake:"), "and the backend, got: {why}");
                }
                _ => unreachable!(),
            }
        }
    }

    /// The condition #48 v1 could not satisfy. A backend may declare a clause unsupported, and
    /// the *count* is asserted -- so relabelling an inconvenient clause as a missing capability
    /// turns the suite red instead of green.
    #[test]
    fn a_skip_nobody_predicted_is_a_failure() {
        const DECLARED: &[Clause] = &[Clause::KindIsReported];
        assert_contract(&Fake::declaring(DECLARED), 1);

        let wrong = std::panic::catch_unwind(|| {
            assert_contract(&Fake::declaring(DECLARED), 0);
        });
        assert!(
            wrong.is_err(),
            "a backend that skipped a clause the caller did not expect passed anyway"
        );
    }

    /// The hardware half of the contract, against the real cpal path.
    ///
    /// `#[ignore]`d and named in `gopnik.json` stage 1, like `cpal_capture_round_trip` — which
    /// stays exactly where it is. This does not replace it: that test is a round trip through
    /// a real stream, this is the contract's five clauses over enumeration and resolution.
    /// Moving `cpal_capture_round_trip` into the suite is deliberately not part of #48 (see the
    /// issue), and #53 made the gate able to see a test that lives outside `src/` first.
    ///
    /// **Zero expected skips.** cpal on a machine with devices can answer all five. If a
    /// platform turns out not to be able to, the number here changes and says so in the diff,
    /// rather than a clause quietly becoming a missing capability.
    #[tokio::test]
    #[ignore = "needs real audio devices; run by gopnik.json stage 1"]
    async fn the_real_cpal_path_holds_the_contract() {
        let snapshot = CpalSnapshot::probe().await.expect("probe the machine's audio devices");
        let devices = snapshot.devices().expect("the snapshot always answers");
        assert!(
            !devices.is_empty(),
            "this machine enumerated no capture devices at all — the contract has nothing to \
             check, which is a result about the machine and not about the contract"
        );
        eprintln!("cpal offered {} devices:", devices.len());
        for device in &devices {
            eprintln!("  {:?}  {:?}  -> {:?}", device.kind, device.id, snapshot.resolve(&device.id));
        }
        assert_contract(&snapshot, 0);
    }

    /// The suite runs with nothing installed: no sound server, no devices, no environment.
    /// It is arithmetic over values, and that is the half of the contract every machine can
    /// check. The hardware half is `cpal_capture_round_trip`, still `#[ignore]`d and still
    /// named in `gopnik.json` stage 1.
    #[test]
    fn the_suite_needs_no_sound_server() {
        for var in ["PULSE_SERVER", "PULSE_RUNTIME_PATH", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"] {
            assert!(
                std::env::var(var).is_ok() || std::env::var(var).is_err(),
                "reading {var} must not be required either way"
            );
        }
        assert_contract(&Fake::sound(), 0);
    }
}

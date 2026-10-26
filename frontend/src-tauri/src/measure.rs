//! Where the model-backed instruments find their inputs. Test-only. (#169)
//!
//! Every input has one stated location, and its absence fails the test rather than skipping it: an
//! instrument that returns early on a missing file reads as a pass in a gate log.
//!
//! - **Models** live in `BC_MEASURE_MODELS`, or `~/.cache/backchannel-measure-models` when it is unset,
//!   under their catalogue filenames.
//! - **Samples** come from the transcribe.cpp checkout at the revision `Cargo.lock` pins, so a sample
//!   cannot come from another engine's tree when two checkouts sit side by side.

use std::path::{Path, PathBuf};

/// The `transcribe-cpp` revision `Cargo.lock` pins, as its 40 hex digits.
pub fn pinned_engine_revision() -> String {
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    let text = std::fs::read_to_string(&lock).unwrap_or_else(|e| panic!("cannot read {}: {e}", lock.display()));
    let marker = "transcribe.cpp?rev=";
    let at = text.find(marker).unwrap_or_else(|| panic!("{} pins no transcribe.cpp revision", lock.display()));
    let rev: String = text[at + marker.len()..].chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    assert_eq!(rev.len(), 40, "the pinned revision is not 40 hex digits: {rev}");
    rev
}

/// The user's home directory: `HOME`, or `USERPROFILE` where Windows sets no `HOME` (windows-latest
/// does not, #209).
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .expect("HOME or USERPROFILE is set")
}

/// The transcribe.cpp checkout cargo made for `revision`. Cargo names a checkout by a prefix of its
/// revision (seven digits, more when seven are ambiguous), under `CARGO_HOME` when it is set, as cargo
/// itself reads it. Fails, naming the revision, when there is none.
pub fn checkout_of(revision: &str) -> PathBuf {
    let cargo_home = std::env::var_os("CARGO_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".cargo"));
    let checkouts = cargo_home.join("git").join("checkouts");
    let found = std::fs::read_dir(&checkouts)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", checkouts.display()))
        .filter_map(|d| d.ok())
        .filter(|d| d.file_name().to_string_lossy().starts_with("transcribe.cpp-"))
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().filter_map(|c| c.ok()))
        .find(|c| {
            let short = c.file_name().to_string_lossy().into_owned();
            short.len() >= 7 && revision.starts_with(&short) && c.path().is_dir()
        });
    found
        .map(|c| c.path())
        .unwrap_or_else(|| panic!("no transcribe.cpp checkout at {revision} under {}; run `cargo fetch`", checkouts.display()))
}

/// The checkout of the revision `Cargo.lock` pins.
pub fn pinned_checkout() -> PathBuf {
    checkout_of(&pinned_engine_revision())
}

/// `samples/<name>` in the checkout of the pinned revision.
pub fn pinned_sample(name: &str) -> PathBuf {
    let checkout = pinned_checkout();
    let path = checkout.join("samples").join(name);
    assert!(path.is_file(), "no samples/{name} in {}; run `cargo fetch`", checkout.display());
    path
}

/// A model file by its catalogue filename, from the stated directory.
pub fn measure_model(filename: &str) -> PathBuf {
    let dir = std::env::var("BC_MEASURE_MODELS").map(PathBuf::from).unwrap_or_else(|_| {
        home_dir().join(".cache").join("backchannel-measure-models")
    });
    let path = dir.join(filename);
    assert!(path.is_file(), "{} is not on disk; put the model there or set BC_MEASURE_MODELS", path.display());
    path
}

/// Minimal WAV reader for 16 kHz mono, as 16-bit PCM or 32-bit float: upstream's samples carry both
/// (`zh.wav` is float), and pulling a crate in for a measurement would be a dependency this repository
/// does not otherwise need. Any other shape fails, rather than being read as noise.
pub fn read_wav_mono_16k(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let mut float = None;
    let mut i = 12; // past "RIFF....WAVE"
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        if id == b"fmt " {
            let format = u16::from_le_bytes([bytes[i + 8], bytes[i + 9]]);
            let channels = u16::from_le_bytes([bytes[i + 10], bytes[i + 11]]);
            let rate = u32::from_le_bytes([bytes[i + 12], bytes[i + 13], bytes[i + 14], bytes[i + 15]]);
            let bits = u16::from_le_bytes([bytes[i + 22], bytes[i + 23]]);
            float = match (format, channels, rate, bits) {
                (1, 1, 16_000, 16) => Some(false),
                (3, 1, 16_000, 32) => Some(true),
                _ => panic!(
                    "{} is format {format}, {channels} ch, {rate} Hz, {bits} bit; the instruments read 16 kHz mono, 16-bit PCM or 32-bit float",
                    path.display()
                ),
            };
        }
        if id == b"data" {
            let data = &bytes[i + 8..(i + 8 + size).min(bytes.len())];
            return match float.unwrap_or_else(|| panic!("{} has no fmt chunk before its data", path.display())) {
                false => data.as_chunks::<2>().0.iter().map(|c| i16::from_le_bytes(*c) as f32 / 32768.0).collect(),
                true => data.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect(),
            };
        }
        i += 8 + size + (size & 1);
    }
    panic!("no data chunk in {}", path.display());
}

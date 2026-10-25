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

/// `samples/<name>` in the checkout of the pinned revision. Cargo names a checkout by the first seven
/// digits of its revision.
pub fn pinned_sample(name: &str) -> PathBuf {
    let short = &pinned_engine_revision()[..7];
    let home = std::env::var("HOME").expect("HOME is set");
    let checkouts = Path::new(&home).join(".cargo/git/checkouts");
    let found = std::fs::read_dir(&checkouts)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", checkouts.display()))
        .filter_map(|d| d.ok())
        .filter(|d| d.file_name().to_string_lossy().starts_with("transcribe.cpp-"))
        .map(|d| d.path().join(short).join("samples").join(name))
        .find(|p| p.is_file());
    found.unwrap_or_else(|| panic!("no samples/{name} in a transcribe.cpp checkout at {short}; run `cargo fetch`"))
}

/// A model file by its catalogue filename, from the stated directory.
pub fn measure_model(filename: &str) -> PathBuf {
    let dir = std::env::var("BC_MEASURE_MODELS").map(PathBuf::from).unwrap_or_else(|_| {
        Path::new(&std::env::var("HOME").expect("HOME is set")).join(".cache/backchannel-measure-models")
    });
    let path = dir.join(filename);
    assert!(path.is_file(), "{} is not on disk; put the model there or set BC_MEASURE_MODELS", path.display());
    path
}

/// Minimal 16-bit PCM WAV reader: the samples are 16 kHz mono, and pulling a crate in for a
/// measurement would be a dependency this repository does not otherwise need.
pub fn read_wav_mono_16k(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let mut i = 12; // past "RIFF....WAVE"
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        if id == b"fmt " {
            let channels = u16::from_le_bytes([bytes[i + 10], bytes[i + 11]]);
            let rate = u32::from_le_bytes([bytes[i + 12], bytes[i + 13], bytes[i + 14], bytes[i + 15]]);
            let bits = u16::from_le_bytes([bytes[i + 22], bytes[i + 23]]);
            assert!(
                channels == 1 && rate == 16_000 && bits == 16,
                "{} is {channels} ch, {rate} Hz, {bits} bit; the instruments read 16 kHz mono 16-bit",
                path.display()
            );
        }
        if id == b"data" {
            return bytes[i + 8..(i + 8 + size).min(bytes.len())]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
                .collect();
        }
        i += 8 + size + (size & 1);
    }
    panic!("no data chunk in {}", path.display());
}

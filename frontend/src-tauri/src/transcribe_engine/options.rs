//! The one place a transcribe.cpp model is loaded and a run's options are built. (#169)
//!
//! **Loads copy the weights.** From v0.4.1 the engine memory-maps a model file on the CPU and on
//! Metal, and a mapped file truncated or rewritten in place kills the process on its next access
//! (SIGBUS; `transcribe.h:1051-1073`). Since #195 a download writes a temporary file and renames it
//! over the final path, so it no longer rewrites a file in place; `no_mmap: true` still reads the file
//! as the pin before v0.4.1 did. Mapping itself is #253.
//!
//! **Runs take upstream's ITN default, with one exception.** v0.4.1 turned inverse text normalisation
//! on by default for sensevoice and fun-asr, so their transcripts gain capitals, punctuation and digits.
//! The product owner chose that on 2026-10-25 (#169), except for fun-asr with a Chinese hint: there
//! ITN made it write Traditional characters where it wrote Simplified without (measured on zh.wav), so
//! that one combination keeps ITN off. Both live in [`itn_for`]; the other families ignore the field.
//!
//! Nothing else may load a model or start a decode: `clippy.toml` forbids the loaders and
//! `Session::run`, `run_batch` and `stream` outside this module. So a `RunOptions` built anywhere else
//! has nothing to be given to, and every decode gets the same ITN setting. Clippy resolves a call by what it calls, so neither spelling, line
//! breaks nor an inferred `&Default::default()` gets past it. The first version held the options by a
//! text census, which those three shapes passed (#169's gate).

use std::path::Path;
use transcribe_cpp::{Backend, Diarize, Itn, Model, ModelOptions, RunOptions, Session, Stream, StreamOptions, Transcript};

/// The options every model is loaded with. `backend` is a parameter so an instrument can pin the CPU.
pub fn model_options(backend: Backend) -> ModelOptions {
    ModelOptions { backend, no_mmap: true, ..ModelOptions::default() }
}

/// Load a model with [`model_options`]. Blocking: GPU initialisation happens here.
#[allow(clippy::disallowed_methods)]
pub fn load_model(path: impl AsRef<Path>, backend: Backend) -> transcribe_cpp::Result<Model> {
    Model::load_with(path, &model_options(backend))
}

/// The ITN setting for a model architecture and a language hint.
fn itn_for(arch: &str, language: Option<&str>) -> Itn {
    // `funasr_nano` covers both fun-asr rows. With `zh` and ITN on, fun-asr-mlt-nano wrote
    // "開放時間早上九點至下午五點。"; with ITN off, "开放时间早上九点至下午五点。" (v0.4.1 and 553f109 alike).
    if arch == "funasr_nano" && language == Some("zh") {
        Itn::Off
    } else {
        Itn::Default
    }
}

/// The options every run and every stream is given, for the model `session` holds.
fn run_options(session: &Session, language: Option<String>, diarize: Diarize) -> RunOptions {
    let itn = itn_for(&session.model().arch(), language.as_deref());
    RunOptions { language, diarize, itn, ..RunOptions::default() }
}

/// Decode `pcm` whole, with [`run_options`].
#[allow(clippy::disallowed_methods)]
pub fn run(session: &mut Session, pcm: &[f32], language: Option<String>, diarize: Diarize) -> transcribe_cpp::Result<Transcript> {
    let options = run_options(session, language, diarize);
    session.run(pcm, &options)
}

/// Begin a stream with [`run_options`].
#[allow(clippy::disallowed_methods)]
pub fn stream<'s>(
    session: &'s mut Session,
    language: Option<String>,
    diarize: Diarize,
    options: &StreamOptions,
) -> transcribe_cpp::Result<Stream<'s>> {
    let run = run_options(session, language, diarize);
    session.stream(&run, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_loaded_without_mapping_its_file() {
        assert!(model_options(Backend::Auto).no_mmap, "a mapped model dies when its file is rewritten in place");
        assert!(model_options(Backend::Cpu).no_mmap);
        assert_eq!(model_options(Backend::Cpu).backend, Backend::Cpu, "the backend is the caller's");
    }

    /// The product owner's choice, 2026-10-25 (#169): upstream's ITN default everywhere, except
    /// fun-asr with a Chinese hint.
    #[test]
    fn itn_follows_upstream_except_fun_asr_in_chinese() {
        assert_eq!(itn_for("sensevoice", Some("zh")), Itn::Default);
        assert_eq!(itn_for("sensevoice", None), Itn::Default);
        assert_eq!(itn_for("funasr_nano", Some("en")), Itn::Default);
        assert_eq!(itn_for("funasr_nano", None), Itn::Default, "with no hint it writes Traditional either way");
        assert_eq!(itn_for("funasr_nano", Some("zh")), Itn::Off, "Simplified, as the hint asks");
        assert_eq!(itn_for("parakeet", Some("zh")), Itn::Default);
    }

    /// Every `source` line `lock` gives `crate_name`.
    fn lock_sources<'a>(lock: &'a str, crate_name: &str) -> Vec<&'a str> {
        lock.split("[[package]]")
            .filter(|p| p.lines().any(|l| l.trim() == format!("name = \"{crate_name}\"")))
            .filter_map(|p| p.lines().find(|l| l.trim_start().starts_with("source = ")))
            .collect()
    }

    const V0_4_1: &str = "rev=4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b";

    /// The engine is pinned once: `Cargo.lock` holds one `transcribe-cpp` and one `transcribe-cpp-sys`,
    /// both at v0.4.1. (#169)
    ///
    /// This cannot go red on its own lock. Cargo refuses a manifest whose three per-target
    /// declarations name different revisions ("has different source paths depending on the build
    /// target"), and a lock at an older revision does not compile this crate. So
    /// `lock_sources_sees_a_second_copy_and_a_wrong_revision` is the reader's red half.
    #[test]
    fn the_engine_is_pinned_once_at_v0_4_1() {
        let lock = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock")).expect("Cargo.lock");
        for crate_name in ["transcribe-cpp", "transcribe-cpp-sys"] {
            let sources = lock_sources(&lock, crate_name);
            assert_eq!(sources.len(), 1, "Cargo.lock holds {} copies of {crate_name}: {sources:?}", sources.len());
            assert!(sources[0].contains(V0_4_1), "{crate_name} is not at v0.4.1: {}", sources[0]);
        }
    }

    #[test]
    fn lock_sources_sees_a_second_copy_and_a_wrong_revision() {
        let two = "[[package]]\nname = \"transcribe-cpp\"\nsource = \"git+x?rev=553f1099a2b3a5bc4421894be171f09960fc0f3a#553f\"\n\n\
                   [[package]]\nname = \"transcribe-cpp\"\nsource = \"git+x?rev=4d7c1ccefd39e5a9ea36cca5f8fefc6dcc14b99b#4d7c\"\n";
        assert_eq!(lock_sources(two, "transcribe-cpp").len(), 2);
        assert!(!lock_sources(two, "transcribe-cpp")[0].contains(V0_4_1));
        assert!(lock_sources(two, "transcribe-cpp-sys").is_empty(), "a name is matched whole, not as a prefix");
    }
}

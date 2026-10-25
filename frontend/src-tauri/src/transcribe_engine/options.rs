//! The one place a transcribe.cpp model is loaded and a run's options are built. (#169)
//!
//! **Loads copy the weights.** From v0.4.1 the engine memory-maps a model file on the CPU and on
//! Metal, and a mapped file truncated or rewritten in place kills the process on its next access
//! (SIGBUS; `transcribe.h:1051-1073`). The download writes the final path with `File::create`, so a
//! "Download again" over the loaded model would do exactly that. `no_mmap: true` reads the file as
//! the pin before v0.4.1 did. Mapping, and the download it needs, are #195.
//!
//! **Runs keep ITN off.** v0.4.1 turned inverse text normalisation on by default for sensevoice and
//! fun-asr-mlt-nano, so their transcripts would gain capitals and punctuation. `Itn::Off` keeps the
//! text the pin produced; the other families ignore the field. Adopting upstream's default is a
//! visible change, decided separately.
//!
//! Nothing else may load a model or build a `RunOptions`: `clippy.toml` forbids the loaders outside
//! this module, and `no_run_options_outside_the_builder` forbids the literals.

use std::path::Path;
use transcribe_cpp::{Backend, Diarize, Itn, Model, ModelOptions, RunOptions};

/// The options every model is loaded with. `backend` is a parameter so an instrument can pin the CPU.
pub fn model_options(backend: Backend) -> ModelOptions {
    ModelOptions { backend, no_mmap: true, ..ModelOptions::default() }
}

/// Load a model with [`model_options`]. Blocking: GPU initialisation happens here.
#[allow(clippy::disallowed_methods)]
pub fn load_model(path: impl AsRef<Path>, backend: Backend) -> transcribe_cpp::Result<Model> {
    Model::load_with(path, &model_options(backend))
}

/// The options every run and every stream is given.
pub fn run_options(language: Option<String>, diarize: Diarize) -> RunOptions {
    RunOptions { language, diarize, itn: Itn::Off, ..RunOptions::default() }
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

    #[test]
    fn every_run_keeps_itn_off() {
        let o = run_options(Some("en".into()), Diarize::On);
        assert_eq!(o.itn, Itn::Off, "sensevoice and fun-asr-mlt-nano would gain capitals and punctuation");
        assert_eq!(o.language.as_deref(), Some("en"));
        assert_eq!(o.diarize, Diarize::On);
        assert_eq!(run_options(None, Diarize::Default).itn, Itn::Off);
    }

    /// A census: no `RunOptions` is built outside this module. Each pattern is one of the three
    /// shapes that build one with ITN at its default; comments are not code and are skipped.
    #[test]
    fn no_run_options_outside_the_builder() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let here = Path::new(file!()).file_name().unwrap().to_owned();
        let patterns = ["RunOptions {", "RunOptions::default()", ": RunOptions = Default::default()"];
        let mut found = Vec::new();
        let mut files = 0;
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") {
                    continue;
                }
                files += 1;
                if path.file_name() == Some(here.as_os_str()) && path.parent().is_some_and(|p| p.ends_with("transcribe_engine")) {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("a source file is readable");
                for (n, line) in text.lines().enumerate() {
                    let code = line.split("//").next().unwrap_or("");
                    if patterns.iter().any(|p| code.contains(p)) {
                        found.push(format!("{}:{}: {}", path.display(), n + 1, line.trim()));
                    }
                }
            }
        }
        // A positive sentinel: a census that read nothing finds nothing.
        assert!(files > 100, "the census read {files} files; it is not reading src/");
        assert!(found.is_empty(), "RunOptions built outside the builder, with ITN at its default:\n{}", found.join("\n"));
    }
}

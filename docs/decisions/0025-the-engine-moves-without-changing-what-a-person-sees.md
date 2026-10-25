# 0025 — transcribe.cpp 0.4.1 is adopted with the old pin's behaviour: weights copied, ITN off

Date: 2026-10-25
Status: accepted

## Context

#169 moves the engine from `553f109` (2026-08-03) to v0.4.1 (`4d7c1cce`, 2026-10-22). Two of upstream's changes alter what a person gets without any code here changing.

**Weights are memory-mapped on the CPU and on Metal** (`transcribe.h:1051-1073`). Our Linux AppImage is the CPU backend and macOS is Metal, so both map. A mapped file that is truncated or rewritten in place kills the process on its next access: SIGBUS, or EXCEPTION_IN_PAGE_ERROR on Windows, where the file also cannot be opened for writing until the model is freed. The download writes the final path with `File::create`, which truncates. Settings offers "Download again" on any row, the loaded one included, and readiness returns Ready without reloading. So a re-download over the loaded model is a crash path, read and not driven.

**Inverse text normalisation became the default for sensevoice and fun-asr-mlt-nano.** At `553f109` both resolve `Itn::Default` to off; at v0.4.1, to on. Their transcripts would gain capitals and punctuation. Measured on `553f109`: both decode `jfk.wav` as lowercase, unpunctuated text (`tests/fixtures/decode-*-553f109.json`).

## Decision

1. **Every model is loaded with `no_mmap: true`,** through `transcribe_engine::options::load_model`. The engine then reads a file as the old pin did, and a truncating download cannot crash a mapped model. `clippy.toml` forbids `Model::load`, `Model::load_with` and `transcribe_cpp::transcribe` elsewhere.
2. **Every run and every stream is given `Itn::Off`,** through `transcribe_engine::options::run_options`. A census test forbids building a `RunOptions` elsewhere. The other families ignore the field.

## Consequences

- Mapping, and the memory it saves, wait for #195. That issue owns a download that replaces a file without truncating it, and the replace-against-load race.
- Adopting upstream's ITN default is a visible change to two families' transcripts. It needs a decision of its own, by the product owner, and is not made by an engine bump.
- Both are held in one module, so either can be reversed in one place, and a reversal is visible in review.

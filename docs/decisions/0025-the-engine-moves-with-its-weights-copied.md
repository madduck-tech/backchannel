# 0025 — transcribe.cpp 0.4.1 is adopted with its weights copied, and with upstream's ITN default but one

Date: 2026-10-25
Status: accepted

## Context

#169 moves the engine from `553f109` (2026-08-03) to v0.4.1 (`4d7c1cce`, 2026-10-22). Two of upstream's changes alter what a person gets without any code here changing.

**Weights are memory-mapped on the CPU and on Metal** (`transcribe.h:1051-1073`). Our Linux AppImage is the CPU backend and macOS is Metal, so both map. A mapped file that is truncated or rewritten in place kills the process on its next access: SIGBUS, or EXCEPTION_IN_PAGE_ERROR on Windows, where the file also cannot be opened for writing until the model is freed. The download writes the final path with `File::create`, which truncates. Settings offers "Download again" on any row, the loaded one included, and readiness returns Ready without reloading. So a re-download over the loaded model is a crash path, read and not driven.

**Inverse text normalisation became the default for sensevoice and fun-asr-mlt-nano.** At `553f109` both resolve `Itn::Default` to off; at v0.4.1, to on. Their transcripts would gain capitals and punctuation. Measured on `553f109`: both decode `jfk.wav` as lowercase, unpunctuated text (`tests/fixtures/decode-*-553f109.json`).

## Decision

1. **Every model is loaded with `no_mmap: true`,** through `transcribe_engine::options::load_model`. The engine then reads a file as the old pin did, and a truncating download cannot crash a mapped model. `clippy.toml` forbids `Model::load`, `Model::load_with` and `transcribe_cpp::transcribe` elsewhere.
2. **Every run and every stream takes upstream's ITN default, except fun-asr with a Chinese hint,** set in `transcribe_engine::options::itn_for`.
   - So sensevoice and fun-asr gain capitals, punctuation and digits.
   - The exception exists because, with `zh`, ITN made fun-asr write Traditional characters where it wrote Simplified without ITN. Measured on `zh.wav`, on v0.4.1 and 553f109 alike.
   - The product owner chose both on 2026-10-25, over keeping the old pin's lowercase, unpunctuated text.
   - `clippy.toml` forbids `Session::run`, `run_batch` and `stream` outside that module, so every decode goes through `itn_for`. The other families ignore the field.

## Consequences

- Mapping, and the memory it saves, wait for #195. That issue owns a download that replaces a file without truncating it, and the replace-against-load race.
- Two families' transcripts change visibly with this move. They gain capitals, punctuation and digits. For sensevoice, ITN also changes the decode itself, not only how it is written. Upstream's card says it "changes the CTC decode", at about +0.11 percentage points of WER on LibriSpeech. Measured on `zh.wav`: "开饭时间…" with ITN off, "开放时间早上9点…" with it on. #169's verdict records what each wrote before and after.
- The catalogue's WER for these families was measured upstream with ITN off, so it no longer describes what the application runs. Regenerating the catalogue is #175.
- Both are held in one module, so either can be reversed in one place, and a reversal is visible in review.

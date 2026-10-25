//! The model-backed instruments for the engine move to v0.4.1. Test-only. (#169)
//!
//! Each needs gigabytes of models (`crate::measure`), so each is `#[ignore]`d and excused by its cost
//! in `ignored-tests-are-run.test.mjs`. Run by name, and its output is pasted into the gate's verdict.
//! They collect every failure before failing, so a control shows which check it turned red.

use super::engine::{scored_confidence, TranscribeEngine};
use super::options::{load_model, run_options};
use crate::audio::transcription::adapters::streaming::StreamingTranscriber;
use crate::audio::transcription::ports::{Channel, Transcriber};
use crate::audio::transcription::service::tests::FakeSink;
use crate::measure::{measure_model, pinned_sample, read_wav_mono_16k};
use transcribe_cpp::{Backend, Diarize, StreamOptions, Transcript};

/// What a decode's token rows say about its confidence (#162). Only five architectures build token
/// rows at all, and two of those leave `p` at the zero sentinel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PClass {
    /// No token rows.
    None,
    /// Token rows, every `p` exactly 0.0: nobody filled them in.
    Zero,
    /// At least one `p` above zero: a real probability.
    Real,
}

fn p_class(t: &Transcript) -> PClass {
    if t.tokens.is_empty() {
        PClass::None
    } else if t.tokens.iter().all(|k| k.p == 0.0) {
        PClass::Zero
    } else {
        PClass::Real
    }
}

/// What a row's output must satisfy.
#[derive(Debug, Clone, Copy)]
enum Rule {
    /// Every one of these words appears, case-folded, punctuation stripped.
    Words(&'static [&'static str]),
    /// At least `min` words, and at least 90% of letters Cyrillic.
    Cyrillic { min: usize },
    /// At least `min` Han characters.
    Han { min: usize },
}

const JFK: Rule = Rule::Words(&["americans", "ask", "country", "do", "you"]);

fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

fn check_rule(rule: Rule, text: &str) -> Result<(), String> {
    match rule {
        Rule::Words(want) => {
            let got = words(text);
            let missing: Vec<&str> = want.iter().copied().filter(|w| !got.iter().any(|g| g == w)).collect();
            if missing.is_empty() { Ok(()) } else { Err(format!("missing {missing:?}")) }
        }
        Rule::Cyrillic { min } => {
            let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
            let cyr = letters.iter().filter(|c| ('\u{0400}'..='\u{04FF}').contains(*c)).count();
            let n = words(text).len();
            if n >= min && !letters.is_empty() && cyr * 10 >= letters.len() * 9 { Ok(()) } else { Err(format!("{n} words, {cyr} of {} letters Cyrillic", letters.len())) }
        }
        Rule::Han { min } => {
            let han = text.chars().filter(|c| ('\u{4E00}'..='\u{9FFF}').contains(c)).count();
            if han >= min { Ok(()) } else { Err(format!("{han} Han characters")) }
        }
    }
}

/// The ITN-off signature (`transcribe.h:557-560`): no uppercase letter and no punctuation.
fn itn_off(text: &str) -> Result<(), String> {
    let bad: String = text
        .chars()
        .filter(|c| c.is_uppercase() || c.is_ascii_punctuation() || "。，、？！：；“”‘’（）《》…—·".contains(*c))
        .collect();
    if bad.is_empty() { Ok(()) } else { Err(format!("uppercase or punctuation found: {bad:?}")) }
}

/// Similarity of two token sequences: 1 - edit distance / the longer length. Words for a spaced
/// language, characters for one written without spaces.
fn similarity(a: &[String], b: &[String]) -> f64 {
    let (n, m) = (a.len(), b.len());
    if n.max(m) == 0 {
        return 1.0;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    for i in 1..=n {
        let mut cur = vec![i; m + 1];
        for j in 1..=m {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    1.0 - prev[m] as f64 / n.max(m) as f64
}

fn tokens_for(text: &str, han: bool) -> Vec<String> {
    if han {
        text.chars().filter(|c| !c.is_whitespace()).map(|c| c.to_string()).collect()
    } else {
        words(text)
    }
}

/// The words of a sensevoice or fun-asr-mlt-nano decode must match the `553f109` fixture this closely.
/// Not equality: ggml 0.20.2 → 0.26.0 moves float order, and a changed word for that reason must not
/// read as ITN, nor force the assertion to be relaxed to fit the change.
const ITN_WORDS_FLOOR: f64 = 0.9;

struct Row {
    name: &'static str,
    sample: &'static str,
    /// The language hint. `None` for the fixture rows, because the `553f109` fixtures were recorded with
    /// every option at its default, and a hint can change what a family writes: with `zh`,
    /// fun-asr-mlt-nano wrote simplified script and a closing `。` on `zh.wav` (measured 2026-10-25).
    language: Option<&'static str>,
    rule: Rule,
    p: PClass,
    /// A `553f109` fixture whose words this decode must match, for the two ITN families.
    fixture: Option<&'static str>,
}

const fn row(name: &'static str, sample: &'static str, language: &'static str, rule: Rule, p: PClass) -> Row {
    Row { name, sample, language: Some(language), rule, p, fixture: None }
}

/// A row compared with its `553f109` fixture, decoded with the language hint the fixture was recorded
/// with (the fixture states it; `None` for the first four).
const fn fixture_row(name: &'static str, sample: &'static str, language: Option<&'static str>, rule: Rule, p: PClass, fixture: &'static str) -> Row {
    Row { name, sample, language, rule, p, fixture: Some(fixture) }
}

/// One row per upstream family (16, by v0.4.1's `catalog/*.json`), the default, and one row per
/// repository whose bytes changed where the family's smallest row is not already it. The `p` class is
/// what the source says for the five token-building architectures (`engine.rs`, above
/// `scored_confidence`), and None for every other.
const ROWS: &[Row] = &[
    row("canary-180m-flash-q8", "jfk.wav", "en", JFK, PClass::None),
    row("canary-qwen-2.5b-q4", "jfk.wav", "en", JFK, PClass::None),
    row("cohere-transcribe-03-2026-q4", "jfk.wav", "en", JFK, PClass::None),
    fixture_row("fun-asr-mlt-nano-2512-q4", "jfk.wav", None, JFK, PClass::None, "decode-fun-jfk-553f109.json"),
    fixture_row("fun-asr-mlt-nano-2512-q4", "zh.wav", None, Rule::Han { min: 6 }, PClass::None, "decode-fun-zh-553f109.json"),
    fixture_row("fun-asr-mlt-nano-2512-q4", "jfk.wav", Some("en"), JFK, PClass::None, "decode-fun-jfk-en-553f109.json"),
    fixture_row("fun-asr-mlt-nano-2512-q4", "zh.wav", Some("zh"), Rule::Han { min: 6 }, PClass::None, "decode-fun-zh-zh-553f109.json"),
    row("gigaam-v3-ctc-q8", "ru-short.wav", "ru", Rule::Cyrillic { min: 5 }, PClass::Zero),
    row("granite-speech-4.1-2b-plus-q4", "jfk.wav", "en", JFK, PClass::None),
    row("granite-speech-4.1-2b-nar-q4", "jfk.wav", "en", JFK, PClass::None),
    row("moonshine-tiny-q8", "jfk.wav", "en", JFK, PClass::None),
    row("moonshine-streaming-tiny-q8", "jfk.wav", "en", JFK, PClass::Zero),
    row("moss-transcribe-diarize-q4", "jfk.wav", "en", JFK, PClass::None),
    row("parakeet-tdt_ctc-110m-q8", "jfk.wav", "en", JFK, PClass::Real),
    row("qwen3-asr-0.6b-q4", "jfk.wav", "en", JFK, PClass::None),
    // sensevoice builds token rows (`engine.rs`, above `scored_confidence`) and leaves every `p` at 0.0:
    // measured on v0.4.1, 2026-10-25, on both samples. So it scores nothing, as the #162 rule says.
    fixture_row("sensevoicesmall-q8", "jfk.wav", None, JFK, PClass::Zero, "decode-sensevoicesmall-jfk-553f109.json"),
    fixture_row("sensevoicesmall-q8", "zh.wav", None, Rule::Han { min: 6 }, PClass::Zero, "decode-sensevoicesmall-zh-553f109.json"),
    fixture_row("sensevoicesmall-q8", "jfk.wav", Some("en"), JFK, PClass::Zero, "decode-sensevoicesmall-jfk-en-553f109.json"),
    fixture_row("sensevoicesmall-q8", "zh.wav", Some("zh"), Rule::Han { min: 6 }, PClass::Zero, "decode-sensevoicesmall-zh-zh-553f109.json"),
    row("voxtral-mini-3b-2507-q4", "jfk.wav", "en", JFK, PClass::None),
    row("voxtral-mini-4b-realtime-2602-q4", "jfk.wav", "en", JFK, PClass::None),
    row("whisper-tiny-q8", "jfk.wav", "en", JFK, PClass::None),
    row("parakeet-tdt-0.6b-v3-q8", "jfk.wav", "en", JFK, PClass::Real),
    row("multitalker-parakeet-streaming-0.6b-v1-q4", "jfk.wav", "en", JFK, PClass::Real),
    row("whisper-large-v3-turbo-q4", "jfk.wav", "en", JFK, PClass::None),
];

/// The fixture's text, after checking it is a `553f109` fixture recorded with `language`.
fn fixture_text(file: &str, language: Option<&str>) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(file);
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("a fixture parses");
    assert_eq!(v["engine_revision"], "553f1099a2b3a5bc4421894be171f09960fc0f3a", "{file} is not a 553f109 fixture");
    assert_eq!(v["language"].as_str(), language, "{file} was recorded with another language hint");
    v["text"].as_str().expect("text").to_string()
}

/// One decode per family on the CPU, through `transcribe_batch`, against its output rule, its `p`
/// class, and, for the two ITN families, the ITN-off signature and the `553f109` words. (#169
/// condition 5)
#[test]
#[ignore = "needs about 16.7 GB of models by the catalogue's size_mb (crate::measure); run by name, output pasted into #169's verdict"]
fn every_family_decodes_on_the_pinned_engine() {
    let dir = measure_model("moonshine-tiny-Q8_0.gguf").parent().unwrap().to_path_buf();
    let rt = tokio::runtime::Runtime::new().expect("a runtime");
    let engine = TranscribeEngine::new_with_models_dir(Some(dir)).expect("an engine");
    let mut failures = Vec::new();
    let mut loaded: Option<&str> = None;
    for r in ROWS {
        let entry = crate::config::transcribe_model(r.name).unwrap_or_else(|| panic!("{} is not a catalogue row", r.name));
        measure_model(entry.filename);
        if loaded != Some(r.name) {
            if let Err(e) = rt.block_on(engine.load_model(r.name)) {
                failures.push(format!("{}: does not load: {e}", r.name));
                loaded = None;
                continue;
            }
            loaded = Some(r.name);
        }
        let audio = read_wav_mono_16k(&pinned_sample(r.sample));
        let started = std::time::Instant::now();
        let batch = match rt.block_on(engine.transcribe_batch(audio.clone(), r.language.map(str::to_string))) {
            Ok(b) => b,
            Err(e) => {
                failures.push(format!("{} on {}: transcribe_batch failed: {e}", r.name, r.sample));
                continue;
            }
        };
        let secs = started.elapsed().as_secs_f64();
        // The class needs the token rows, which `BatchResult` does not carry: the same loaded model,
        // the same options, through a session of its own.
        let transcript = rt.block_on(engine.open_session()).and_then(|mut s| {
            s.run(&audio, &run_options(r.language.map(str::to_string), Diarize::Default)).map_err(|e| anyhow::anyhow!("{e}"))
        });
        let class = transcript.as_ref().map(p_class);
        eprintln!(
            "{:44} {:14} {:6.1}s  p={:?} scored={:?}  {}",
            r.name,
            r.sample,
            secs,
            class.as_ref().ok(),
            transcript.as_ref().ok().map(scored_confidence),
            batch.text.trim()
        );
        if let Err(why) = check_rule(r.rule, &batch.text) {
            failures.push(format!("{} on {}: the output rule fails ({why}): {}", r.name, r.sample, batch.text.trim()));
        }
        match class {
            Ok(c) if c == r.p => {}
            Ok(c) => failures.push(format!("{} on {}: the p class is {c:?}, expected {:?}", r.name, r.sample, r.p)),
            Err(e) => failures.push(format!("{} on {}: the session decode failed: {e}", r.name, r.sample)),
        }
        if let Some(file) = r.fixture {
            let before = fixture_text(file, r.language);
            // The property holds where the pin's own output held it. With `zh`, fun-asr-mlt-nano closes
            // with `。` on `553f109` too, so there the words, which include it, are the check.
            if itn_off(&before).is_ok() {
                if let Err(why) = itn_off(&batch.text) {
                    failures.push(format!("{} on {}: ITN is on: {why}", r.name, r.sample));
                }
            }
            let han = r.sample.starts_with("zh");
            let sim = similarity(&tokens_for(&before, han), &tokens_for(&batch.text, han));
            eprintln!("    against {file}: similarity {sim:.3} (floor {ITN_WORDS_FLOOR})");
            if sim < ITN_WORDS_FLOOR {
                failures.push(format!("{} on {}: the words moved from {file}: similarity {sim:.3} under {ITN_WORDS_FLOOR}", r.name, r.sample));
            }
        }
    }
    assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
}

/// A streaming model through the real adapter, on a sample cut mid-word. (#169 condition 6)
#[test]
#[ignore = "needs 501 MB of models (crate::measure); run by name, output pasted into #169's verdict"]
fn a_stream_commits_append_only_and_finalize_emits_the_tail() {
    let mut failures = Vec::new();
    for name in ["nemotron-speech-streaming-en-0.6b-q4", "moonshine-streaming-tiny-q8"] {
        let entry = crate::config::transcribe_model(name).expect("a catalogue row");
        let model = load_model(measure_model(entry.filename), Backend::Cpu).expect("the model loads");
        let mut session = model.session().expect("a session");
        let mut audio = read_wav_mono_16k(&pinned_sample("jfk.wav"));
        // 7.3 s ends just after "can do for you", before the pause: nemotron holds that last phrase back
        // until finalize (measured 2026-10-25), so finalize has a tail to emit. It is not a cut inside a
        // word, which nothing here locates.
        audio.truncate((7.3 * 16_000.0) as usize);
        let stream = session
            .stream(&run_options(Some("en".to_string()), Diarize::Default), &StreamOptions::default())
            .expect("the stream begins");
        let mut transcriber = StreamingTranscriber::new(stream);
        let sink = FakeSink::default();
        let recorded = sink.0.clone();
        let mut sink = sink;
        let mut before_finish = 0;
        for chunk in audio.chunks(1600) {
            if let Err(e) = transcriber.feed(Channel::You, chunk, &mut sink) {
                failures.push(format!("{name}: a feed failed: {e}"));
            }
            before_finish = recorded.lock().unwrap().committed.len();
        }
        if let Err(e) = transcriber.finish(&mut sink) {
            failures.push(format!("{name}: finish failed: {e}"));
        }
        let log = recorded.lock().unwrap();
        let text = log.committed.join(" ");
        eprintln!("{name}: {} committed chunks ({} before finish): {text}", log.committed.len(), before_finish);
        if words(&text).is_empty() {
            failures.push(format!("{name}: nothing was committed"));
        }
        // Append-only: a chunk repeating text already committed is a rewrite reaching the sink.
        let all = words(&text);
        let mut seen_prefix_again = false;
        for (i, chunk) in log.committed.iter().enumerate().skip(1) {
            let w = words(chunk);
            let earlier = words(&log.committed[..i].join(" "));
            if !w.is_empty() && earlier.len() >= w.len() && earlier[..w.len()] == w[..] {
                seen_prefix_again = true;
            }
        }
        if seen_prefix_again {
            failures.push(format!("{name}: a committed chunk repeats the committed prefix: {all:?}"));
        }
        let no_tail = log.committed.len() <= before_finish;
        match (name, no_tail) {
            // #200, on 553f109 and on v0.4.1 alike: moonshine-streaming's commit stalls after its first
            // words and finalize commits nothing more. Held as known, so the day it emits a tail this
            // goes red and the expectation is removed with #200's fix.
            ("moonshine-streaming-tiny-q8", true) => eprintln!("{name}: no tail at finalize, known (#200)"),
            ("moonshine-streaming-tiny-q8", false) => failures.push(format!("{name}: finalize emitted a tail; #200 may be fixed, so remove its expectation here")),
            (_, true) => failures.push(format!("{name}: finalize emitted no tail ({before_finish} chunks before, {} after)", log.committed.len())),
            (_, false) => {}
        }
    }
    assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
}

/// The August export of each repository whose bytes changed, on v0.4.1: does it load, and what does
/// it decode. Any outcome is a result; the words are the positive sentinel. (#169 condition 9)
#[test]
#[ignore = "needs about 8 GB of August exports in the measure dir's august/ (crate::measure); run by name, output pasted into #169's verdict"]
fn what_the_august_exports_do_on_the_pinned_engine() {
    let dir = measure_model("moonshine-tiny-Q8_0.gguf").parent().unwrap().join("august");
    let audio = read_wav_mono_16k(&pinned_sample("jfk.wav"));
    let mut entries: Vec<_> = std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())).flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "gguf")).collect();
    entries.sort();
    assert!(!entries.is_empty(), "no August exports in {}", dir.display());
    for path in entries {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        match load_model(&path, Backend::Cpu) {
            Err(e) => eprintln!("{name}: does not load: {e}"),
            Ok(model) => {
                let out = model.session().map_err(|e| e.to_string()).and_then(|mut s| {
                    s.run(&audio, &run_options(Some("en".to_string()), Diarize::Default)).map_err(|e| e.to_string())
                });
                match out {
                    Ok(t) => eprintln!(
                        "{name}: loads; decodes {:?}{}",
                        t.text.trim(),
                        if t.text.contains("<unk>") { " (a literal <unk>)" } else { "" }
                    ),
                    Err(e) => eprintln!("{name}: loads; the decode fails: {e}"),
                }
            }
        }
    }
}

#[test]
fn the_instruments_own_rules_go_red_on_what_they_reject() {
    assert!(check_rule(JFK, "And so my fellow Americans, ask not what your country can do for you").is_ok());
    assert!(check_rule(JFK, "и так мои дорогие американцы").is_err());
    assert!(check_rule(Rule::Cyrillic { min: 3 }, "и так мои дорогие американцы").is_ok());
    assert!(check_rule(Rule::Cyrillic { min: 3 }, "ask not what").is_err());
    assert!(itn_off("and so my fellow americans").is_ok());
    assert!(itn_off("And so, my fellow Americans.").is_err());
    assert!(itn_off("開放時間早上九點至下午五點").is_ok());
    assert!(itn_off("開放時間早上9點至下午5點。").is_err());
    let a = tokens_for("ask not what your country", false);
    assert_eq!(similarity(&a, &a), 1.0);
    assert!(similarity(&a, &tokens_for("ask not what my country", false)) < 1.0);
}

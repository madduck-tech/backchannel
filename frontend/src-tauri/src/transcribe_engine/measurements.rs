//! The model-backed instruments for the engine move to v0.4.1. Test-only. (#169)
//!
//! Each needs gigabytes of models (`crate::measure`), so each is `#[ignore]`d and excused by its cost
//! in `ignored-tests-are-run.test.mjs`. Run by name, and its output is pasted into the gate's verdict.
//! They collect every failure before failing, so a control shows which check it turned red.

use super::engine::{scored_confidence, TranscribeEngine};
use super::options::{self, load_model};
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
        Rule::Han { min } => {
            let han = text.chars().filter(|c| ('\u{4E00}'..='\u{9FFF}').contains(c)).count();
            if han >= min { Ok(()) } else { Err(format!("{han} Han characters")) }
        }
    }
}

const CJK_PUNCTUATION: &str = "。，、？！：；“”‘’（）《》…—·";

/// The ITN-off signature (`transcribe.h:557-560`): no uppercase letter and no punctuation.
fn itn_off(text: &str) -> Result<(), String> {
    let bad: String = text
        .chars()
        .filter(|c| c.is_uppercase() || c.is_ascii_punctuation() || CJK_PUNCTUATION.contains(*c))
        .collect();
    if bad.is_empty() { Ok(()) } else { Err(format!("uppercase or punctuation found: {bad:?}")) }
}

/// The ITN-on signature: for a spaced language, an uppercase letter and punctuation; for Chinese, a
/// sentence mark or a digit. Measured on v0.4.1 with ITN at its default: sensevoice and fun-asr-mlt-nano
/// write "And so my fellow Americans …, ask … country." and close Chinese with `。`, sensevoice writing
/// "9点" for "九点".
fn itn_on(text: &str, han: bool) -> Result<(), String> {
    let ok = if han {
        text.contains('。') || text.chars().any(|c| c.is_ascii_digit())
    } else {
        text.chars().any(char::is_uppercase) && text.chars().any(|c| c.is_ascii_punctuation())
    };
    if ok { Ok(()) } else { Err(format!("no capitals and punctuation, or sentence mark or digit, in {text:?}")) }
}

/// What ITN changes, folded away, so the words before and after it can be compared: case,
/// punctuation, and, for Chinese, a single digit back to its numeral. A number ITN writes with more
/// than one digit is not folded, which these samples do not contain.
fn fold(text: &str, han: bool) -> String {
    const NUMERALS: [char; 10] = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    text.chars()
        .filter(|c| !(c.is_ascii_punctuation() || CJK_PUNCTUATION.contains(*c)))
        .map(|c| if han && c.is_ascii_digit() { NUMERALS[c as usize - '0' as usize] } else { c })
        .flat_map(char::to_lowercase)
        .collect()
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

/// The words of a sensevoice or fun-asr-mlt-nano decode, folded for what ITN changes, must match the
/// `553f109` fixture this closely. Not equality: ggml 0.20.2 → 0.26.0 moves float order, and a changed
/// word for that reason must not force the assertion to be relaxed to fit the change.
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

/// One row per upstream family (16, by v0.4.1's `catalog/*.json`), the default, one row per
/// repository whose bytes changed where the family's smallest row is not already it, and one row per
/// repository #175 added (granite_speech5_ctc is the seventeenth family). The `p` class is
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
    // Words, not a script check: gigaam is Russian-only and writes Cyrillic for any speech, English
    // included, so "mostly Cyrillic" passed with jfk.wav (#169's control C12).
    row("gigaam-v3-ctc-q8", "ru-short.wav", "ru", Rule::Words(&["добавил", "однако", "следует"]), PClass::Zero),
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
    // One row per repository #175's regeneration added (its condition 5), each on a sample in a
    // language the model advertises. The Arabic and German words are the ones whisper-large-v3-turbo,
    // another family, also wrote for the same sample (#175's verdict). granite_speech5_ctc's class was
    // measured with `what_a_family_puts_in_token_p` on jfk.wav: 22 finite rows, mean 0.987.
    row("breeze-asr-25-q4", "zh.wav", "zh", Rule::Han { min: 6 }, PClass::None),
    row("cohere-transcribe-arabic-07-2026-q4", "ar-short.wav", "ar", Rule::Words(&["النوم", "عملية", "الاستيقاظ", "فترة"]), PClass::None),
    row("granite-speech-5.0-470m-turboctc-q4", "jfk.wav", "en", JFK, PClass::Real),
    row("parakeet-primeline-q4", "fleurs-de.wav", "de", Rule::Words(&["griff", "wasser", "dinosaurier", "gewachsen"]), PClass::Real),
    row("parakeet-ultra-q4", "jfk.wav", "en", JFK, PClass::Real),
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
#[ignore = "needs about 20.5 GB of models by the catalogue's size_mb (crate::measure); run by name, output pasted into #169's and #175's verdicts"]
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
            options::run(&mut s, &audio, r.language.map(str::to_string), Diarize::Default).map_err(|e| anyhow::anyhow!("{e}"))
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
            let han = r.sample.starts_with("zh");
            // ITN is on (the product owner's choice, #169). Its signature is required where it has
            // something to change: where the pin's own output, with ITN off, carried none of it. With
            // `zh`, fun-asr-mlt-nano closed with `。` on 553f109 already, so there the words are the check.
            if itn_off(&before).is_ok() {
                if let Err(why) = itn_on(&batch.text, han) {
                    failures.push(format!("{} on {}: ITN is off: {why}", r.name, r.sample));
                }
            }
            let sim = similarity(&tokens_for(&fold(&before, han), han), &tokens_for(&fold(&batch.text, han), han));
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
    // moonshine_streaming is decoded in segments since #200 (its stream is capped and kept a meeting's
    // first seconds), so only the uncapped stream is driven here.
    for name in ["nemotron-speech-streaming-en-0.6b-q4"] {
        let entry = crate::config::transcribe_model(name).expect("a catalogue row");
        let model = load_model(measure_model(entry.filename), Backend::Cpu).expect("the model loads");
        let mut session = model.session().expect("a session");
        let mut audio = read_wav_mono_16k(&pinned_sample("jfk.wav"));
        // 7.3 s ends just after "can do for you", before the pause: nemotron holds that last phrase back
        // until finalize (measured 2026-10-25), so finalize has a tail to emit. It is not a cut inside a
        // word, which nothing here locates.
        audio.truncate((7.3 * 16_000.0) as usize);
        let stream = options::stream(&mut session, Some("en".to_string()), Diarize::Default, &StreamOptions::default())
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
        // Append-only: the first chunk's text appears once in all that was committed. A rewrite reaching
        // the sink re-sends the prefix, and the prefix begins with the first chunk. Compared as text,
        // not by words: a chunk may end inside a word ("Americ", then "ans"), which a word comparison
        // missed (#169's control C18).
        let joined: String = log.committed.concat();
        if let Some(first) = log.committed.first().filter(|f| f.trim().len() >= 3) {
            if joined.matches(first.as_str()).count() > 1 {
                failures.push(format!("{name}: the committed prefix was sent again: {:?}", log.committed));
            }
        }
        if log.committed.len() <= before_finish {
            failures.push(format!("{name}: finalize emitted no tail ({before_finish} chunks before, {} after)", log.committed.len()));
        }
    }
    assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
}

/// The August export of each repository whose bytes changed, on v0.4.1: each must load and decode
/// jfk.wav to its words. (#169 condition 9)
///
/// The first version printed what each did and asserted nothing, so a file that failed to load left
/// it green (#169's gate). Whether `<unk>` appears is printed, not asserted: it is observed, not
/// provoked.
#[test]
#[ignore = "needs about 8 GB of August exports in the measure dir's august/ (crate::measure); run by name, output pasted into #169's verdict"]
fn the_august_exports_load_and_decode_on_the_pinned_engine() {
    let dir = measure_model("moonshine-tiny-Q8_0.gguf").parent().unwrap().join("august");
    let audio = read_wav_mono_16k(&pinned_sample("jfk.wav"));
    let mut entries: Vec<_> = std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())).flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "gguf")).collect();
    entries.sort();
    assert!(!entries.is_empty(), "no August exports in {}", dir.display());
    let mut failures = Vec::new();
    for path in entries {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let model = match load_model(&path, Backend::Cpu) {
            Ok(m) => m,
            Err(e) => {
                failures.push(format!("{name}: does not load: {e}"));
                continue;
            }
        };
        let out = model.session().map_err(|e| e.to_string()).and_then(|mut s| {
            options::run(&mut s, &audio, Some("en".to_string()), Diarize::Default).map_err(|e| e.to_string())
        });
        match out {
            Ok(t) => {
                eprintln!("{name}: loads; decodes {:?}{}", t.text.trim(), if t.text.contains("<unk>") { " (a literal <unk>)" } else { "" });
                if let Err(why) = check_rule(JFK, &t.text) {
                    failures.push(format!("{name}: decodes, but not jfk.wav's words ({why}): {}", t.text.trim()));
                }
            }
            Err(e) => failures.push(format!("{name}: loads; the decode fails: {e}")),
        }
    }
    assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
}

#[test]
fn the_instruments_own_rules_go_red_on_what_they_reject() {
    assert!(check_rule(JFK, "And so my fellow Americans, ask not what your country can do for you").is_ok());
    assert!(check_rule(JFK, "и так мои дорогие американцы").is_err());
    let ru = Rule::Words(&["добавил", "однако"]);
    assert!(check_rule(ru, "он добавил, что их однако не следует").is_ok());
    assert!(check_rule(ru, "эн соу май фелоу американс").is_err(), "Cyrillic is not Russian");
    assert!(itn_off("and so my fellow americans").is_ok());
    assert!(itn_off("And so, my fellow Americans.").is_err());
    assert!(itn_off("開放時間早上九點至下午五點").is_ok());
    assert!(itn_off("開放時間早上9點至下午5點。").is_err());
    assert!(itn_on("And so, my fellow Americans.", false).is_ok());
    assert!(itn_on("and so my fellow americans", false).is_err());
    assert!(itn_on("开放时间早上9点至下午5点", true).is_ok());
    assert!(itn_on("开放时间早上九点至下午五点", true).is_err());
    assert_eq!(fold("开放时间早上9点至下午5点。", true), "开放时间早上九点至下午五点");
    assert_eq!(fold("And so, my fellow Americans.", false), "and so my fellow americans");
    let a = tokens_for("ask not what your country", false);
    assert_eq!(similarity(&a, &a), 1.0);
    assert!(similarity(&a, &tokens_for("ask not what my country", false)) < 1.0);
}

/// Records every committed chunk with its audio position.
#[derive(Default)]
struct TimedSink(Vec<(String, f64)>);

impl crate::audio::transcription::ports::TranscriptSink for TimedSink {
    fn committed(&mut self, chunk: crate::audio::transcription::ports::TranscriptChunk) {
        self.0.push((chunk.text, chunk.audio_start));
    }
    fn tentative(&mut self, _text: &str) {}
    fn warn(&mut self, message: &str) {
        eprintln!("warning: {message}");
    }
}

/// Feed `audio` in 100 ms chunks, then finish, returning each feed's wall time with the second it began.
fn feed_all(t: &mut dyn Transcriber, audio: &[f32], sink: &mut TimedSink) -> Vec<(f64, f64)> {
    let mut walls = Vec::new();
    for (i, chunk) in audio.chunks(1600).enumerate() {
        let started = std::time::Instant::now();
        if let Err(e) = t.feed(Channel::You, chunk, sink) {
            eprintln!("a feed failed: {e}");
        }
        walls.push((i as f64 * 0.1, started.elapsed().as_secs_f64()));
    }
    if let Err(e) = t.finish(sink) {
        eprintln!("finish failed: {e}");
    }
    walls
}

/// Words that occur only in dots-full.wav's last 20 s: measured with tiny through `options::run`, the
/// first 285 s in 30 s pieces against the last 20 s, and fixed before #200's work.
const TAIL_WORDS: [&str; 3] = ["destiny", "karma", "confidence"];

/// A moonshine_streaming row, through the adapter `live_path` picks for it, keeps the whole of a long
/// recording. (#200 condition 2)
///
/// One stream held at most 81.9 s, re-decoded everything on every feed, and committed only its first
/// words. Each check here was red on that path. Run on four cores (`taskset -c 0-3`), which the
/// real-time bound assumes. `BC_ROWS` (comma-separated) runs a subset; `BC_AUDIO_SECONDS` cuts the
/// sample, which the growth control on the stream path needs.
#[test]
#[ignore = "needs the moonshine_streaming models and minutes of CPU (crate::measure); run by name on four cores, output pasted into #200's verdict"]
fn a_capped_stream_keeps_the_whole_meeting() {
    use crate::audio::transcription::adapters::segmented::{Decoder, SegmentedTranscriber};
    use crate::audio::transcription::{live_path, LivePath};
    let mut audio = read_wav_mono_16k(&pinned_sample("dots-full.wav"));
    if let Ok(secs) = std::env::var("BC_AUDIO_SECONDS") {
        audio.truncate((secs.parse::<f64>().expect("seconds") * 16_000.0) as usize);
    }
    let len_s = audio.len() as f64 / 16_000.0;
    let rows: Vec<String> = std::env::var("BC_ROWS")
        .map(|v| v.split(',').map(|r| r.trim().to_string()).collect())
        .unwrap_or_else(|_| ["moonshine-streaming-tiny-q8", "moonshine-streaming-small-q8", "moonshine-streaming-medium-q8"].map(String::from).to_vec());
    let mut failures = Vec::new();

    // Routing's sentinel: an uncapped stream still streams.
    if let Ok(path) = std::panic::catch_unwind(|| measure_model(crate::config::transcribe_model("nemotron-speech-streaming-en-0.6b-q4").unwrap().filename)) {
        let caps = load_model(path, Backend::Cpu).ok().and_then(|m| m.capabilities().ok());
        if live_path(caps.as_ref()) != LivePath::Stream {
            failures.push("routing: nemotron's capabilities no longer select the stream path".to_string());
        }
    } else {
        failures.push("routing: nemotron is not in the measure directory, so the sentinel cannot be read".to_string());
    }

    for name in &rows {
        let entry = crate::config::transcribe_model(name).unwrap_or_else(|| panic!("{name} is not a catalogue row"));
        let model = load_model(measure_model(entry.filename), Backend::Cpu).expect("the model loads");
        let path = live_path(model.capabilities().ok().as_ref());
        if path != LivePath::Segmented {
            failures.push(format!("{name}: routing: the rule chose {path:?} for a capped stream"));
        }

        // The reference: the same model over consecutive pieces of at most 30 s.
        let mut reference = String::new();
        for piece in audio.chunks(30 * 16_000) {
            let mut s = model.session().expect("a session");
            reference.push_str(&options::run(&mut s, piece, Some("en".into()), Diarize::Default).map(|t| t.text).unwrap_or_default());
            reference.push(' ');
        }

        let mut sink = TimedSink::default();
        let walls = match path {
            LivePath::Segmented => {
                let session = model.session().expect("a session");
                let mut t = SegmentedTranscriber::new(Decoder::Local { session, language: Some("en".into()), diarize: Diarize::Default }).expect("the segmented adapter");
                feed_all(&mut t, &audio, &mut sink)
            }
            LivePath::Stream => {
                let mut session = model.session().expect("a session");
                let stream = options::stream(&mut session, Some("en".into()), Diarize::Default, &StreamOptions::default()).expect("a stream");
                let mut t = StreamingTranscriber::new(stream);
                feed_all(&mut t, &audio, &mut sink)
            }
        };
        let got: String = sink.0.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>().join(" ");
        let coverage = similarity(&tokens_for(&fold(&reference, false), false), &tokens_for(&fold(&got, false), false));
        let latest = sink.0.iter().map(|(_, at)| *at).fold(0.0, f64::max);
        let got_words = words(&got);
        let missing: Vec<&str> = TAIL_WORDS.iter().copied().filter(|w| !got_words.iter().any(|g| g == w)).collect();
        let window = |from: f64, to: f64| walls.iter().filter(|(at, _)| *at >= from && *at < to).map(|(_, w)| w).sum::<f64>();
        let (early, late) = (window(0.0, 30.0), window(50.0, 80.0));
        let total: f64 = walls.iter().map(|(_, w)| w).sum();
        eprintln!(
            "{name}: path {path:?}; {} rows; coverage {coverage:.3}; latest row at {latest:.1}s of {len_s:.1}s; tail words missing {missing:?}; feed wall 0-30s {early:.2}s, 50-80s {late:.2}s, total {total:.1}s ({:.2} x audio)",
            sink.0.len(), total / len_s
        );
        if coverage < 0.9 {
            failures.push(format!("{name}: coverage {coverage:.3} of the reference, under 0.9"));
        }
        if len_s > 100.0 && (latest < 0.9 * len_s || !missing.is_empty()) {
            failures.push(format!("{name}: the tail: latest row at {latest:.1}s of {len_s:.1}s, missing {missing:?}"));
        }
        if late > 2.0 * early.max(0.01) {
            failures.push(format!("{name}: growth: feeds in 50-80s cost {late:.2}s against {early:.2}s in 0-30s"));
        }
        if total > 0.5 * len_s {
            failures.push(format!("{name}: real time: {total:.1}s of feeding for {len_s:.1}s of audio, over 0.5x"));
        }
    }
    assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
}

/// For every catalogue row whose model is in the measure directory, the rule streams it exactly when
/// the catalogue says `streaming`. (#200's drift guard.) Batch rows are read too, so a family that
/// streams but is missing from the generator's `STREAMING` set goes red here as well. Its reach is
/// what the cache holds: 6 of the 13 natively streaming rows on 2026-10-25, without Nemotron 3.5 and
/// Parakeet Unified.
#[test]
#[ignore = "needs the models in the measure directory (crate::measure); run by name"]
fn the_catalogue_label_agrees_with_the_path_rule() {
    use crate::audio::transcription::{live_path, LivePath};
    let dir = measure_model("moonshine-tiny-Q8_0.gguf").parent().unwrap().to_path_buf();
    let (mut seen, mut streaming_seen) = (0, 0);
    let mut failures = Vec::new();
    for entry in crate::config::TRANSCRIBE_MODEL_CATALOG {
        let path = dir.join(entry.filename);
        if !path.is_file() {
            continue;
        }
        seen += 1;
        let caps = load_model(&path, Backend::Cpu).ok().and_then(|m| m.capabilities().ok());
        let native = caps.as_ref().is_some_and(|c| c.supports_streaming);
        streaming_seen += usize::from(native);
        let streams = live_path(caps.as_ref()) == LivePath::Stream;
        eprintln!(
            "{}: catalogue streaming {}, rule streams {streams}, supports_streaming {native}, max_audio_ms {:?}",
            entry.name, entry.streaming, caps.as_ref().map(|c| c.max_audio_ms)
        );
        if caps.is_none() {
            failures.push(format!("{}: its capabilities could not be read", entry.name));
        } else if streams != entry.streaming {
            failures.push(format!("{}: the catalogue says streaming {}, the rule says {streams}", entry.name, entry.streaming));
        }
    }
    eprintln!("{seen} catalogue rows read, {streaming_seen} of them natively streaming");
    assert!(streaming_seen > 0, "no streaming model in {}", dir.display());
    assert!(failures.is_empty(), "RED:\n{}", failures.join("\n"));
}

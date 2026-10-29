// A model download writes a temporary file and renames it over the final one, so a failed or
// cancelled re-download leaves the file that was there, and a replace never leaves a stale model in
// use (#195). Each test downloads from a local HTTP/1.1 stub on tokio's `TcpListener`, through an
// engine whose client reads no proxy from the environment.
use super::engine::*;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A small catalogue row. Its bytes do not matter here: the stub serves whatever a test gives it.
const ROW: &str = "moonshine-tiny-q8";

#[derive(Clone)]
enum Reply {
    Body(Vec<u8>),
    Status500,
    /// Headers that promise `claimed` bytes, then `sent`, then the connection closes.
    CloseMidBody { sent: Vec<u8>, claimed: usize },
    /// The body in `chunk`-byte writes, `delay` apart.
    Slow { body: Vec<u8>, chunk: usize, delay: Duration },
}

struct Stub {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    sent: Arc<AtomicUsize>,
}

async fn stub(reply: Reply) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::new(AtomicUsize::new(0));
    let (requests_in, sent_in) = (requests.clone(), sent.clone());
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let (reply, requests, sent) = (reply.clone(), requests_in.clone(), sent_in.clone());
            tokio::spawn(async move {
                let (mut buf, mut got) = (vec![0u8; 8192], Vec::new());
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => got.extend_from_slice(&buf[..n]),
                    }
                }
                requests.lock().unwrap().push(String::from_utf8_lossy(&got).lines().next().unwrap_or("").to_string());
                let head = |len: usize| format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n");
                match reply {
                    Reply::Body(body) => {
                        let _ = sock.write_all(head(body.len()).as_bytes()).await;
                        let _ = sock.write_all(&body).await;
                        sent.fetch_add(body.len(), Ordering::SeqCst);
                    }
                    Reply::Status500 => {
                        let _ = sock.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    }
                    Reply::CloseMidBody { sent: part, claimed } => {
                        let _ = sock.write_all(head(claimed).as_bytes()).await;
                        let _ = sock.write_all(&part).await;
                        sent.fetch_add(part.len(), Ordering::SeqCst);
                    }
                    Reply::Slow { body, chunk, delay } => {
                        let _ = sock.write_all(head(body.len()).as_bytes()).await;
                        for c in body.chunks(chunk) {
                            if sock.write_all(c).await.is_err() || sock.flush().await.is_err() {
                                return;
                            }
                            sent.fetch_add(c.len(), Ordering::SeqCst);
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
                let _ = sock.shutdown().await;
            });
        }
    });
    Stub { base, requests, sent }
}

fn engine_at(dir: &Path, stub: &Stub) -> Arc<TranscribeEngine> {
    Arc::new(TranscribeEngine::new_with_models_dir(Some(dir.to_path_buf())).unwrap().with_base_url(&stub.base))
}

fn final_path(dir: &Path) -> std::path::PathBuf {
    dir.join(crate::config::transcribe_model(ROW).unwrap().filename)
}

/// What a file holds, compared whole: the originals here are a few kilobytes.
fn bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

/// Names of the temporary files left at the top of `dir`.
fn partials(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(PARTIAL_PREFIX))
        .collect()
}

fn original(dir: &Path) -> std::path::PathBuf {
    let p = final_path(dir);
    std::fs::write(&p, vec![7u8; 4096]).unwrap();
    p
}

/// Condition 1, on every platform: a completed re-download puts the stub's bytes at the path.
#[tokio::test]
async fn a_completed_redownload_replaces_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = original(dir.path());
    let fresh = vec![9u8; 10_000];
    let s = stub(Reply::Body(fresh.clone())).await;
    engine_at(dir.path(), &s).download_model(ROW, None).await.expect("the download succeeds");
    assert_eq!(std::fs::read(&path).unwrap(), fresh, "the path does not hold the downloaded bytes");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "a temporary file is left after a success");
}

/// Condition 1: a handle held on the original still reads the original, so the file was replaced,
/// not rewritten in place. A held handle on Windows is #253's.
#[cfg(unix)]
#[tokio::test]
async fn a_redownload_leaves_a_held_handle_reading_the_original() {
    use std::io::Read;
    let dir = tempfile::tempdir().unwrap();
    let path = original(dir.path());
    let mut held = std::fs::File::open(&path).unwrap();
    let s = stub(Reply::Body(vec![9u8; 10_000])).await;
    engine_at(dir.path(), &s).download_model(ROW, None).await.expect("the download succeeds");
    let mut through_handle = Vec::new();
    held.read_to_end(&mut through_handle).unwrap();
    assert_eq!(through_handle, vec![7u8; 4096], "the held handle reads other bytes: the original was rewritten in place");
}

/// Condition 2: a failure leaves the original, and the error is the failure's.
#[tokio::test]
async fn a_failed_redownload_leaves_the_original() {
    for (what, reply, error) in [
        ("a 500 before any body", Reply::Status500, "500"),
        ("a connection closed mid-body", Reply::CloseMidBody { sent: vec![1u8; 1000], claimed: 1_000_000 }, "chunk"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = original(dir.path());
        let before = bytes(&path);
        let s = stub(reply).await;
        let e = engine_at(dir.path(), &s).download_model(ROW, None).await.expect_err(what);
        assert!(e.to_string().contains(error), "{what}: the error is not the failure's: {e}");
        assert_eq!(s.requests.lock().unwrap().len(), 1, "{what}: the stub was not asked");
        assert!(path.exists(), "{what}: the file that was there is gone");
        assert_eq!(bytes(&path), before, "{what}: the file that was there changed");
        assert_eq!(partials(dir.path()), Vec::<String>::new(), "{what}: a temporary file is left");
    }
}

/// After a failed "Download again" on a damaged file, the row reads Damaged again, not Downloading
/// (#195's gate adversary: a cached Downloading held the row there until a restart).
#[tokio::test]
async fn a_failed_redownload_of_a_damaged_file_reads_damaged_again() {
    for reply in [Reply::Status500, Reply::CloseMidBody { sent: vec![1u8; 1000], claimed: 1_000_000 }] {
        let dir = tempfile::tempdir().unwrap();
        original(dir.path());
        let s = stub(reply).await;
        let engine = engine_at(dir.path(), &s);
        let row = |ms: Vec<ModelInfo>| ms.into_iter().find(|m| m.name == ROW).unwrap().status;
        assert!(matches!(row(engine.discover_models().await.unwrap()), ModelStatus::Corrupted { .. }), "the fixture is not damaged");
        engine.download_model(ROW, None).await.expect_err("the download fails");
        let after = row(engine.discover_models().await.unwrap());
        assert!(matches!(after, ModelStatus::Corrupted { .. }), "after a failed Download again the row reads {after:?}");
    }
}

/// "Completed" is said once the file is at its final path, not when its last byte arrives (#195's
/// gate adversary): first run enables Continue on it.
#[tokio::test]
async fn completed_is_reported_once_the_file_is_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Body(vec![9u8; 10_000])).await;
    let at_100 = Arc::new(Mutex::new(Vec::new()));
    let (seen, path) = (at_100.clone(), final_path(dir.path()));
    let cb: Box<dyn Fn(DownloadProgress) + Send> = Box::new(move |p| {
        if p.percent >= 100 {
            seen.lock().unwrap().push(path.exists());
        }
    });
    engine_at(dir.path(), &s).download_model(ROW, Some(cb)).await.unwrap();
    assert_eq!(*at_100.lock().unwrap(), vec![true], "a 100% event came while the final file was absent, or none came");
}

/// A cancel that arrives while the commit waits for the engine still cancels, and leaves the original.
#[tokio::test]
async fn a_cancel_while_the_commit_waits_still_cancels() {
    let dir = tempfile::tempdir().unwrap();
    let path = original(dir.path());
    let before = bytes(&path);
    let s = stub(Reply::Body(vec![9u8; 10_000])).await;
    let engine = engine_at(dir.path(), &s);
    let held = crate::audio::common::acquire_engine_lifecycle_lock().await;
    let running = tokio::spawn({ let e = engine.clone(); async move { e.download_model(ROW, None).await } });
    engine.test_hooks().before_commit.notified().await;
    engine.cancel_download(ROW).await.expect("the download is still in flight");
    drop(held);
    let e = running.await.unwrap().expect_err("the cancel was ignored");
    assert_eq!(e.to_string(), "Download cancelled by user");
    assert_eq!(bytes(&path), before, "the cancelled download replaced the file anyway");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "the cancel left a temporary file");
}

/// Condition 2, a fresh download: a failure leaves neither a final nor a temporary file.
#[tokio::test]
async fn a_failed_fresh_download_leaves_nothing() {
    for reply in [Reply::Status500, Reply::CloseMidBody { sent: vec![1u8; 1000], claimed: 1_000_000 }] {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(reply).await;
        assert!(engine_at(dir.path(), &s).download_model(ROW, None).await.is_err());
        assert!(!final_path(dir.path()).exists(), "a failed download left a file at the final path");
        assert_eq!(partials(dir.path()), Vec::<String>::new(), "a failed download left a temporary file");
    }
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

fn slow() -> Reply {
    Reply::Slow { body: vec![3u8; 200_000], chunk: 1000, delay: Duration::from_millis(20) }
}

/// Condition 3: a cancel after the first chunk leaves the original, with the cancel's error.
#[tokio::test]
async fn a_cancelled_redownload_leaves_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let path = original(dir.path());
    let before = bytes(&path);
    let s = stub(slow()).await;
    let engine = engine_at(dir.path(), &s);
    let running = tokio::spawn({ let e = engine.clone(); async move { e.download_model(ROW, None).await } });
    wait_until("the first chunk", || s.sent.load(Ordering::SeqCst) > 0).await;
    engine.cancel_download(ROW).await.expect("a download is in flight");
    let e = running.await.unwrap().expect_err("a cancelled download fails");
    assert_eq!(e.to_string(), "Download cancelled by user");
    assert_eq!(bytes(&path), before, "the cancel changed the file that was there");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "the cancel left a temporary file");
}

/// Condition 3, a fresh download: a cancel leaves neither file.
#[tokio::test]
async fn a_cancelled_fresh_download_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(slow()).await;
    let engine = engine_at(dir.path(), &s);
    let running = tokio::spawn({ let e = engine.clone(); async move { e.download_model(ROW, None).await } });
    wait_until("the first chunk", || s.sent.load(Ordering::SeqCst) > 0).await;
    engine.cancel_download(ROW).await.expect("a download is in flight");
    assert!(running.await.unwrap().is_err());
    assert!(!final_path(dir.path()).exists(), "a cancelled download left a file at the final path");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "a cancelled download left a temporary file");
}

/// Condition 5: the startup sweep removes a leftover temporary file and nothing else.
#[test]
fn the_sweep_removes_only_leftover_temporary_files() {
    let dir = tempfile::tempdir().unwrap();
    let keep = [
        crate::config::transcribe_model(ROW).unwrap().filename.to_string(),
        crate::config::SPEAKER_DIARIZER.filename.to_string(),
        "notes.txt".to_string(),
    ];
    for k in &keep {
        std::fs::write(dir.path().join(k), b"kept").unwrap();
    }
    std::fs::create_dir(dir.path().join("summary")).unwrap();
    std::fs::write(dir.path().join("summary").join(format!("{PARTIAL_PREFIX}gemma.gguf")), b"kept").unwrap();
    let leftover = format!("{PARTIAL_PREFIX}{}", keep[0]);
    std::fs::write(dir.path().join(&leftover), b"left by a crash").unwrap();
    assert_eq!(TranscribeEngine::sweep_partial_downloads(dir.path()), 1);
    assert!(!dir.path().join(&leftover).exists(), "the leftover temporary file survived the sweep");
    for k in &keep {
        assert!(dir.path().join(k).exists(), "the sweep removed {k}");
    }
    assert!(dir.path().join("summary").join(format!("{PARTIAL_PREFIX}gemma.gguf")).exists(), "the sweep reached into summary/");
}

/// Condition 5's census: no file the application keeps in `models/` looks like a temporary one.
#[test]
fn no_catalogue_or_diarizer_filename_matches_the_temporary_pattern() {
    let names: Vec<&str> = crate::config::TRANSCRIBE_MODEL_CATALOG
        .iter()
        .map(|e| e.filename)
        .chain([crate::config::SPEAKER_DIARIZER.filename])
        .filter(|f| f.starts_with(PARTIAL_PREFIX))
        .collect();
    assert_eq!(names, Vec::<&str>::new(), "these would be swept at startup");
}

/// Condition 6: mid-body, a fresh download and a re-download over a whole file both read Downloading.
#[tokio::test]
async fn a_download_in_flight_reads_downloading() {
    for (what, whole_file_first) in [("a fresh download", false), ("a re-download over a whole file", true)] {
        let dir = tempfile::tempdir().unwrap();
        if whole_file_first {
            let size_mb = crate::config::transcribe_model(ROW).unwrap().size_mb;
            std::fs::File::create(final_path(dir.path())).unwrap().set_len(size_mb as u64 * 1_000_000).unwrap();
        }
        let s = stub(slow()).await;
        let engine = engine_at(dir.path(), &s);
        let running = tokio::spawn({ let e = engine.clone(); async move { e.download_model(ROW, None).await } });
        wait_until("the stub to send bytes", || s.sent.load(Ordering::SeqCst) > 0).await;
        let status = engine.discover_models().await.unwrap().into_iter().find(|m| m.name == ROW).unwrap().status;
        assert!(matches!(status, ModelStatus::Downloading { .. }), "{what}: the row reads {status:?} mid-body");
        // Beside the final file, so the rename stays on one file system.
        let partial = dir.path().join(format!("{PARTIAL_PREFIX}{}", final_path(dir.path()).file_name().unwrap().to_string_lossy()));
        assert!(partial.is_file(), "{what}: no temporary file beside the final one mid-body");
        engine.cancel_download(ROW).await.unwrap();
        let _ = running.await;
    }
}

/// Condition 7's census: the four reads that skip a load, and first run's audio check, ask the engine
/// one question, and none decides by `get_current_model()`.
#[test]
fn the_reads_that_skip_a_load_ask_whether_the_model_is_usable() {
    let commands = include_str!("commands.rs");
    let import = include_str!("../audio/import.rs");
    let retranscription = include_str!("../audio/retranscription.rs");
    assert_eq!(commands.matches("engine.usable_model().await").count(), 2, "the pre-flight and the preload's re-check");
    assert!(commands.contains("Ok(engine()?.usable_model().await)"), "transcribe_get_current_model");
    for (file, text) in [("commands.rs", commands), ("import.rs", import), ("retranscription.rs", retranscription)] {
        assert!(!text.contains("get_current_model().await.as_deref() == Some("), "{file} decides by get_current_model()");
        assert!(!text.contains("if engine.is_model_loaded().await { engine.get_current_model()"), "{file} reads the slot itself");
    }
    for (file, text) in [("import.rs", import), ("retranscription.rs", retranscription)] {
        assert!(text.contains("engine.usable_model().await.as_deref() == Some(target_model.as_str())"), "{file}'s read");
    }
    // The sweep runs where the models directory is set, at startup, before any download can start.
    assert!(commands.contains("TranscribeEngine::purge_legacy_models(&models_dir);\n    // And what a download left when the application stopped mid-way (#195), before any can start.\n    TranscribeEngine::sweep_partial_downloads(&models_dir);"), "set_models_directory does not sweep");
}

/// Condition 7, with real models: the old file is whisper-tiny's, the new one moonshine-tiny's, under
/// one row's filename, and `arch()` tells which was installed.
mod replace_against_load {
    use super::*;

    const WHISPER: &str = "whisper-tiny-q8";

    async fn arch(engine: &TranscribeEngine) -> String {
        engine.open_session().await.expect("a model is loaded").model().arch()
    }

    /// The old file at the row's path, and a stub that serves the new one.
    async fn setup() -> (tempfile::TempDir, Stub, Arc<TranscribeEngine>) {
        let dir = tempfile::tempdir().unwrap();
        let row = crate::config::transcribe_model(WHISPER).unwrap();
        std::fs::copy(crate::measure::measure_model("whisper-tiny-Q8_0.gguf"), dir.path().join(row.filename)).unwrap();
        let new = std::fs::read(crate::measure::measure_model("moonshine-tiny-Q8_0.gguf")).unwrap();
        let s = stub(Reply::Body(new)).await;
        let engine = engine_at(dir.path(), &s);
        (dir, s, engine)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "needs whisper-tiny and moonshine-tiny on disk (crate::measure), and runs alone: it holds the process-wide device-check count; selected by name in gopnik.json stage 1"]
    async fn a_replace_against_a_load_and_a_job() {
        // Every failure is collected, so a control shows the assertion it is named for, not the first.
        let mut fails: Vec<String> = Vec::new();
        let mut check = |ok: bool, what: &str| if !ok { fails.push(what.to_string()) };

        // 7a: a replace while a load is paused between opening the old file and installing it.
        let (_dir, _s, engine) = setup().await;
        let hooks = engine.test_hooks();
        hooks.pause_loads.store(true, Ordering::SeqCst);
        let load = tokio::spawn({ let e = engine.clone(); async move { e.load_model(WHISPER).await } });
        hooks.load_paused.notified().await;
        hooks.pause_loads.store(false, Ordering::SeqCst);
        let download = tokio::spawn({ let e = engine.clone(); async move { e.download_model(WHISPER, None).await } });
        hooks.before_commit.notified().await;
        // Bounded: long enough for a commit that took no engine lock to finish its rename.
        tokio::time::sleep(Duration::from_millis(500)).await;
        eprintln!("7a: the commit {} while the load was paused", if download.is_finished() { "finished" } else { "waited" });
        hooks.release_load.notify_one();
        load.await.unwrap().expect("the load succeeds");
        download.await.unwrap().expect("the download succeeds");
        check(engine.usable_model().await.is_none(), "7a: the old file stays installed after a replace");
        engine.load_model(WHISPER).await.unwrap();
        check(arch(&engine).await == "moonshine", "7a: the next load does not read the new file");
        check(engine.usable_model().await.as_deref() == Some(WHISPER), "7a: a fresh load is not offered as usable");

        // 7b: a replace with the old model loaded and idle unloads it.
        let (_dir, _s, engine) = setup().await;
        engine.load_model(WHISPER).await.unwrap();
        check(arch(&engine).await == "whisper", "7b: the fixture's old model is not whisper");
        engine.download_model(WHISPER, None).await.unwrap();
        check(!engine.is_model_loaded().await, "7b: an idle replace leaves the old model loaded");

        // 7c: a replace while a job holds the engine leaves the job its model.
        let (_dir, _s, engine) = setup().await;
        engine.load_model(WHISPER).await.unwrap();
        let job = crate::audio::common::DeviceCheckHoldsEngine::take();
        engine.download_model(WHISPER, None).await.unwrap();
        check(engine.transcribe_batch(vec![0.0; 16_000], None).await.is_ok(), "7c: the job lost its model");
        if engine.is_model_loaded().await {
            check(arch(&engine).await == "whisper", "7c: the job's model changed under it");
        }

        // 7d: once the job is done, the slot is not offered again, and the next load reads the new file.
        drop(job);
        check(engine.usable_model().await.is_none(), "7d: the replaced model is offered again");
        let resolution = super::super::commands::resolve_with_engine(&engine, Some("local"), Some(WHISPER)).await.unwrap();
        check(!matches!(resolution, super::super::commands::Resolution::Ready(_)), "7d: the pre-flight answers Ready on the old weights");
        engine.load_model(WHISPER).await.unwrap();
        check(arch(&engine).await == "moonshine", "7d: the next load does not read the new file");
        check(engine.usable_model().await.as_deref() == Some(WHISPER), "7d: a fresh load is not offered as usable");

        assert!(fails.is_empty(), "condition 7 failed: {fails:#?}");
    }
}

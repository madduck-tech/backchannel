// A model download writes a temporary file and renames it over the final one, so a failed or
// cancelled re-download leaves the file that was there, and a replace never leaves a stale model in
// use (#195). It is fetched at its pinned revision and kept only if it is exactly its pin's length and
// hash (#179). Each test downloads from a local HTTP/1.1 stub on tokio's `TcpListener`, through an
// engine whose client reads no proxy from the environment.
use super::engine::*;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A small catalogue row. A test that must complete a download serves its own bytes through
/// `download_body`, with a pin made from them; one that fails before the body is whole uses
/// `download_model`, whose pin no stub here satisfies.
const ROW: &str = "moonshine-tiny-q8";

#[derive(Clone)]
enum Reply {
    Body(Vec<u8>),
    Status500,
    /// Headers that promise `claimed` bytes, then `sent`, then the connection closes.
    CloseMidBody { sent: Vec<u8>, claimed: usize },
    /// The body in `chunk`-byte writes, `delay` apart.
    Slow { body: Vec<u8>, chunk: usize, delay: Duration },
    /// `len` copies of `byte`, written without holding them all: the diarizer's 139 MB.
    Fill { byte: u8, len: usize },
    /// Reads the request and never answers, holding the connection open (#298).
    Silent,
    /// Headers that promise `claimed` bytes, then `sent`, then nothing, the connection held open (#298).
    GoesSilent { sent: Vec<u8>, claimed: usize },
    /// Waits, then gives the reply (#298).
    After(Duration, Box<Reply>),
    /// The n-th connection gets the n-th reply, and every later one the last (#298).
    Sequence(Vec<Reply>),
    /// Headers that promise `claimed` bytes, then `sent`, then a wait, then the connection closes; the
    /// instant of the close is recorded in `Stub::closed` just before it (#310).
    CloseAfter { sent: Vec<u8>, claimed: usize, wait: Duration },
}

struct Stub {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    sent: Arc<AtomicUsize>,
    /// Connections accepted, whether or not they ever sent a request: a TLS ClientHello never does.
    accepted: Arc<AtomicUsize>,
    /// When a `CloseAfter` reply closed its connection.
    closed: Arc<Mutex<Option<tokio::time::Instant>>>,
}

async fn stub(reply: Reply) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(Mutex::new(None));
    let (requests_in, sent_in, accepted_in, closed_in) = (requests.clone(), sent.clone(), accepted.clone(), closed.clone());
    tokio::spawn(async move {
        let mut connections = 0usize;
        while let Ok((mut sock, _)) = listener.accept().await {
            accepted_in.fetch_add(1, Ordering::SeqCst);
            let mut reply = reply.clone();
            if let Reply::Sequence(replies) = &reply {
                reply = replies[connections.min(replies.len() - 1)].clone();
            }
            connections += 1;
            let (requests, sent, closed) = (requests_in.clone(), sent_in.clone(), closed_in.clone());
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
                if let Reply::After(wait, then) = reply {
                    tokio::time::sleep(wait).await;
                    reply = *then;
                }
                match reply {
                    Reply::Silent => std::future::pending::<()>().await,
                    Reply::GoesSilent { sent: part, claimed } => {
                        let _ = sock.write_all(head(claimed).as_bytes()).await;
                        let _ = sock.write_all(&part).await;
                        let _ = sock.flush().await;
                        sent.fetch_add(part.len(), Ordering::SeqCst);
                        std::future::pending::<()>().await
                    }
                    Reply::After(..) | Reply::Sequence(_) => unreachable!("resolved above"),
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
                    Reply::CloseAfter { sent: part, claimed, wait } => {
                        let _ = sock.write_all(head(claimed).as_bytes()).await;
                        let _ = sock.write_all(&part).await;
                        let _ = sock.flush().await;
                        sent.fetch_add(part.len(), Ordering::SeqCst);
                        tokio::time::sleep(wait).await;
                        // Before the shutdown: on a runtime with more than one thread the engine could
                        // otherwise finish before the instant was written.
                        *closed.lock().unwrap() = Some(tokio::time::Instant::now());
                    }
                    Reply::Fill { byte, len } => {
                        let _ = sock.write_all(head(len).as_bytes()).await;
                        let block = vec![byte; 1 << 16];
                        let mut left = len;
                        while left > 0 {
                            let n = left.min(block.len());
                            if sock.write_all(&block[..n]).await.is_err() {
                                return;
                            }
                            sent.fetch_add(n, Ordering::SeqCst);
                            left -= n;
                        }
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
    Stub { base, requests, sent, accepted, closed }
}

fn engine_at(dir: &Path, stub: &Stub) -> Arc<TranscribeEngine> {
    Arc::new(TranscribeEngine::new_with_models_dir(Some(dir.to_path_buf())).unwrap().with_base_url(&stub.base))
}

fn sha256_of(body: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(body))
}

/// Download `row` through the engine's own path, with a pin that `body` satisfies: for a test whose
/// stub serves bytes other than the row's and whose claim needs the download to complete (#179). The
/// revision is the row's.
async fn download_body(
    engine: &TranscribeEngine,
    row: &str,
    body: &[u8],
    progress: Option<Box<dyn Fn(DownloadProgress) + Send>>,
) -> anyhow::Result<()> {
    let r = crate::config::transcribe_model(row).unwrap();
    let sha256 = sha256_of(body);
    let pin = FilePin { revision: r.revision, size_bytes: body.len() as u64, sha256: &sha256 };
    engine.download_file(row, r.hf_repo, r.filename, pin, progress).await
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
    download_body(&engine_at(dir.path(), &s), ROW, &fresh, None).await.expect("the download succeeds");
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
    download_body(&engine_at(dir.path(), &s), ROW, &[9u8; 10_000], None).await.expect("the download succeeds");
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
    download_body(&engine_at(dir.path(), &s), ROW, &[9u8; 10_000], Some(cb)).await.unwrap();
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
    let running = tokio::spawn({ let e = engine.clone(); async move { download_body(&e, ROW, &[9u8; 10_000], None).await } });
    engine.test_hooks().before_commit.notified().await;
    engine.cancel_download(ROW).await.expect("the download is still in flight");
    drop(held);
    let e = running.await.unwrap().expect_err("the cancel was ignored");
    assert_eq!(e.to_string(), "Download cancelled by user");
    assert_eq!(bytes(&path), before, "the cancelled download replaced the file anyway");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "the cancel left a temporary file");
}

/// A cancel ends a download whose commit is still waiting for the lifecycle lock, which a recording's
/// stop holds for its whole drain (#195's gate adversary, round 2): the row must not sit at 99% with
/// Cancel doing nothing until the drain ends.
#[tokio::test]
async fn a_cancel_ends_a_download_whose_commit_waits_for_the_lifecycle_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = original(dir.path());
    let before = bytes(&path);
    let s = stub(Reply::Body(vec![9u8; 10_000])).await;
    let engine = engine_at(dir.path(), &s);
    let held = crate::audio::common::acquire_engine_lifecycle_lock().await;
    let running = tokio::spawn({ let e = engine.clone(); async move { download_body(&e, ROW, &[9u8; 10_000], None).await } });
    engine.test_hooks().before_commit.notified().await;
    engine.cancel_download(ROW).await.expect("the download is still in flight");
    let ended = tokio::time::timeout(Duration::from_secs(2), running).await;
    let in_flight = engine.downloads_in_flight().await.contains(ROW);
    drop(held);
    let e = ended.expect("the download still waits for the lifecycle lock after its cancel").unwrap().expect_err("the cancel was ignored");
    assert_eq!(e.to_string(), "Download cancelled by user");
    assert!(!in_flight, "the cancelled download still reads as in flight");
    assert_eq!(bytes(&path), before, "the cancelled download replaced the file anyway");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "the cancel left a temporary file");
}

/// The row never reads Downloading 100% before its file is in place: every byte has arrived, and the
/// commit waits for the lifecycle lock (#195's gate adversary, round 2).
#[tokio::test]
async fn the_row_never_reads_downloading_100_before_the_rename() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Body(vec![9u8; 10_000])).await;
    let engine = engine_at(dir.path(), &s);
    // As the app does before any download: the progress a download reports is kept only for a row the
    // engine has listed, so without this the row reads Downloading 0 whatever the loop reports.
    engine.discover_models().await.unwrap();
    let held = crate::audio::common::acquire_engine_lifecycle_lock().await;
    let running = tokio::spawn({ let e = engine.clone(); async move { download_body(&e, ROW, &[9u8; 10_000], None).await } });
    engine.test_hooks().before_commit.notified().await;
    let status = engine.discover_models().await.unwrap().into_iter().find(|m| m.name == ROW).unwrap().status;
    drop(held);
    running.await.unwrap().expect("the download succeeds");
    assert!(
        matches!(status, ModelStatus::Downloading { progress: 99 }),
        "with every byte in and the file not yet in place, the row reads {status:?}"
    );
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
    // Stopped mid-body, not after it: a cancelled 700 MB model must not be fetched to the end first.
    assert!(s.sent.load(Ordering::SeqCst) < 200_000, "the cancel did not stop the transfer: {} of 200000 bytes sent", s.sent.load(Ordering::SeqCst));
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
    assert!(s.sent.load(Ordering::SeqCst) < 200_000, "the cancel did not stop the transfer: {} of 200000 bytes sent", s.sent.load(Ordering::SeqCst));
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
        // Beside the final file, so the rename stays on one file system. Waited for, not read once: the
        // stub's first chunk can be on the wire before the engine has read the headers and created the
        // file, which lost the race once under `cargo test --workspace` (#195's gate at eff88f6).
        let partial = dir.path().join(format!("{PARTIAL_PREFIX}{}", final_path(dir.path()).file_name().unwrap().to_string_lossy()));
        wait_until("the temporary file beside the final one, mid-body", || partial.is_file() && s.sent.load(Ordering::SeqCst) > 0).await;
        assert!(s.sent.load(Ordering::SeqCst) < 200_000, "{what}: the body was whole before it could be read mid-body");
        let status = engine.discover_models().await.unwrap().into_iter().find(|m| m.name == ROW).unwrap().status;
        assert!(matches!(status, ModelStatus::Downloading { .. }), "{what}: the row reads {status:?} mid-body");
        engine.cancel_download(ROW).await.unwrap();
        let _ = running.await;
    }
}

/// Condition 7's census: the four reads that skip a load, and first run's audio check, ask the engine
/// one question, and none decides by `get_current_model()`.
#[test]
fn the_reads_that_skip_a_load_ask_whether_the_model_is_usable() {
    // As LF: the Windows runner checks the sources out with CRLF, and one pattern below spans lines.
    let lf = |s: &str| s.replace("\r\n", "\n");
    let (commands, import, retranscription) =
        (lf(include_str!("commands.rs")), lf(include_str!("../audio/import.rs")), lf(include_str!("../audio/retranscription.rs")));
    let (commands, import, retranscription) = (commands.as_str(), import.as_str(), retranscription.as_str());
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

/// Every read of the engine's model slot, by file and method, each with why it may read the slot
/// itself rather than ask `usable_model` (#195's gate adversary, round 2). Held as a set: a read added
/// anywhere, or one removed, turns this red until it is listed here with its reason.
#[test]
fn every_read_of_the_model_slot_is_listed_with_its_reason() {
    const METHODS: [&str; 7] =
        ["get_current_model", "is_model_loaded", "usable_model", "model_languages", "open_session", "resolve_language", "transcribe_batch"];
    let listed: &[(&str, &str, usize, &str)] = &[
        ("audio/common.rs", "is_model_loaded", 1, "the idle unloader: it unloads the slot itself"),
        ("audio/common.rs", "get_current_model", 1, "the idle unloader's log of what it unloads"),
        ("audio/device_check.rs", "transcribe_batch", 1, "first run's audio check, after the frontend asked transcribe_get_current_model (usable_model) and loaded"),
        ("audio/dictation_probe.rs", "is_model_loaded", 1, "a measuring instrument that requires a warm model. On a stale slot it times the old weights; an idle commit can unload between this and open_session, which then fails with its own error, as the idle unloader could already"),
        ("audio/dictation_probe.rs", "resolve_language", 1, "the probe's session, as above"),
        ("audio/dictation_probe.rs", "open_session", 1, "the probe's session, as above"),
        ("audio/import.rs", "usable_model", 1, "import's read that skips a load"),
        ("audio/import.rs", "transcribe_batch", 1, "import decodes on the model it loaded or found usable, under its in-progress flag"),
        ("audio/retranscription.rs", "usable_model", 1, "retranscription's read that skips a load"),
        ("audio/retranscription.rs", "transcribe_batch", 1, "retranscription decodes on the model it loaded or found usable, under its in-progress flag"),
        ("audio/transcription/mod.rs", "is_model_loaded", 1, "recording, after the pre-flight under the lifecycle lock loaded what was not usable"),
        ("audio/transcription/mod.rs", "get_current_model", 1, "recording's record of the model it streams with"),
        ("audio/transcription/mod.rs", "resolve_language", 1, "recording's session"),
        ("audio/transcription/mod.rs", "open_session", 1, "recording's session"),
        ("transcribe_engine/commands.rs", "usable_model", 3, "the pre-flight, the preload's re-check, and transcribe_get_current_model"),
        ("transcribe_engine/commands.rs", "is_model_loaded", 1, "transcribe_is_model_loaded answers for the slot; its frontend wrapper has no caller"),
        ("transcribe_engine/commands.rs", "model_languages", 1, "transcribe_model_languages lists what the loaded model decodes. On a stale slot that is the old weights' list until the next load"),
        ("transcribe_engine/commands.rs", "transcribe_batch", 1, "transcribe_transcribe_audio, which no frontend code calls"),
        ("transcribe_engine/engine.rs", "get_current_model", 2, "transcribe_batch's diarization decision for the model it decodes with, and delete_model, which unloads the slot when it holds the deleted model"),
        ("transcribe_engine/engine.rs", "model_languages", 1, "resolve_language, inside the engine"),
        ("transcribe_engine/engine.rs", "resolve_language", 1, "transcribe_batch, inside the engine"),
        ("transcribe_engine/engine.rs", "open_session", 1, "transcribe_batch, inside the engine"),
        ("transcribe_engine/measurements.rs", "transcribe_batch", 1, "an ignored measurement over models it loads itself"),
        ("transcribe_engine/measurements.rs", "open_session", 1, "an ignored measurement over models it loads itself"),
    ];
    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                rust_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(files.len() > 50, "the walk found {} files under {}", files.len(), src.display());
    let mut found = std::collections::BTreeMap::new();
    for f in &files {
        let rel = f.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        if rel == "transcribe_engine/download_tests.rs" {
            continue;
        }
        let text = std::fs::read_to_string(f).unwrap();
        for m in METHODS {
            let n = text.matches(&format!(".{m}(")).count();
            if n > 0 {
                found.insert((rel.clone(), m.to_string()), n);
            }
        }
    }
    let expected: std::collections::BTreeMap<_, _> =
        listed.iter().map(|(f, m, n, _)| ((f.to_string(), m.to_string()), *n)).collect();
    assert_eq!(found, expected, "a read of the model slot is not listed with its reason, or a listed one is gone");
}

/// #179 condition 1: the list the generator writes is what the engine requests, line for line, with the
/// row's size and sha256, and the diarizer last. `test_every_download_url_resolves` checks only this
/// list against Hugging Face, so a URL the engine builds that is not in it would go unchecked.
#[test]
fn the_download_list_is_what_the_engine_requests() {
    let list = include_str!("../../scripts/download_urls.tsv");
    let lines: Vec<&str> = list.lines().collect();
    let catalogue = crate::config::TRANSCRIBE_MODEL_CATALOG;
    assert_eq!(
        lines.len(),
        catalogue.len() + 1,
        "download_urls.tsv has {} lines, but the engine downloads {} files: every catalogue row and the diarizer",
        lines.len(),
        catalogue.len() + 1
    );
    let base = crate::config::TRANSCRIBE_MODEL_BASE_URL;
    let d = &crate::config::SPEAKER_DIARIZER;
    let expected = catalogue
        .iter()
        .map(|r| (r.name, file_url(base, r.hf_repo, r.revision, r.filename), r.size_bytes, r.sha256))
        .chain([(crate::config::SPEAKER_DIARIZER_NAME, file_url(base, d.hf_repo, d.revision, d.filename), d.size_bytes, d.sha256)]);
    let wrong: Vec<String> = expected
        .zip(&lines)
        .filter(|((_, url, size, sha), line)| **line != format!("{url}\t{size}\t{sha}"))
        .map(|((name, url, size, sha), line)| format!("{name}: the list says {line:?}, the engine requests {url}\t{size}\t{sha}"))
        .collect();
    assert_eq!(wrong, Vec::<String>::new(), "download_urls.tsv is not what the engine requests");
}

/// #179 condition 3: every URL the engine builds names a full 40-hex commit, which also excludes
/// `resolve/main`. Hugging Face resolves a short revision, so only this catches a truncated one.
#[test]
fn every_download_url_is_pinned_to_a_full_commit() {
    let base = crate::config::TRANSCRIBE_MODEL_BASE_URL;
    let d = &crate::config::SPEAKER_DIARIZER;
    let urls = crate::config::TRANSCRIBE_MODEL_CATALOG
        .iter()
        .map(|r| (r.name, file_url(base, r.hf_repo, r.revision, r.filename)))
        .chain([(crate::config::SPEAKER_DIARIZER_NAME, file_url(base, d.hf_repo, d.revision, d.filename))]);
    let full = |segment: &str| segment.len() == 40 && segment.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let unpinned: Vec<String> = urls
        .filter(|(_, url)| !url.split("/resolve/").nth(1).and_then(|rest| rest.split('/').next()).is_some_and(full))
        .map(|(name, url)| format!("{name}: {url}"))
        .collect();
    assert_eq!(unpinned, Vec::<String>::new(), "these URLs do not name a 40-hex commit after /resolve/");
}

/// The line a stub was asked for by a download of `repo`'s `filename` at `revision`.
fn request_line(repo: &str, revision: &str, filename: &str) -> String {
    format!("GET /{repo}/resolve/{revision}/{filename} HTTP/1.1")
}

/// #179 condition 4, the size: a download one byte short or one byte long is refused with the size
/// error, before the hash is read, and leaves the final path as it was: the original on a re-download,
/// nothing on a fresh one. No temporary file is left either way.
#[tokio::test]
async fn a_download_of_another_length_is_refused_and_replaces_nothing() {
    let body = vec![9u8; 10_000];
    let mut long = body.clone();
    long.push(9);
    for (what, served) in [("one byte short", body[..body.len() - 1].to_vec()), ("one byte long", long)] {
        // The re-download first: a check that ran after the rename would replace the original.
        for fresh in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let before = (!fresh).then(|| bytes(&original(dir.path())));
            let s = stub(Reply::Body(served.clone())).await;
            let e = download_body(&engine_at(dir.path(), &s), ROW, &body, None).await.expect_err(what);
            let expected = format!("is {} bytes, not the 10000 its pin expects", served.len());
            assert!(e.to_string().contains(&expected), "{what}: not the size error: {e}");
            match before {
                Some(before) => assert_eq!(bytes(&final_path(dir.path())), before, "{what}: the file that was there changed"),
                None => assert!(!final_path(dir.path()).exists(), "{what}: a refused fresh download left a file at the final path"),
            }
            assert_eq!(partials(dir.path()), Vec::<String>::new(), "{what}: a refused download left a temporary file");
        }
    }
}

/// #179 condition 4, the hash: the right length with one byte flipped is refused with the hash error,
/// naming what arrived and what the pin expects, and replaces nothing.
#[tokio::test]
async fn a_download_with_one_flipped_byte_is_refused_and_replaces_nothing() {
    let body = vec![9u8; 10_000];
    let mut flipped = body.clone();
    flipped[5_000] ^= 1;
    for fresh in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let before = (!fresh).then(|| bytes(&original(dir.path())));
        let s = stub(Reply::Body(flipped.clone())).await;
        let e = download_body(&engine_at(dir.path(), &s), ROW, &body, None).await.expect_err("a flipped byte is kept");
        let expected = format!("hashes to {}, not the pinned {}", sha256_of(&flipped), sha256_of(&body));
        assert!(e.to_string().contains(&expected), "not the hash error: {e}");
        match before {
            Some(before) => assert_eq!(bytes(&final_path(dir.path())), before, "the file that was there changed"),
            None => assert!(!final_path(dir.path()).exists(), "a refused fresh download left a file at the final path"),
        }
        assert_eq!(partials(dir.path()), Vec::<String>::new(), "a refused download left a temporary file");
    }
}

/// #179 condition 4, the caller: `download_model` asks for its row's file at the row's revision, and
/// checks it against the row's size. The stub's 1000 bytes are no row's length.
#[tokio::test]
async fn download_model_requests_its_rows_pin() {
    let row = crate::config::transcribe_model(ROW).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Body(vec![5u8; 1000])).await;
    let e = engine_at(dir.path(), &s).download_model(ROW, None).await.expect_err("1000 bytes are not the row's file");
    assert_eq!(
        *s.requests.lock().unwrap(),
        vec![request_line(row.hf_repo, row.revision, row.filename)],
        "{ROW}: not the request line its pin gives"
    );
    let expected = format!("is 1000 bytes, not the {} its pin expects", row.size_bytes);
    assert!(e.to_string().contains(&expected), "{ROW}: not the size error naming the row's size_bytes: {e}");
}

/// #179 condition 4, the diarizer: its method asks for its own file at its own revision, and checks it
/// against its own size and sha256. The stub streams exactly its length in zeros, so the size passes
/// and the hash error names the diarizer's sha256. No gate downloads the diarizer, so this is all that
/// holds the values the method passes.
#[tokio::test]
async fn the_diarizers_download_requests_its_own_pin() {
    let d = &crate::config::SPEAKER_DIARIZER;
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Fill { byte: 0, len: d.size_bytes as usize }).await;
    let e = engine_at(dir.path(), &s).download_diarizer(None).await.expect_err("zeros are not the diarizer");
    assert_eq!(
        *s.requests.lock().unwrap(),
        vec![request_line(d.hf_repo, d.revision, d.filename)],
        "the diarizer: not the request line its pin gives"
    );
    assert!(!e.to_string().contains("its pin expects"), "the diarizer: the size error, not the hash error: {e}");
    assert!(e.to_string().contains(&format!("not the pinned {}", d.sha256)), "the diarizer: not the hash error naming its sha256: {e}");
    assert!(!dir.path().join(d.filename).exists(), "the refused diarizer was put in place");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "the refused diarizer left a temporary file");
}

/// Condition 7, with real models: the old file is moonshine-tiny's, the new one whisper-tiny's, under
/// moonshine-tiny's filename, and `arch()` tells which was installed. This way round the new file is
/// above the row's Available floor, so after a stale mark the pre-flight answers NeedsLoad, not
/// Damaged: whisper-tiny's 35 MB-floor row would read Damaged with moonshine's bytes (#195's gate
/// adversary, round 2).
mod replace_against_load {
    use super::*;

    const OLD_ROW: &str = "moonshine-tiny-q8";

    async fn arch(engine: &TranscribeEngine) -> String {
        engine.open_session().await.expect("a model is loaded").model().arch()
    }

    /// The old file at the row's path, and a stub that serves the new one.
    async fn setup() -> (tempfile::TempDir, Stub, Arc<TranscribeEngine>) {
        let dir = tempfile::tempdir().unwrap();
        let row = crate::config::transcribe_model(OLD_ROW).unwrap();
        std::fs::copy(crate::measure::measure_model("moonshine-tiny-Q8_0.gguf"), dir.path().join(row.filename)).unwrap();
        let s = stub(Reply::Body(new_file())).await;
        let engine = engine_at(dir.path(), &s);
        (dir, s, engine)
    }

    /// whisper-tiny's bytes, which the stub serves under moonshine-tiny's filename.
    fn new_file() -> Vec<u8> {
        std::fs::read(crate::measure::measure_model("whisper-tiny-Q8_0.gguf")).unwrap()
    }

    /// The replace, with a pin the new file satisfies (#179).
    async fn replace(engine: &TranscribeEngine) -> anyhow::Result<()> {
        download_body(engine, OLD_ROW, &new_file(), None).await
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
        let load = tokio::spawn({ let e = engine.clone(); async move { e.load_model(OLD_ROW).await } });
        hooks.load_paused.notified().await;
        hooks.pause_loads.store(false, Ordering::SeqCst);
        let download = tokio::spawn({ let e = engine.clone(); async move { replace(&e).await } });
        hooks.before_commit.notified().await;
        // Bounded: long enough for a commit that took no engine lock to finish its rename.
        tokio::time::sleep(Duration::from_millis(500)).await;
        eprintln!("7a: the commit {} while the load was paused", if download.is_finished() { "finished" } else { "waited" });
        hooks.release_load.notify_one();
        load.await.unwrap().expect("the load succeeds");
        download.await.unwrap().expect("the download succeeds");
        check(engine.usable_model().await.is_none(), "7a: the old file stays installed after a replace");
        engine.load_model(OLD_ROW).await.unwrap();
        check(arch(&engine).await == "whisper", "7a: the next load does not read the new file");
        check(engine.usable_model().await.as_deref() == Some(OLD_ROW), "7a: a fresh load is not offered as usable");

        // 7b: a replace with the old model loaded and idle unloads it.
        let (_dir, _s, engine) = setup().await;
        engine.load_model(OLD_ROW).await.unwrap();
        check(arch(&engine).await == "moonshine", "7b: the fixture's old model is not moonshine");
        replace(&engine).await.unwrap();
        check(!engine.is_model_loaded().await, "7b: an idle replace leaves the old model loaded");

        // 7e: between the rename and the unload, no read that skips a load is offered the old model,
        // though the new file is already in place.
        let (dir, _s, engine) = setup().await;
        engine.load_model(OLD_ROW).await.unwrap();
        let hooks = engine.test_hooks();
        hooks.pause_after_rename.store(true, Ordering::SeqCst);
        let download = tokio::spawn({ let e = engine.clone(); async move { replace(&e).await } });
        hooks.rename_paused.notified().await;
        let renamed = !dir.path().join(format!("{PARTIAL_PREFIX}{}", crate::config::transcribe_model(OLD_ROW).unwrap().filename)).exists();
        check(renamed, "7e: the pause is not after the rename");
        check(engine.usable_model().await.is_none(), "7e: the old model is offered between the rename and the unload");
        hooks.release_rename.notify_one();
        download.await.unwrap().expect("the download succeeds");

        // 7c: a replace while a job holds the engine leaves the job its model.
        let (_dir, _s, engine) = setup().await;
        engine.load_model(OLD_ROW).await.unwrap();
        let job = crate::audio::common::DeviceCheckHoldsEngine::take();
        replace(&engine).await.unwrap();
        check(engine.transcribe_batch(vec![0.0; 16_000], None).await.is_ok(), "7c: the job lost its model");
        if engine.is_model_loaded().await {
            check(arch(&engine).await == "moonshine", "7c: the job's model changed under it");
        }

        // 7d: once the job is done, the slot is not offered again, the pre-flight asks for a load, and
        // the next load reads the new file.
        drop(job);
        check(engine.usable_model().await.is_none(), "7d: the replaced model is offered again");
        let resolution = super::super::commands::resolve_with_engine(&engine, Some("local"), Some(OLD_ROW)).await.unwrap();
        check(
            matches!(&resolution, super::super::commands::Resolution::NeedsLoad(m) if m == OLD_ROW),
            "7d: the pre-flight does not ask for a load of the replaced model",
        );
        engine.load_model(OLD_ROW).await.unwrap();
        check(arch(&engine).await == "whisper", "7d: the next load does not read the new file");
        check(engine.usable_model().await.as_deref() == Some(OLD_ROW), "7d: a fresh load is not offered as usable");

        // 7f: a rename that fails puts the stale mark back as it was. Idle, so the old model is still
        // usable; and with a job holding an earlier replace's mark, it stays not usable.
        let failed_rename = |engine: Arc<TranscribeEngine>, dir: std::path::PathBuf| async move {
            // A finished replace on this engine left a stored `before_commit` permit; drop it, or the wait
            // below returns before this download has written its temporary file.
            let _ = tokio::time::timeout(Duration::from_millis(50), engine.test_hooks().before_commit.notified()).await;
            let held = crate::audio::common::acquire_engine_lifecycle_lock().await;
            let download = tokio::spawn({ let e = engine.clone(); async move { replace(&e).await } });
            engine.test_hooks().before_commit.notified().await;
            let partial = dir.join(format!("{PARTIAL_PREFIX}{}", crate::config::transcribe_model(OLD_ROW).unwrap().filename));
            std::fs::remove_file(&partial).expect("the temporary file to remove, so the rename fails");
            drop(held);
            download.await.unwrap()
        };
        let (dir, _s, engine) = setup().await;
        engine.load_model(OLD_ROW).await.unwrap();
        let r = failed_rename(engine.clone(), dir.path().to_path_buf()).await;
        check(r.as_ref().is_err_and(|e| e.to_string().contains("Failed to put")), "7f: the rename did not fail as arranged");
        check(engine.usable_model().await.as_deref() == Some(OLD_ROW), "7f: an idle model whose replace failed is no longer usable");
        let (dir, _s, engine) = setup().await;
        engine.load_model(OLD_ROW).await.unwrap();
        let job = crate::audio::common::DeviceCheckHoldsEngine::take();
        replace(&engine).await.unwrap();
        let r = failed_rename(engine.clone(), dir.path().to_path_buf()).await;
        check(r.is_err(), "7f: the second rename did not fail as arranged");
        check(engine.usable_model().await.is_none(), "7f: a failed second replace offers the replaced model again");
        drop(job);

        assert!(fails.is_empty(), "condition 7 failed: {fails:#?}");
    }
}

// A failed download says why and when, and a server that stops answering is bounded (#298): the
// connection at C, the headers at H, each gap in the body at G, and nothing the whole (#310). Every
// error here is the one `to_string()` gives, which is what both commands send. The tests whose case is
// a stall set G = 1 s, C = 2 s and H = 5 s, all different, so a timer wired to the wrong one fires at
// the wrong time; the others run at production's values.
mod a_failed_download_says_why {
    use super::*;
    use std::sync::OnceLock;

    const G: Duration = Duration::from_secs(1);
    const C: Duration = Duration::from_secs(2);
    const H: Duration = Duration::from_secs(5);
    /// A slow start: after G and before H, and not C.
    const LATE: Duration = Duration::from_secs(3);

    /// What `log` was given while this process ran, from the first `start_capture()`, at `Info`, as the
    /// app logs. A test that reads it calls `start_capture()` before it acts: the first test to read
    /// would otherwise install the logger after its own lines were logged. Tests run in parallel and
    /// three #195 tests fail `ROW` with a 500 too, so a test finds its own failure line by its marker and
    /// its stub's URL, never by the row's name alone.
    fn start_capture() -> &'static Mutex<Vec<(log::Level, String)>> {
        struct Capture(Mutex<Vec<(log::Level, String)>>);
        impl log::Log for Capture {
            fn enabled(&self, m: &log::Metadata<'_>) -> bool {
                m.level() <= log::Level::Info
            }
            fn log(&self, r: &log::Record<'_>) {
                if self.enabled(r.metadata()) {
                    self.0.lock().unwrap().push((r.level(), r.args().to_string()));
                }
            }
            fn flush(&self) {}
        }
        static CAPTURE: OnceLock<&'static Capture> = OnceLock::new();
        &CAPTURE
            .get_or_init(|| {
                let c: &'static Capture = Box::leak(Box::new(Capture(Mutex::new(Vec::new()))));
                log::set_logger(c).expect("another logger was installed in this test process first");
                log::set_max_level(log::LevelFilter::Info);
                c
            })
            .0
    }

    fn captured() -> Vec<(log::Level, String)> {
        start_capture().lock().unwrap().clone()
    }

    /// The failure lines that name `url`: those opening with the line's marker.
    fn failures_at(url: &str) -> Vec<(log::Level, String)> {
        captured().into_iter().filter(|(_, l)| l.starts_with("Download of ") && l.contains(" failed after ") && l.contains(url)).collect()
    }

    /// A port nothing listens on, and the OS's own words for connecting to it: the refusal is the
    /// sentinel that the port is dead, and its text is the oracle on every platform.
    fn dead_port() -> (String, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let refused = std::net::TcpStream::connect(addr).expect_err("something listens on the port just dropped");
        (format!("http://{addr}"), refused.to_string())
    }

    fn engine_at_base(dir: &Path, base: &str) -> Arc<TranscribeEngine> {
        Arc::new(TranscribeEngine::new_with_models_dir(Some(dir.to_path_buf())).unwrap().with_base_url(base))
    }

    fn stalling_engine(dir: &Path, stub: &Stub) -> Arc<TranscribeEngine> {
        stalling_engine_at(dir, &stub.base)
    }

    fn stalling_engine_at(dir: &Path, base: &str) -> Arc<TranscribeEngine> {
        Arc::new(
            TranscribeEngine::new_with_models_dir(Some(dir.to_path_buf()))
                .unwrap()
                .with_base_url(base)
                .with_read_timeout(H)
                .with_connect_timeout(C)
                .with_chunk_gap(G),
        )
    }

    /// The temporary file of a download of `ROW`.
    fn partial_of_row(dir: &Path) -> std::path::PathBuf {
        dir.join(format!("{PARTIAL_PREFIX}{}", crate::config::transcribe_model(ROW).unwrap().filename))
    }

    fn url_of(base: &str, name: &str) -> String {
        let r = crate::config::transcribe_model(name).unwrap();
        file_url(base, r.hf_repo, r.revision, r.filename)
    }

    fn diarizer_url(base: &str) -> String {
        let d = &crate::config::SPEAKER_DIARIZER;
        file_url(base, d.hf_repo, d.revision, d.filename)
    }

    fn status(models: Vec<ModelInfo>) -> ModelStatus {
        models.into_iter().find(|m| m.name == ROW).unwrap().status
    }

    /// Condition 1: a download that cannot connect says why, through both ways to the network.
    #[tokio::test]
    async fn a_download_that_cannot_connect_names_the_cause() {
        let dir = tempfile::tempdir().unwrap();
        let (base, refused) = dead_port();
        let engine = engine_at_base(dir.path(), &base);
        let model = engine.download_model(ROW, None).await.expect_err("download_model reached a dead port");
        let diarizer = engine.download_diarizer(None).await.expect_err("the diarizer reached a dead port");
        let mut fails = Vec::new();
        for (what, e) in [("download_model", model.to_string()), ("the diarizer", diarizer.to_string())] {
            if !e.contains("Failed to start download") {
                fails.push(format!("{what}: the error lacks `Failed to start download`: {e}"));
            }
            if !e.contains(&refused) {
                fails.push(format!("{what}: the error lacks the OS's `{refused}`: {e}"));
            }
        }
        assert!(fails.is_empty(), "condition 1 failed:\n{}", fails.join("\n"));
    }

    /// Condition 2(i): a download that fails is logged once, at `warn`, with its URL, its error and the
    /// seconds since it started, at production's bounds.
    #[tokio::test]
    async fn a_failed_download_is_logged_with_its_seconds() {
        start_capture();
        let dir = tempfile::tempdir().unwrap();
        let s = stub(Reply::After(Duration::from_millis(1500), Box::new(Reply::Status500))).await;
        engine_at(dir.path(), &s).download_model(ROW, None).await.expect_err("the 500 was taken for a download");
        let lines = failures_at(&url_of(&s.base, ROW));
        assert_eq!(lines.len(), 1, "not one failure line for this stub: {lines:#?}");
        let (level, line) = &lines[0];
        assert!(*level <= log::Level::Warn, "the failure line is at {level}, below warn: {line}");
        assert!(line.starts_with(&format!("Download of {ROW} failed after ")) && line.contains("Download failed with status: 500"), "the line lacks the row or the error: {line}");
        assert!(!line.contains("Downloading model file"), "the failure line reads as a download starting to the onboarding pass: {line}");
        let seconds: f64 = line[format!("Download of {ROW} failed after ").len()..].split(' ').next().unwrap().parse().unwrap();
        assert!((1.5..=2.5).contains(&seconds), "the line gives {seconds} s for a stub that waited 1.5 s: {line}");
    }

    /// Condition 2(ii): the diarizer's failure is logged by the same line.
    #[tokio::test]
    async fn the_diarizers_failure_is_logged_too() {
        start_capture();
        let dir = tempfile::tempdir().unwrap();
        let (base, refused) = dead_port();
        engine_at_base(dir.path(), &base).download_diarizer(None).await.expect_err("the diarizer reached a dead port");
        let lines = failures_at(&diarizer_url(&base));
        assert_eq!(lines.len(), 1, "not one failure line for the diarizer: {lines:#?}");
        let (level, line) = &lines[0];
        assert!(*level <= log::Level::Warn, "the failure line is at {level}, below warn: {line}");
        assert!(line.starts_with(&format!("Download of {} failed after ", crate::config::SPEAKER_DIARIZER_NAME)), "the line does not name the diarizer: {line}");
        assert!(line.contains(&refused), "the line lacks the OS's `{refused}`: {line}");
        assert!(!line.contains("Downloading model file"), "the failure line reads as a download starting to the onboarding pass: {line}");
    }

    /// Condition 2(iii): a download that completes logs no failure. The two above hold that a failure
    /// line never reads as a download starting to the onboarding pass's nine greps.
    #[tokio::test]
    async fn a_completed_download_logs_no_failure() {
        start_capture();
        let dir = tempfile::tempdir().unwrap();
        let body = vec![9u8; 10_000];
        let s = stub(Reply::Body(body.clone())).await;
        let r = crate::config::transcribe_model(ROW).unwrap();
        let sha256 = sha256_of(&body);
        let name = "a-name-of-its-own-298";
        let pin = FilePin { revision: r.revision, size_bytes: body.len() as u64, sha256: &sha256 };
        engine_at(dir.path(), &s).download_file(name, r.hf_repo, r.filename, pin, None).await.expect("the download completes");
        let url = url_of(&s.base, ROW);
        let all = captured();
        assert!(all.iter().any(|(_, l)| l.starts_with(&format!("Downloading model file {url} -> "))), "the capture holds no download line for this stub, so its silence means nothing");
        assert!(all.iter().any(|(_, l)| l.starts_with(&format!("Downloaded {name} ("))), "the capture holds no Downloaded line for {name}");
        assert_eq!(failures_at(&url), Vec::new(), "a download that completed was logged as failed");
    }

    /// Condition 3, and #310 item 7: production's three bounds, H on the client, C and G on the engine,
    /// and no total. A built client's `Debug` prints its read timeout but not its connect timeout, so C
    /// and G are read from the fields; the census below pins the code that hands each to its timer.
    #[tokio::test]
    async fn the_client_has_a_read_timeout_and_no_total() {
        let dir = tempfile::tempdir().unwrap();
        let engine = TranscribeEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
        let production = format!("{:?}", engine.client().unwrap());
        assert!(production.contains("read_timeout: 300s"), "the production client does not wait 5 minutes for the headers: {production}");
        assert!(production.contains("proxies"), "the production client reads no system proxy: {production}");
        assert_eq!(engine.connect_timeout, Duration::from_secs(30), "the production engine does not give a connection 30 s to open");
        assert_eq!(engine.chunk_gap, Duration::from_secs(30), "the production engine does not give each part of the body 30 s");
        let test = format!("{:?}", engine_at_base(dir.path(), "http://127.0.0.1:9").client().unwrap());
        assert!(!test.contains("proxies"), "the test engine's client reads a proxy: {test}");
        assert!(test.contains("read_timeout: 300s"), "the test engine's client is not built with the engine's H: {test}");
    }

    /// The byte range of the body of the first function whose signature starts with `signature`.
    fn body_of(code: &str, signature: &str) -> std::ops::Range<usize> {
        let start = code.find(signature).unwrap_or_else(|| panic!("no {signature} in engine.rs"));
        let open = start + code[start..].find('{').unwrap();
        let mut depth = 0i32;
        for (i, ch) in code[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return open..open + i;
                    }
                }
                _ => {}
            }
        }
        panic!("{signature}'s body does not close")
    }

    /// Condition 3's census, rewritten as an allow-list (#310 item 8). `engine.rs` is read with comments
    /// stripped; every match is case-sensitive, as `match_indices` is, so `DOWNLOAD_READ_TIMEOUT` and
    /// its kin never match, and each `timeout` is judged by the whole identifier around it.
    /// - One client construction, inside `download_client`.
    /// - `read_timeout` and `connect_timeout` only as a field, `self.<field>`, an initialiser, a
    ///   parameter, a value inside a setter or `download_client`, or a method call inside
    ///   `download_client`. Never a bare call, a path call, or a name in a `use`.
    /// - `with_read_timeout` and `with_connect_timeout` only as the setters' own names.
    /// - Exactly one `tokio::time::timeout`, the loop's, `tokio::time::timeout(self.chunk_gap,
    ///   stream.next())`, inside `download_inner`.
    /// - `client()` builds the client as `download_client(self.read_timeout, self.connect_timeout,
    ///   self.system_proxy)`, the one call besides the definition.
    /// - Every `select`, `sleep` and `interval` inside `commit_download`'s one `tokio::select!` or its
    ///   one 100 ms `tokio::time::sleep`, for its lock.
    ///
    /// Not held: a total written as an `elapsed()` check against a constant in the loop (`download_file`
    /// already reads `started.elapsed()` for #298's line); a bound in a caller outside this file
    /// (`commands.rs`, `diarization.rs`); a timer through a helper in another file whose name holds none
    /// of these words.
    #[test]
    fn the_engine_builds_its_client_in_one_place() {
        let code = without_comments(include_str!("engine.rs"));
        let builds: Vec<usize> = ["Client::builder(", "Client::new(", "Client::default(", "ClientBuilder::new(", "ClientBuilder::default(", "reqwest::get("]
            .iter()
            .flat_map(|c| code.match_indices(c).map(|(i, _)| i).collect::<Vec<_>>())
            .collect();
        assert_eq!(builds.len(), 1, "engine.rs constructs a client {} times, not once", builds.len());
        let client_fn = body_of(&code, "fn download_client(");
        assert!(client_fn.contains(&builds[0]), "the one client construction is outside download_client");

        let inner = body_of(&code, "fn download_inner(");
        let commit = body_of(&code, "fn commit_download(");
        let setters = [body_of(&code, "fn with_read_timeout("), body_of(&code, "fn with_connect_timeout(")];
        let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
        let context = |i: usize| code[i.saturating_sub(60)..(i + 60).min(code.len())].split_whitespace().collect::<Vec<_>>().join(" ");
        // The statement a position sits in starts after the last `;`, `{` or `}` before it.
        let in_use = |i: usize| {
            let from = code[..i].rfind([';', '{', '}']).map_or(0, |p| p + 1);
            let stmt = code[from..i].trim_start();
            ["use ", "pub use ", "pub(crate) use ", "pub(super) use "].iter().any(|u| stmt.starts_with(u))
        };
        let squash = |t: &str| t.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        const PIN: &str = "tokio::time::timeout(self.chunk_gap,stream.next())";
        let (mut refused, mut pins) = (Vec::new(), 0);
        for (i, _) in code.match_indices("timeout") {
            let s = code[..i].rfind(|c: char| !is_ident(c)).map_or(0, |p| p + 1);
            let e = i + code[i..].find(|c: char| !is_ident(c)).unwrap_or(code.len() - i);
            let ident = &code[s..e];
            let before = code[..s].trim_end();
            let after = code[e..].trim_start();
            let ok = match ident {
                "timeout" => {
                    let at_pin = before.ends_with("tokio::time::") && squash(&code[s - "tokio::time::".len()..(s + 80).min(code.len())]).starts_with(PIN);
                    let ok = at_pin && inner.contains(&s);
                    pins += ok as usize;
                    ok
                }
                "read_timeout" | "connect_timeout" => {
                    if in_use(s) || before.ends_with("::") {
                        false
                    } else if after.starts_with('(') {
                        before.ends_with('.') && client_fn.contains(&s)
                    } else {
                        (after.starts_with(':') && !after.starts_with("::"))
                            || before.ends_with("self.")
                            || client_fn.contains(&s)
                            || setters.iter().any(|r| r.contains(&s))
                    }
                }
                "with_read_timeout" | "with_connect_timeout" => before.ends_with("fn") && after.starts_with('('),
                _ => false,
            };
            if !ok {
                refused.push(format!("`{ident}` in: {}", context(i)));
            }
        }
        assert!(
            refused.is_empty(),
            "engine.rs bounds a download other than by its three allowed timers, the headers' H, the connection's C and the loop's G (#298, #310): {refused:#?}"
        );
        assert_eq!(pins, 1, "engine.rs has {pins} loop timers of the pinned text `{PIN}` inside download_inner, not one");
        // And the call that hands each field to its own timer, pinned by its text: the fields are read
        // by #310 item 7, and this is what makes them the values the client is built with.
        const CALL: &str = "download_client(self.read_timeout,self.connect_timeout,self.system_proxy)";
        let client = body_of(&code, "fn client(");
        assert!(squash(&code[client.clone()]).contains(CALL), "client() does not build the download's client as `{CALL}`: {}", context(client.start));
        assert_eq!(squash(&code).matches("download_client(").count(), 2, "download_client is called other than once, from client(), beside its definition");

        const SELECT: &str = "tokio::select!";
        const SLEEP: &str = "tokio::time::sleep(std::time::Duration::from_millis(100))";
        let allowed: Vec<std::ops::Range<usize>> = [SELECT, SLEEP]
            .iter()
            .flat_map(|t| code.match_indices(t).map(|(i, m)| i..i + m.len()).collect::<Vec<_>>())
            .collect();
        for t in [SELECT, SLEEP] {
            let at: Vec<usize> = code.match_indices(t).map(|(i, _)| i).collect();
            assert!(at.len() == 1 && commit.contains(&at[0]), "`{t}` occurs {} times in engine.rs, not once inside commit_download", at.len());
        }
        let stray: Vec<String> = ["select", "sleep", "interval"]
            .iter()
            .flat_map(|w| code.match_indices(w).map(|(i, _)| i).collect::<Vec<_>>())
            .filter(|i| !allowed.iter().any(|r| r.contains(i)))
            .map(|i| context(i))
            .collect();
        assert!(stray.is_empty(), "engine.rs selects, sleeps or ticks outside commit_download's lock: {stray:#?}");
    }

    /// Rust source with `//` and `/* */` comments removed, strings and char literals kept.
    fn without_comments(src: &str) -> String {
        let (b, mut out, mut i) = (src.as_bytes(), Vec::new(), 0);
        while i < b.len() {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i += 2;
                    while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                        i += 1;
                    }
                    i += 2;
                }
                b'"' => {
                    out.push(b[i]);
                    i += 1;
                    while i < b.len() && b[i] != b'"' {
                        if b[i] == b'\\' {
                            out.push(b[i]);
                            i += 1;
                        }
                        out.push(b[i]);
                        i += 1;
                    }
                    if i < b.len() {
                        out.push(b[i]);
                        i += 1;
                    }
                }
                b'\'' if b.get(i + 2) == Some(&b'\'') || (b.get(i + 1) == Some(&b'\\') && b.get(i + 3) == Some(&b'\'')) => {
                    let n = if b[i + 1] == b'\\' { 4 } else { 3 };
                    out.extend_from_slice(&b[i..i + n]);
                    i += n;
                }
                _ => {
                    out.push(b[i]);
                    i += 1;
                }
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// #310 item 1: a slow start is waited for. The headers come after LATE, past G and short of H, then
    /// the whole body at once.
    #[tokio::test]
    async fn a_slow_start_is_waited_for() {
        let dir = tempfile::tempdir().unwrap();
        let body: Vec<u8> = (0..10_000u32).map(|i| (i * 7) as u8).collect();
        let s = stub(Reply::After(LATE, Box::new(Reply::Body(body.clone())))).await;
        let engine = stalling_engine(dir.path(), &s);
        tokio::time::timeout(LATE + Duration::from_secs(2), download_body(&engine, ROW, &body, None))
            .await
            .expect("still running at LATE + 2 s")
            .expect("a server that answered after LATE, inside H, was cut off");
        assert_eq!(bytes(&final_path(dir.path())), body, "the final path does not hold the bytes");
    }

    /// Condition 4(a), #310 item 2: a server that never answers fails a fresh download within H, not
    /// before it, and it leaves nothing behind.
    #[tokio::test]
    async fn a_server_that_never_answers_fails_within_h() {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(Reply::Silent).await;
        let engine = stalling_engine(dir.path(), &s);
        let called = tokio::time::Instant::now();
        let e = tokio::time::timeout(H + Duration::from_secs(2), engine.download_model(ROW, None))
            .await
            .expect("still running at H + 2 s")
            .expect_err("a silent server was taken for a download")
            .to_string();
        let took = called.elapsed();
        assert!(took >= H, "a silent server failed after {took:?}, before H");
        assert!(e.contains("Failed to start download") && e.contains("timed out"), "the error is not a start that timed out: {e}");
        assert!(!engine.downloads_in_flight().await.contains(ROW), "the row still reads as in flight");
        assert!(matches!(status(engine.discover_models().await.unwrap()), ModelStatus::Missing), "the row does not read Missing");
        assert!(!final_path(dir.path()).exists(), "a final file is there");
        assert_eq!(partials(dir.path()), Vec::<String>::new(), "a temporary file is left");
    }

    /// Condition 4(b), #310 items 3 and 4: a server that goes silent fails within G, after 1000 bytes or
    /// before the first, through `download_file`, over a damaged original it leaves as it was. Every
    /// failure is collected before asserting.
    #[tokio::test]
    async fn a_server_that_goes_silent_in_the_body_fails_within_g() {
        let mut fails = Vec::new();
        for (what, sent) in [("after 1000 bytes", vec![1u8; 1000]), ("before the first byte", vec![])] {
            let dir = tempfile::tempdir().unwrap();
            let path = original(dir.path());
            let before = bytes(&path);
            let s = stub(Reply::GoesSilent { sent, claimed: 1_000_000 }).await;
            let engine = stalling_engine(dir.path(), &s);
            assert!(matches!(status(engine.discover_models().await.unwrap()), ModelStatus::Corrupted { .. }), "the fixture is not damaged");
            let called = tokio::time::Instant::now();
            match tokio::time::timeout(G + Duration::from_secs(2), engine.download_model(ROW, None)).await {
                Err(_) => fails.push(format!("{what}: still running at G + 2 s")),
                Ok(Ok(())) => fails.push(format!("{what}: a body that stopped short was taken for a download")),
                Ok(Err(e)) => {
                    let took = called.elapsed();
                    if !(G..G + Duration::from_secs(1)).contains(&took) {
                        fails.push(format!("{what}: it failed after {took:?}, not within [G, G + 1 s)"));
                    }
                    if e.to_string() != "Failed to read chunk: timed out: no data for 1 s" {
                        fails.push(format!("{what}: the error is not the loop's timeout: {e}"));
                    }
                }
            }
            if bytes(&path) != before {
                fails.push(format!("{what}: the original changed"));
            }
            if !partials(dir.path()).is_empty() {
                fails.push(format!("{what}: a temporary file is left: {:?}", partials(dir.path())));
            }
            if engine.downloads_in_flight().await.contains(ROW) {
                fails.push(format!("{what}: the row still reads as in flight"));
            }
            let after = status(engine.discover_models().await.unwrap());
            if !matches!(after, ModelStatus::Corrupted { .. }) {
                fails.push(format!("{what}: the row reads {after:?}, not Corrupted"));
            }
        }
        assert!(fails.is_empty(), "condition 4(b) failed:\n{}", fails.join("\n"));
    }

    /// Condition 4(c), the sentinel: a server slower than G in total, but silent for no more than G/4
    /// at a time, completes: nine chunks, eight gaps, 2G. The slack below G is for a loaded runner: CI's
    /// macOS and Windows jobs run these tests too.
    #[tokio::test]
    async fn a_slow_server_that_never_goes_silent_completes() {
        let dir = tempfile::tempdir().unwrap();
        let body: Vec<u8> = (0..9000u32).map(|i| i as u8).collect();
        let s = stub(Reply::Slow { body: body.clone(), chunk: 1000, delay: G / 4 }).await;
        let engine = stalling_engine(dir.path(), &s);
        tokio::time::timeout(G * 2 + Duration::from_secs(2), download_body(&engine, ROW, &body, None))
            .await
            .expect("still running at its length + 2 s")
            .expect("a server that sent a chunk every G/4 was cut off");
        assert_eq!(bytes(&final_path(dir.path())), body, "the final path does not hold the bytes");
    }

    /// #310 item 5(b): no total. A start past G, then a body never silent for G, together longer than
    /// H: LATE, then 28 chunks G/4 apart, about 10 s. A total of H anywhere, on the request or around the
    /// download, ends it.
    #[tokio::test]
    async fn a_slow_start_and_a_slow_body_run_past_h() {
        let dir = tempfile::tempdir().unwrap();
        let body: Vec<u8> = (0..28_000u32).map(|i| (i * 3) as u8).collect();
        let s = stub(Reply::After(LATE, Box::new(Reply::Slow { body: body.clone(), chunk: 1000, delay: G / 4 }))).await;
        let engine = stalling_engine(dir.path(), &s);
        let called = tokio::time::Instant::now();
        tokio::time::timeout(LATE + G / 4 * 28 + Duration::from_secs(2), download_body(&engine, ROW, &body, None))
            .await
            .expect("still running at its length + 2 s")
            .expect("a download that ran past H was cut off");
        assert!(called.elapsed() > H, "the download took {:?}, so it never ran past H", called.elapsed());
        assert_eq!(bytes(&final_path(dir.path())), body, "the final path does not hold the bytes");
    }

    /// #310 item 6: a connection that does not open fails within C, and says so. The stub accepts TCP
    /// behind an `https://` URL and never writes, so the TLS handshake waits for a ServerHello.
    #[tokio::test]
    async fn a_connection_that_never_opens_fails_within_c() {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(Reply::Silent).await;
        let engine = stalling_engine_at(dir.path(), &s.base.replacen("http://", "https://", 1));
        let called = tokio::time::Instant::now();
        let e = tokio::time::timeout(H + Duration::from_secs(2), engine.download_model(ROW, None))
            .await
            .expect("still running at H + 2 s")
            .expect_err("a connection that never opened was taken for a download")
            .to_string();
        let took = called.elapsed();
        assert!(s.accepted.load(Ordering::SeqCst) >= 1, "the stub accepted no connection, so nothing waited on a handshake");
        assert!((C..C + Duration::from_secs(1)).contains(&took), "it failed after {took:?}, not within [C, C + 1 s)");
        assert!(e.contains("client error (Connect)") && e.contains("timed out"), "the error is not a connection that timed out: {e}");
    }

    /// #310 item 10, #298 condition 1 on the body-error branch: a connection closed mid-body says why.
    #[tokio::test]
    async fn a_connection_closed_mid_body_names_its_cause() {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(Reply::CloseMidBody { sent: vec![1u8; 1000], claimed: 1_000_000 }).await;
        let engine = stalling_engine(dir.path(), &s);
        let e = tokio::time::timeout(G + Duration::from_secs(2), engine.download_model(ROW, None))
            .await
            .expect("still running at G + 2 s")
            .expect_err("a body cut short was taken for a download")
            .to_string();
        println!("{e}");
        assert!(e.starts_with("Failed to read chunk: ") && e.contains("end of file before message length reached"), "the error does not say the body was cut short: {e}");
    }

    /// Condition 5(a): a cancel during a stall before the headers is answered when H fires, as the
    /// timeout, and the flag it left does not cancel the next download of that name.
    #[tokio::test]
    async fn a_cancel_before_the_headers_is_answered_by_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let body = vec![9u8; 10_000];
        let s = stub(Reply::Sequence(vec![Reply::Silent, Reply::Body(body.clone())])).await;
        let engine = stalling_engine(dir.path(), &s);
        let first = tokio::spawn({ let (e, b) = (engine.clone(), body.clone()); async move { download_body(&e, ROW, &b, None).await } });
        let asked = tokio::time::Instant::now();
        while s.requests.lock().unwrap().is_empty() {
            assert!(asked.elapsed() < G, "the stub was not asked within G, so there is no stall to cancel");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        engine.cancel_download(ROW).await.expect("the download is in flight");
        let e = tokio::time::timeout(H + Duration::from_secs(2), first).await.expect("still running at H + 2 s").unwrap().expect_err("the stall was taken for a download").to_string();
        assert!(e.contains("timed out") && e != "Download cancelled by user", "the stall ended as {e}, not as its timeout");
        download_body(&engine, ROW, &body, None).await.expect("the next download of the same name did not complete");
        assert_eq!(bytes(&final_path(dir.path())), body);
    }

    /// Condition 5(b): a cancel while the body has stalled is answered when G fires, as the cancel.
    #[tokio::test]
    async fn a_cancel_mid_body_is_answered_as_the_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(Reply::GoesSilent { sent: vec![1u8; 1000], claimed: 1_000_000 }).await;
        let engine = stalling_engine(dir.path(), &s);
        let running = tokio::spawn({ let e = engine.clone(); async move { e.download_model(ROW, None).await } });
        let partial = partial_of_row(dir.path());
        // The reply's fixed length: the engine writes a chunk only after its flag check, so once all 1000
        // bytes are in the file the loop waits on the next frame.
        let asked = tokio::time::Instant::now();
        while std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0) < 1000 {
            assert!(asked.elapsed() < G, "the temporary file did not hold the 1000 bytes sent within G, so there is no stall mid-body to cancel");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        engine.cancel_download(ROW).await.expect("the download is in flight");
        let e = tokio::time::timeout(G + Duration::from_secs(2), running).await.expect("still running at G + 2 s").unwrap().expect_err("the stall was taken for a download");
        assert_eq!(e.to_string(), "Download cancelled by user");
        assert_eq!(partials(dir.path()), Vec::<String>::new(), "the cancel left a temporary file");
    }

    /// #310 item 11: a cancel that lands while the body waits, where the wait then ends in an error
    /// rather than a timeout, is answered as the cancel. The reply closes G/2 after its bytes, and the
    /// stub records the instant: the download must end at the close, not at the cancel and not at G.
    #[tokio::test]
    async fn a_cancel_then_a_close_is_answered_as_the_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(Reply::CloseAfter { sent: vec![1u8; 1000], claimed: 1_000_000, wait: G / 2 }).await;
        let engine = stalling_engine(dir.path(), &s);
        let running = tokio::spawn({ let e = engine.clone(); async move { let r = e.download_model(ROW, None).await; (r, tokio::time::Instant::now()) } });
        let partial = partial_of_row(dir.path());
        // On the file, never on the stub's `sent`: that is bumped before the engine has read the bytes, so
        // a cancel on it could land before the loop takes the chunk, whose own check would then answer.
        let asked = tokio::time::Instant::now();
        while std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0) < 1000 {
            assert!(asked.elapsed() < G / 2, "the temporary file did not hold the 1000 bytes sent within G/2, so the close may come first");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        engine.cancel_download(ROW).await.expect("the download is in flight");
        let cancelled = tokio::time::Instant::now();
        let (r, ended) = tokio::time::timeout(G + Duration::from_secs(2), running).await.expect("still running at G + 2 s").unwrap();
        let closed = s.closed.lock().unwrap().expect("the reply never closed");
        assert!(cancelled < closed, "the cancel came {:?} after the close, so the close was not what it waited on", cancelled - closed);
        assert!(closed <= ended && ended < closed + G / 4, "the download ended {:?} after the close, not at it", ended.saturating_duration_since(closed));
        assert_eq!(r.expect_err("a body cut short was taken for a download").to_string(), "Download cancelled by user");
    }
}

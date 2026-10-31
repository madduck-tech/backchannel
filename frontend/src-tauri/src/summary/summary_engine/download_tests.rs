// The summary engine's downloads (#191): each file is fetched at its pinned commit into a temporary file,
// and renamed over its final path only once it is exactly its pin's length and sha256. Each test serves
// its own small file from #195's local stub (`crate::test_http_stub`), through a manager whose client
// reads no proxy. A child of `model_manager`, so it calls `download_one` and reads `active_downloads`.
use super::*;
use crate::test_http_stub::{stub, Reply, Stub};
use std::path::Path;
use std::sync::atomic::Ordering;

/// The stub's pinned bytes. They begin with `GGUF`, so the magic check after the size and hash checks
/// passes on them, and on nothing the tests corrupt after the fourth byte.
fn body() -> Vec<u8> {
    let mut b = b"GGUF".to_vec();
    b.extend((0..9996u32).map(|i| (i * 31 + 7) as u8));
    b
}

fn pin_of(bytes: &[u8]) -> PinnedFile {
    use sha2::Digest;
    PinnedFile {
        repo: "test-org/test-model-GGUF".to_string(),
        revision: "0123456789abcdef0123456789abcdef01234567".to_string(),
        size_bytes: bytes.len() as u64,
        sha256: format!("{:x}", sha2::Sha256::digest(bytes)),
    }
}

const FILE: &str = "test-model-Q4_0.gguf";

/// A target for `FILE` at the pin of `bytes`. `size_mb` is the scan's window, in MiB; 0 makes any small
/// file at the final path read whole, 10 makes it read as an earlier build's partial.
fn target(s: &Stub, bytes: &[u8], size_mb: u64) -> DownloadTarget {
    let pin = pin_of(bytes);
    DownloadTarget { url: pin.url(&s.base, FILE), file: FILE.to_string(), size_mb, pin }
}

fn manager(dir: &Path, s: &Stub) -> ModelManager {
    ModelManager::new_with_models_dir(Some(dir.to_path_buf()))
        .unwrap()
        .with_base_url(&s.base)
        .with_stall_timeout(Duration::from_secs(1))
}

async fn fetch(m: &ModelManager, t: &DownloadTarget) -> Result<()> {
    m.active_downloads.write().await.insert("test-model".to_string());
    let total = t.pin.size_bytes;
    m.download_one("test-model", t, 0, total, &None).await
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    v.sort();
    v
}

fn partials(dir: &Path) -> Vec<String> {
    names(dir).into_iter().filter(|n| n.starts_with(PARTIAL_PREFIX)).collect()
}

fn ranges(s: &Stub) -> Vec<Option<String>> {
    s.ranges.lock().unwrap().clone()
}

// ---- condition 4: a temporary file, renamed only when it is exactly its pin ---------------------------

#[tokio::test]
async fn a_fresh_download_is_renamed_into_place_only_when_it_is_its_pin() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    fetch(&m, &target(&s, &body(), 0)).await.expect("the pinned bytes were not kept");
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), body(), "the final path does not hold the pinned bytes");
    assert_eq!(partials(dir.path()), Vec::<String>::new(), "a temporary file is left");
    assert_eq!(ranges(&s), vec![None], "a fresh download was ranged");
}

#[tokio::test]
async fn a_short_download_fails_on_its_size_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let short = body()[..body().len() - 1].to_vec();
    let s = stub(Reply::Ranged(short)).await;
    let m = manager(dir.path(), &s);
    let e = fetch(&m, &target(&s, &body(), 0)).await.expect_err("a short file was kept").to_string();
    assert_eq!(e, format!("{FILE} is 9999 bytes, not the 10000 its pin expects"), "the error is not the size check's");
    assert_eq!(names(dir.path()), Vec::<String>::new(), "a file is left after the size error");
}

#[tokio::test]
async fn a_download_of_other_bytes_fails_on_its_hash_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut wrong = body();
    wrong[5000] ^= 1;
    let s = stub(Reply::Ranged(wrong)).await;
    let m = manager(dir.path(), &s);
    let e = fetch(&m, &target(&s, &body(), 0)).await.expect_err("other bytes were kept").to_string();
    assert!(e.starts_with(&format!("{FILE} hashes to ")) && e.ends_with(&format!("not the pinned {}", pin_of(&body()).sha256)), "the error is not the hash check's: {e}");
    assert_eq!(names(dir.path()), Vec::<String>::new(), "a file is left after the hash error");
}

#[tokio::test]
async fn a_full_length_temporary_file_is_checked_before_any_request() {
    // Of the pinned bytes: renamed into place, no request.
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    let t = target(&s, &body(), 0);
    std::fs::write(dir.path().join(partial_name(&t.pin.sha256, FILE)), body()).unwrap();
    fetch(&m, &t).await.expect("a whole temporary file of the pinned bytes was not kept");
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), body());
    assert_eq!(ranges(&s), Vec::<Option<String>>::new(), "a whole temporary file was requested again: a Range at its length is answered 416");
    // Of other bytes: removed, and fetched from zero.
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    let t = target(&s, &body(), 0);
    let mut wrong = body();
    wrong[9999] ^= 1;
    std::fs::write(dir.path().join(partial_name(&t.pin.sha256, FILE)), &wrong).unwrap();
    fetch(&m, &t).await.expect("the download after a bad whole temporary file failed");
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), body());
    assert_eq!(ranges(&s), vec![None], "the bad temporary file was not removed and fetched from zero");
}

#[tokio::test]
async fn a_temporary_file_of_another_pin_is_not_resumed() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    let other = format!("{:064x}", 7);
    std::fs::write(dir.path().join(partial_name(&other, FILE)), &body()[..5000]).unwrap();
    fetch(&m, &target(&s, &body(), 0)).await.unwrap();
    assert_eq!(ranges(&s), vec![None], "another pin's temporary file was resumed");
}

#[tokio::test]
async fn a_cancel_a_stall_and_a_stream_error_keep_the_temporary_file_and_never_the_final_path() {
    let mut fails = Vec::new();
    for (what, reply) in [
        ("a stall", Reply::GoesSilent { sent: body()[..4000].to_vec(), claimed: 10_000 }),
        ("a stream error", Reply::CloseMidBody { sent: body()[..4000].to_vec(), claimed: 10_000 }),
        ("a cancel", Reply::Slow { body: body(), chunk: 1000, delay: Duration::from_millis(200) }),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let s = stub(reply).await;
        let m = std::sync::Arc::new(manager(dir.path(), &s));
        let t = target(&s, &body(), 0);
        let running = tokio::spawn({
            let (m, t) = (m.clone(), DownloadTarget { url: t.url.clone(), file: t.file.clone(), size_mb: t.size_mb, pin: t.pin.clone() });
            async move { fetch(&m, &t).await }
        });
        if what == "a cancel" {
            for _ in 0..100 {
                if s.sent.load(Ordering::SeqCst) >= 2000 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            m.cancel_download("test-model").await.unwrap();
        }
        let r = tokio::time::timeout(Duration::from_secs(10), running).await.expect("still running at 10 s").unwrap();
        if r.is_ok() {
            fails.push(format!("{what}: taken for a download"));
        }
        if dir.path().join(FILE).exists() {
            fails.push(format!("{what}: the final path was written"));
        }
        if partials(dir.path()).len() != 1 {
            fails.push(format!("{what}: the temporary file is not kept: {:?}", names(dir.path())));
        }
    }
    assert!(fails.is_empty(), "condition 4's kept partial:\n{}", fails.join("\n"));
}

/// #191 condition 4, what the caller passes: the weights' request names their pinned commit, and so does
/// the projector's, each ending in the size error naming its own pin's length.
#[tokio::test]
async fn the_model_download_requests_each_file_at_its_pin() {
    let e2b = get_model_by_name("gemma4:e2b").unwrap();
    let proj = e2b.mmproj.clone().unwrap();
    // The weights, with models/summary/ empty.
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Body(b"GGUF012345".to_vec())).await;
    let m = ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap().with_base_url(&s.base);
    m.scan_models().await.unwrap();
    let e = m.download_model_detailed("gemma4:e2b", None).await.expect_err("10 bytes were taken for the weights").to_string();
    assert_eq!(
        s.requests.lock().unwrap().first().cloned().unwrap_or_default(),
        format!("GET /{}/resolve/{}/{} HTTP/1.1", e2b.weights.repo, e2b.weights.revision, e2b.gguf_file),
        "the weights' request line"
    );
    assert!(e.contains(&format!("not the {} its pin expects", e2b.weights.size_bytes)), "the weights did not end in their size error: {e}");
    // The size error frees the model and leaves it reading what is on disk, so its row keeps a button
    // (#191's gate adversary): not refused as in flight, and not Downloading, with no rescan.
    let after = m.get_model_info("gemma4:e2b").await.unwrap().status;
    assert_eq!(after, ModelStatus::NotDownloaded, "after the size error the row reads {after:?}");
    let again = m.download_model_detailed("gemma4:e2b", None).await.expect_err("10 bytes were taken the second time").to_string();
    assert!(!again.contains("already in progress"), "the second download was refused as in flight: {again}");
    assert_eq!(s.requests.lock().unwrap().len(), 2, "the second download made no request");
    // The projector, with whole-length weights at the final path (sparse), which the window skips.
    let dir = tempfile::tempdir().unwrap();
    let _serial = SPARSE.lock().await;
    std::fs::File::create(dir.path().join(&e2b.gguf_file)).unwrap().set_len(e2b.weights.size_bytes).unwrap();
    let s = stub(Reply::Body(b"GGUF012345".to_vec())).await;
    let m = ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap().with_base_url(&s.base);
    let e = m.download_model_detailed("gemma4:e2b", None).await.expect_err("10 bytes were taken for the projector").to_string();
    assert_eq!(
        s.requests.lock().unwrap().clone(),
        vec![format!("GET /{}/resolve/{}/{} HTTP/1.1", proj.pin.repo, proj.pin.revision, proj.file)],
        "the projector's request line, and no request for the whole weights"
    );
    assert!(e.contains(&format!("not the {} its pin expects", proj.pin.size_bytes)), "the projector did not end in its size error: {e}");
}

/// The tests that make whole-length E2B files take turns: on NTFS `set_len` reserves the whole length.
static SPARSE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// #191 condition 4, startup: a temporary file naming no current pin is removed, and nothing else is.
#[tokio::test]
async fn startup_removes_only_temporary_files_of_no_current_pin() {
    let dir = tempfile::tempdir().unwrap();
    let models = get_available_models();
    let mut keep = Vec::new();
    for m in &models {
        std::fs::write(dir.path().join(&m.gguf_file), b"").unwrap();
        keep.push(m.gguf_file.clone());
        if let Some(p) = &m.mmproj {
            std::fs::write(dir.path().join(&p.file), b"").unwrap();
            keep.push(p.file.clone());
        }
    }
    let e2b = get_model_by_name("gemma4:e2b").unwrap();
    let proj = e2b.mmproj.clone().unwrap();
    for name in [partial_name(&e2b.weights.sha256, &e2b.gguf_file), partial_name(&proj.pin.sha256, &proj.file), "notes.txt".to_string()] {
        std::fs::write(dir.path().join(&name), b"x").unwrap();
        keep.push(name);
    }
    // LFM2.5 as fetched before 2026-08-19 12:42Z: a pin no row names any more.
    let stale = partial_name(&format!("79fdf003{}", "0".repeat(56)), "LFM2.5-2.6B-Q4_K_M.gguf");
    std::fs::write(dir.path().join(&stale), b"x").unwrap();
    ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap().init().await.unwrap();
    keep.sort();
    assert_eq!(names(dir.path()), keep, "startup removed something other than the temporary file of no current pin");
}

/// The census: no final filename looks like a temporary file, which startup would then remove.
#[test]
fn no_model_file_is_named_like_a_temporary_file() {
    let clash: Vec<String> = get_available_models()
        .into_iter()
        .flat_map(|m| std::iter::once(m.gguf_file.clone()).chain(m.mmproj.map(|p| p.file)))
        .filter(|f| parse_partial_name(f).is_some() || f.starts_with(PARTIAL_PREFIX))
        .collect();
    assert_eq!(clash, Vec::<String>::new());
}

// ---- condition 5: a resume that fails its check is fetched once from zero -----------------------------

#[tokio::test]
async fn a_resume_of_other_bytes_is_discarded_and_fetched_once_from_zero() {
    // Fixture A: a head that differs from the pinned bytes, a stub that honours the Range.
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    let t = target(&s, &body(), 0);
    let mut head = body()[..5000].to_vec();
    head[100] ^= 1;
    std::fs::write(dir.path().join(partial_name(&t.pin.sha256, FILE)), &head).unwrap();
    fetch(&m, &t).await.expect("the from-zero retry did not keep the pinned bytes");
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), body(), "a splice is at the final path");
    assert_eq!(ranges(&s), vec![Some("bytes=5000-".to_string()), None], "not one ranged and one full request");
}

#[tokio::test]
async fn a_server_serving_other_bytes_fails_after_one_resume_and_one_retry() {
    // Fixture B: the pinned head, and a stub that serves other bytes to every request.
    let dir = tempfile::tempdir().unwrap();
    let mut wrong = body();
    wrong[8000] ^= 1;
    let s = stub(Reply::Ranged(wrong)).await;
    let m = manager(dir.path(), &s);
    let t = target(&s, &body(), 0);
    std::fs::write(dir.path().join(partial_name(&t.pin.sha256, FILE)), &body()[..5000]).unwrap();
    let e = tokio::time::timeout(Duration::from_secs(20), fetch(&m, &t)).await.expect("still retrying at 20 s").expect_err("other bytes were kept").to_string();
    assert!(e.contains("hashes to"), "not the hash error: {e}");
    assert_eq!(ranges(&s), vec![Some("bytes=5000-".to_string()), None], "not exactly one ranged and one full request");
    assert_eq!(names(dir.path()), Vec::<String>::new(), "a file is left at either path");
}

// ---- condition 6: what an earlier build left at the final path ----------------------------------------

#[tokio::test]
async fn an_earlier_builds_partial_at_the_final_path_is_moved_and_resumed() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    // 5000 bytes under a 10 MiB window: an earlier build's partial.
    std::fs::write(dir.path().join(FILE), &body()[..5000]).unwrap();
    fetch(&m, &target(&s, &body(), 10)).await.expect("the moved partial was not resumed into the pin");
    assert_eq!(ranges(&s), vec![Some("bytes=5000-".to_string())], "not exactly one request, ranged from the partial's length");
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), body());
    assert_eq!(partials(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn an_undersized_projector_beside_whole_weights_reads_corrupted() {
    let _serial = SPARSE.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let e2b = get_model_by_name("gemma4:e2b").unwrap();
    let proj = e2b.mmproj.clone().unwrap();
    std::fs::File::create(dir.path().join(&e2b.gguf_file)).unwrap().set_len(e2b.weights.size_bytes).unwrap();
    std::fs::write(dir.path().join(&proj.file), b"G").unwrap();
    let m = ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
    m.scan_models().await.unwrap();
    let status = m.get_model_info("gemma4:e2b").await.unwrap().status;
    assert!(matches!(status, ModelStatus::Corrupted { file_size: 0, .. }), "a 1-byte projector beside whole weights reads {status:?}");
}

// ---- condition 7: a file the window reads whole is never replaced -------------------------------------

#[tokio::test]
async fn a_file_the_window_reads_whole_is_left_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Ranged(body())).await;
    let m = manager(dir.path(), &s);
    let path = dir.path().join(FILE);
    std::fs::write(&path, b"GGUF held by the sidecar").unwrap();
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&path).unwrap());
    fetch(&m, &target(&s, &body(), 0)).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"GGUF held by the sidecar", "its bytes changed");
    #[cfg(unix)]
    assert_eq!(std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&path).unwrap()), inode, "it was replaced");
    assert_eq!(ranges(&s), Vec::<Option<String>>::new(), "it was requested");
}

// ---- condition 8: no screen changes --------------------------------------------------------------------

#[tokio::test]
async fn a_cancelled_or_partial_model_reads_corrupted_and_a_delete_leaves_nothing() {
    let _serial = SPARSE.lock().await;
    let e2b = get_model_by_name("gemma4:e2b").unwrap();
    let proj = e2b.mmproj.clone().unwrap();
    let mut fails = Vec::new();

    // A cancel mid-weights.
    let dir = tempfile::tempdir().unwrap();
    let s = stub(Reply::Slow { body: body(), chunk: 1000, delay: Duration::from_millis(200) }).await;
    let m = std::sync::Arc::new(ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap().with_base_url(&s.base));
    m.scan_models().await.unwrap();
    let running = tokio::spawn({ let m = m.clone(); async move { m.download_model_detailed("gemma4:e2b", None).await } });
    for _ in 0..100 {
        if s.sent.load(Ordering::SeqCst) >= 2000 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    m.cancel_download("gemma4:e2b").await.unwrap();
    let r = tokio::time::timeout(Duration::from_secs(10), running).await.expect("still running at 10 s").unwrap();
    if !r.as_ref().is_err_and(|e| e.to_string().starts_with("CANCELLED")) {
        fails.push(format!("the cancel returned {r:?}"));
    }
    m.scan_models().await.unwrap();
    let status = m.get_model_info("gemma4:e2b").await.unwrap().status;
    if !matches!(status, ModelStatus::Corrupted { file_size: 0, .. }) {
        fails.push(format!("after a cancel mid-weights the row reads {status:?}, not Corrupted with the temporary file's 0 MiB"));
    }
    m.delete_model("gemma4:e2b").await.unwrap();
    if !names(dir.path()).is_empty() {
        fails.push(format!("after the cancel a delete left {:?}", names(dir.path())));
    }

    // Whole weights and a projector's temporary file.
    let dir = tempfile::tempdir().unwrap();
    std::fs::File::create(dir.path().join(&e2b.gguf_file)).unwrap().set_len(e2b.weights.size_bytes).unwrap();
    std::fs::write(dir.path().join(partial_name(&proj.pin.sha256, &proj.file)), b"GGUF").unwrap();
    let m = ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
    m.scan_models().await.unwrap();
    let status = m.get_model_info("gemma4:e2b").await.unwrap().status;
    if !matches!(status, ModelStatus::Corrupted { file_size: 0, .. }) {
        fails.push(format!("with a projector's temporary file the row reads {status:?}, not Corrupted with its 0 MiB"));
    }
    m.delete_model("gemma4:e2b").await.unwrap();
    if !names(dir.path()).is_empty() {
        fails.push(format!("with a projector's temporary file a delete left {:?}", names(dir.path())));
    }

    // No weights at all, and a projector's temporary file.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(partial_name(&proj.pin.sha256, &proj.file)), b"GGUF").unwrap();
    let m = ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
    m.scan_models().await.unwrap();
    let status = m.get_model_info("gemma4:e2b").await.unwrap().status;
    if !matches!(status, ModelStatus::Corrupted { file_size: 0, .. }) {
        fails.push(format!("with only a projector's temporary file the row reads {status:?}, not Corrupted"));
    }

    // An Available model.
    let dir = tempfile::tempdir().unwrap();
    std::fs::File::create(dir.path().join(&e2b.gguf_file)).unwrap().set_len(e2b.weights.size_bytes).unwrap();
    std::fs::File::create(dir.path().join(&proj.file)).unwrap().set_len(proj.pin.size_bytes).unwrap();
    let m = ModelManager::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
    m.scan_models().await.unwrap();
    let status = m.get_model_info("gemma4:e2b").await.unwrap().status;
    if status != ModelStatus::Available {
        fails.push(format!("whole files read {status:?}, not Available"));
    }
    m.delete_model("gemma4:e2b").await.unwrap();
    if !names(dir.path()).is_empty() {
        fails.push(format!("an Available model's delete left {:?}", names(dir.path())));
    }
    assert!(fails.is_empty(), "condition 8:\n{}", fails.join("\n"));
}

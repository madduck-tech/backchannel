//! Where an agent CLI lives, found the way Orca finds it. (#212)
//!
//! An application started from a desktop menu inherits a short `PATH`, without `~/.local/bin` or
//! an nvm directory, so a CLI the person runs every day in a terminal can look absent to it. Orca
//! asks the person's login shell, and so does this:
//!
//! 1. `$SHELL -ilc` printing `PATH` between two markers, with stdin closed, ANSI codes stripped, a
//!    10 s limit and the shell's whole process group killed afterwards (an rc file may start a
//!    process that holds stdout open), cached for the life of the application;
//! 2. then the application's own `PATH`;
//! 3. then the directories these CLIs install into.
//!
//! Windows has no `$SHELL`, so there it is steps 2 and 3 only. // UNVERIFIED on macOS and Windows

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const MARK: &str = "__BC_SHELL_PATH__";
const SHELL_LIMIT: Duration = Duration::from_secs(10);

/// Which of the three places a binary was found in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Source {
    LoginShell,
    ProcessPath,
    KnownDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    pub source: Source,
}

/// What discovery reads from the world, injected so it can be tested.
pub struct World {
    pub home: PathBuf,
    /// The login shell's `PATH`, already probed (or `None`).
    pub login_path: Option<String>,
    pub process_path: Option<OsString>,
}

impl World {
    /// The real one: the person's home, the probed login shell (cached), and this process's `PATH`.
    pub fn current() -> Self {
        static LOGIN: OnceLock<Option<String>> = OnceLock::new();
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
        let login_path = LOGIN
            .get_or_init(|| std::env::var_os("SHELL").and_then(|sh| login_shell_path(Path::new(&sh), SHELL_LIMIT)))
            .clone();
        World { home, login_path, process_path: std::env::var_os("PATH") }
    }
}

/// The directories these CLIs install into when the shell does not say.
pub fn known_directories(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".npm-global/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The file name a binary has on disk. On Windows only a native `.exe` is looked for: an npm `.cmd`
/// shim needs `cmd.exe` to run it, and the Codex call's arguments carry quotes and newlines that a
/// batch file cannot be handed safely. UNVERIFIED on Windows.
fn file_name(binary: &str) -> String {
    if cfg!(windows) { format!("{binary}.exe") } else { binary.to_string() }
}

/// The first executable `binary` in `dirs`. A relative entry is skipped: it names a directory
/// relative to wherever the call happens to run, which is an empty one made for it (#212 round 2,
/// measured: `relbin:` in the login `PATH` was found and then could not be started).
fn first_in(dirs: impl IntoIterator<Item = PathBuf>, binary: &str) -> Option<PathBuf> {
    let name = file_name(binary);
    dirs.into_iter().filter(|d| d.is_absolute()).map(|d| d.join(&name)).find(|p| is_executable(p))
}

/// The first executable `binary`, in the order the module comment gives.
pub fn find(binary: &str, world: &World) -> Option<Found> {
    if let Some(path) = world.login_path.as_deref().and_then(|p| first_in(std::env::split_paths(p), binary)) {
        return Some(Found { path, source: Source::LoginShell });
    }
    if let Some(path) = world.process_path.as_ref().and_then(|p| first_in(std::env::split_paths(p), binary)) {
        return Some(Found { path, source: Source::ProcessPath });
    }
    first_in(known_directories(&world.home), binary).map(|path| Found { path, source: Source::KnownDirectory })
}

/// `PATH` from between the markers, with ANSI escape sequences stripped. An rc file may print
/// anything before or after; only what is between the markers is the answer.
pub fn between_markers(out: &str) -> Option<String> {
    let clean = strip_ansi(out);
    let start = clean.find(MARK)? + MARK.len();
    let end = clean[start..].find(MARK)? + start;
    let path = clean[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

fn strip_ansi(s: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07").unwrap())
        .replace_all(s, "")
        .into_owned()
}

/// Ask the login shell for its `PATH`, within `limit`.
///
/// The shell runs in its own process group, which is killed whatever happens: an rc file can start
/// a background process that keeps stdout open, and waiting for end-of-file would then wait
/// forever. The answer is read as soon as both markers have arrived.
#[cfg(unix)]
pub fn login_shell_path(shell: &Path, limit: Duration) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("BC_SHELL_PATH_PROBE", "1")
        .process_group(0)
        .spawn()
        .ok()?;
    let pgid = child.id() as i32;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).into_owned();
            if text.matches(MARK).count() >= 2 {
                let _ = tx.send(text);
                return;
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    let answer = rx.recv_timeout(limit).ok();
    // SAFETY: a plain signal to the process group this function created.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.wait();
    answer.as_deref().and_then(between_markers)
}

#[cfg(not(unix))]
pub fn login_shell_path(_shell: &Path, _limit: Duration) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The adversary's case (#212 round 2): `relbin:` in the login `PATH`, with an executable
    /// `claude` in `relbin/` beside the current directory. It was found as `relbin/claude`, which the
    /// call, run in an empty directory of its own, could not start.
    #[cfg(unix)]
    #[test]
    fn a_relative_path_entry_is_not_searched() {
        let rel = format!("bc-relbin-{}", std::process::id());
        let dir = std::env::current_dir().unwrap().join(&rel);
        std::fs::create_dir_all(&dir).unwrap();
        exe(&dir, "claude", true);
        let world = World { home: PathBuf::from("/nonexistent-home"), login_path: Some(format!("{rel}:/nonexistent-bin")), process_path: None };
        let found = find("claude", &world);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(found, None);
    }

    fn exe(dir: &Path, name: &str, executable: bool) -> PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(f, "#!/bin/sh\nexit 0").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 })).unwrap();
        }
        p
    }

    fn world(home: &Path, login: Option<&Path>, process: Option<&Path>) -> World {
        World {
            home: home.to_path_buf(),
            login_path: login.map(|p| p.display().to_string()),
            process_path: process.map(|p| p.as_os_str().to_owned()),
        }
    }

    #[test]
    fn a_cli_only_the_login_shell_knows_is_found_there() {
        let t = tempfile::tempdir().unwrap();
        let shell_dir = t.path().join("nvm/bin");
        std::fs::create_dir_all(&shell_dir).unwrap();
        let claude = exe(&shell_dir, "claude", true);
        let found = find("claude", &world(t.path(), Some(&shell_dir), Some(&t.path().join("empty"))));
        assert_eq!(found, Some(Found { path: claude, source: Source::LoginShell }));
    }

    #[test]
    fn the_process_path_and_then_the_known_directories_follow() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("p");
        std::fs::create_dir_all(&p).unwrap();
        let codex = exe(&p, "codex", true);
        assert_eq!(find("codex", &world(t.path(), None, Some(&p))), Some(Found { path: codex, source: Source::ProcessPath }));
        let local = t.path().join(".local/bin");
        std::fs::create_dir_all(&local).unwrap();
        let claude = exe(&local, "claude", true);
        assert_eq!(find("claude", &world(t.path(), None, None)), Some(Found { path: claude, source: Source::KnownDirectory }));
    }

    #[test]
    fn absent_everywhere_and_not_executable_are_not_found() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("d");
        std::fs::create_dir_all(&d).unwrap();
        exe(&d, "claude", false);
        assert_eq!(find("claude", &world(t.path(), Some(&d), Some(&d))), None);
        assert_eq!(find("codex", &world(t.path(), Some(&d), Some(&d))), None);
    }

    #[test]
    fn only_what_is_between_the_markers_is_the_path() {
        let noise = format!("Welcome!\n\x1b[1;32mfortune\x1b[0m\n{MARK}/a/bin:/b/bin{MARK}\nbye\n");
        assert_eq!(between_markers(&noise), Some("/a/bin:/b/bin".to_string()));
        assert_eq!(between_markers("PATH=/a/bin with no markers"), None);
        assert_eq!(between_markers(&format!("{MARK}\x1b[0m/c/bin{MARK}")), Some("/c/bin".to_string()));
    }

    /// A fake login shell: an rc file's noise, then the probe's own command.
    #[cfg(unix)]
    fn fake_shell(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("fakesh");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn the_login_shell_is_read_through_rc_noise() {
        let t = tempfile::tempdir().unwrap();
        // `$2` is the probe's command; `sh -c` runs it after printing what an rc file might.
        let sh = fake_shell(t.path(), "echo 'motd: hello'; PATH=/fake/one:/fake/two; export PATH; /bin/sh -c \"$2\"; echo trailing");
        assert_eq!(login_shell_path(&sh, Duration::from_secs(5)), Some("/fake/one:/fake/two".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_shell_is_cut_off_by_the_limit() {
        let t = tempfile::tempdir().unwrap();
        let sh = fake_shell(t.path(), "sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(login_shell_path(&sh, Duration::from_millis(500)), None);
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    /// An rc file that starts a background process holding stdout open: the answer is taken when
    /// both markers have arrived, not at end-of-file, and the group is killed.
    #[cfg(unix)]
    #[test]
    fn a_grandchild_holding_stdout_open_does_not_hold_the_answer() {
        let t = tempfile::tempdir().unwrap();
        let sh = fake_shell(t.path(), "(sleep 30 &); PATH=/g/bin; export PATH; /bin/sh -c \"$2\"; sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(login_shell_path(&sh, Duration::from_secs(5)), Some("/g/bin".to_string()));
        assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
    }
}

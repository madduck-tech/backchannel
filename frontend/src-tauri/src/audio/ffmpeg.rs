use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    paths::sidecar_dir,
    version::ffmpeg_version,
};
use log::{debug, error};
use std::sync::RwLock;
use std::path::PathBuf;
use which::which;

#[cfg(not(windows))]
const EXECUTABLE_NAME: &str = "ffmpeg";

#[cfg(windows)]
const EXECUTABLE_NAME: &str = "ffmpeg.exe";

/// The resolved location, or `None` inside the outer option when nothing has resolved yet.
///
/// A lock rather than a `Lazy`: `ensure_ffmpeg_installed` has to be able to replace a
/// cached "not found" with the path it just installed, and a `Lazy` remembers the first
/// answer forever.
static FFMPEG_PATH: RwLock<Option<Option<PathBuf>>> = RwLock::new(None);

fn cache_path(path: Option<PathBuf>) {
    if let Ok(mut slot) = FFMPEG_PATH.write() {
        *slot = Some(path);
    }
}

/// Where ffmpeg is, if it is anywhere this machine can already see.
///
/// **Discovery only. This never downloads anything.** It used to: the search fell through
/// into an installer that fetches ~80 MB from a third-party host, so any test touching an
/// encode or decode path performed a network download and a required CI check became a coin
/// flip (#29). Installing is `ensure_ffmpeg_installed`, and a caller has to ask for it.
pub fn find_ffmpeg_path() -> Option<PathBuf> {
    if let Ok(slot) = FFMPEG_PATH.read() {
        if let Some(cached) = slot.as_ref() {
            return cached.clone();
        }
    }
    let found = find_ffmpeg_path_internal();
    cache_path(found.clone());
    found
}

fn find_ffmpeg_path_internal() -> Option<PathBuf> {
    debug!("Starting search for ffmpeg executable");

    // ============================================================
    // PRIORITY 1: Bundled Binary (Production)
    // ============================================================
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_folder) = exe_path.parent() {
            let bundled = exe_folder.join(EXECUTABLE_NAME);
            if bundled.exists() && bundled.is_file() {
                debug!("Found bundled ffmpeg: {:?}", bundled);
                return Some(bundled);
            }
        }
    }


    // ============================================================
    // PRIORITY 2: Fallback to Existing Logic
    // ============================================================

    // Check if `ffmpeg` is in the PATH environment variable
    if let Ok(path) = which(EXECUTABLE_NAME) {
        debug!("Found ffmpeg in PATH: {:?}", path);
        return Some(path);
    }
    debug!("ffmpeg not found in PATH");

    // Check in $HOME/.local/bin on macOS
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let local_bin = PathBuf::from(home).join(".local").join("bin");
            debug!("Checking $HOME/.local/bin: {:?}", local_bin);
            let ffmpeg_in_local_bin = local_bin.join(EXECUTABLE_NAME);
            if ffmpeg_in_local_bin.exists() {
                debug!("Found ffmpeg in $HOME/.local/bin: {:?}", ffmpeg_in_local_bin);
                return Some(ffmpeg_in_local_bin);
            }
            debug!("ffmpeg not found in $HOME/.local/bin");
        }
    }

    // Check in current working directory
    if let Ok(cwd) = std::env::current_dir() {
        debug!("Current working directory: {:?}", cwd);
        let ffmpeg_in_cwd = cwd.join(EXECUTABLE_NAME);
        if ffmpeg_in_cwd.is_file() && ffmpeg_in_cwd.exists() {
            debug!(
                "Found ffmpeg in current working directory: {:?}",
                ffmpeg_in_cwd
            );
            return Some(ffmpeg_in_cwd);
        }
        debug!("ffmpeg not found in current working directory");
    }

    // Check in the same folder as the executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_folder) = exe_path.parent() {
            debug!("Executable folder: {:?}", exe_folder);

            // Platform-specific checks
            #[cfg(target_os = "macos")]
            {
                let resources_folder = exe_folder.join("../Resources");
                debug!("Resources folder: {:?}", resources_folder);
                let ffmpeg_in_resources = resources_folder.join(EXECUTABLE_NAME);
                if ffmpeg_in_resources.exists() {
                    debug!(
                        "Found ffmpeg in Resources folder: {:?}",
                        ffmpeg_in_resources
                    );
                    return Some(ffmpeg_in_resources);
                }
                debug!("ffmpeg not found in Resources folder");
            }

            #[cfg(target_os = "linux")]
            {
                let lib_folder = exe_folder.join("lib");
                debug!("Lib folder: {:?}", lib_folder);
                let ffmpeg_in_lib = lib_folder.join(EXECUTABLE_NAME);
                if ffmpeg_in_lib.exists() {
                    debug!("Found ffmpeg in lib folder: {:?}", ffmpeg_in_lib);
                    return Some(ffmpeg_in_lib);
                }
                debug!("ffmpeg not found in lib folder");
            }
        }
    }

    // Discovery ends here.
    //
    // It used to continue into `handle_ffmpeg_installation()`, which resolves a URL and
    // fetches ~80 MB from a third-party host (gyan.dev / evermeet.cx / johnvansickle.com),
    // unverified. That is a reasonable thing for an application to offer a user and a
    // catastrophic thing for `cargo test` to do on its own: any test reaching an encode or
    // decode path performed a network download, which is why
    // `test_checkpoint_creation` failed once in CI and passed on a rerun of the same tree
    // (#29). Measured: with the binary deleted and `ffmpeg` off `PATH`, one `cargo test`
    // invocation wrote 79,826,272 bytes to `target/debug/ffmpeg`.
    //
    // So discovery discovers. Installing is `install_ffmpeg()` below, and only a caller
    // that has decided to install calls it.
    debug!("ffmpeg not found by discovery");
    None
}

/// Discover ffmpeg and, only if it is genuinely absent, download and install it.
///
/// The installing half of what `find_ffmpeg_path` used to do, separated because the two
/// have different callers and only one of them is safe to reach by accident. Call this
/// once, deliberately, from a place that has decided a download is acceptable — never from
/// an encode or a decode, and never from a test.
pub fn ensure_ffmpeg_installed() -> Result<PathBuf, anyhow::Error> {
    if let Some(found) = find_ffmpeg_path() {
        return Ok(found);
    }

    handle_ffmpeg_installation()?;

    // Re-discover from scratch: the cached answer above is the pre-install one.
    if let Some(found) = resolve_after_install() {
        cache_path(Some(found.clone()));
        return Ok(found);
    }
    Err(anyhow::anyhow!("ffmpeg not found even after installation"))
}

fn resolve_after_install() -> Option<PathBuf> {
    if let Ok(path) = which(EXECUTABLE_NAME) {
        debug!("found ffmpeg after installation: {:?}", path);
        return Some(path);
    }

    let installation_dir = match sidecar_dir() {
        Ok(dir) => dir,
        Err(e) => {
            error!("could not resolve the sidecar directory: {e}");
            return None;
        }
    };
    let ffmpeg_in_installation = installation_dir.join(EXECUTABLE_NAME);
    if ffmpeg_in_installation.is_file() {
        debug!("found ffmpeg in directory: {:?}", ffmpeg_in_installation);
        return Some(ffmpeg_in_installation);
    }

    // Windows often has nested structure like ffmpeg-6.0-full_build/bin/ffmpeg.exe
    #[cfg(windows)]
    {
        debug!("Searching for nested ffmpeg in {:?}", installation_dir);
        if let Ok(entries) = std::fs::read_dir(&installation_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    // Check bin/ffmpeg.exe
                    let bin_ffmpeg = path.join("bin").join(EXECUTABLE_NAME);
                    if bin_ffmpeg.exists() {
                        debug!("found ffmpeg in nested bin: {:?}", bin_ffmpeg);
                        return Some(bin_ffmpeg);
                    }
                    // Check root of subdir
                    let root_ffmpeg = path.join(EXECUTABLE_NAME);
                    if root_ffmpeg.exists() {
                        debug!("found ffmpeg in nested root: {:?}", root_ffmpeg);
                        return Some(root_ffmpeg);
                    }
                }
            }
        }
    }

    error!("ffmpeg not found even after installation");
    None // Return None if ffmpeg is not found
}

fn handle_ffmpeg_installation() -> Result<(), anyhow::Error> {
    if ffmpeg_is_installed() {
        debug!("ffmpeg is already installed");
        return Ok(());
    }

    debug!("ffmpeg not found. installing...");
    match check_latest_version() {
        Ok(version) => debug!("latest version: {}", version),
        Err(e) => debug!("skipping version check due to error: {e}"),
    }

    let download_url = ffmpeg_download_url()?;
    let destination = get_ffmpeg_install_dir()?;

    debug!("downloading from: {:?}", download_url);
    let archive_path = download_ffmpeg_package(download_url, &destination)?;
    debug!("downloaded package: {:?}", archive_path);

    debug!("extracting...");
    unpack_ffmpeg(&archive_path, &destination)?;

    let version = ffmpeg_version()?;

    debug!("done! installed ffmpeg version {}", version);
    Ok(())
}

#[cfg(target_os = "macos")]
fn get_ffmpeg_install_dir() -> Result<PathBuf, anyhow::Error> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("couldn't find home directory"))?;

    let local_bin = home.join(".local").join("bin");

    // Create directory if it doesn't exist
    if !local_bin.exists() {
        debug!("creating .local/bin directory");
        std::fs::create_dir_all(&local_bin)?;

        // Check both .bashrc and .zshrc
        let shell_configs = vec![
            home.join(".bashrc"),
            home.join(".bash_profile"), // macOS often uses .bash_profile instead of .bashrc
            home.join(".zshrc"),
        ];

        for config in shell_configs {
            if config.exists() {
                let content = std::fs::read_to_string(&config)?;
                if !content.contains(".local/bin") {
                    debug!("adding .local/bin to PATH in {:?}", config);
                    std::fs::write(
                        config,
                        format!("{}\nexport PATH=\"$HOME/.local/bin:$PATH\"\n", content),
                    )?;
                }
            }
        }
    }

    Ok(local_bin)
}

// For other platforms, keep your existing installation directory logic
#[cfg(not(target_os = "macos"))]
fn get_ffmpeg_install_dir() -> Result<PathBuf, anyhow::Error> {
    // Your existing logic for other platforms
    sidecar_dir().map_err(|e| anyhow::anyhow!(e))
}

//! The command each agent CLI is run with, and running it. (#212)
//!
//! Every flag here is part of the safety the module comment describes, and each is pinned by a test
//! that is red when it is removed. What the flags *do* is held by the real-CLI instruments in
//! `real.rs`, which ask each CLI to read, write, search and look, and check none of it happened.

use super::{parse, AgentCli, AgentError};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// One call's limit: the existing HTTP providers' timeout. The instrument records what a pass takes.
pub const TIMEOUT: Duration = Duration::from_secs(300);

/// After the CLI exits, how long a process it left behind may keep its output open before what has
/// arrived is read as the answer. A detached descendant holding stdout must not hold the summary.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// The Codex features left as they are, by exact name: reaching the provider through a proxy,
/// compressing and retrying its requests, masking credentials in output, and the Windows sandbox.
/// Every other feature is turned off for the run (#212 rounds 2 and 3).
///
/// A list of what to turn off was tried first and was not enough, measured 2026-10-25: Codex has
/// tools that leave no event in `--json` (`view_image`, a sub-agent spawn), a web search that is not
/// a feature at all, and more each release. Turning off everything it lists means a tool added in a
/// later version is off in that version too, and a feature the call turns out to need fails the
/// summary loudly instead. Names, not patterns: a pattern would keep a future
/// `guardian_conversation_history_tools` on for having the right prefix.
const CODEX_FEATURES_KEPT: [&str; 6] = [
    "system_proxy_fallback", "respect_system_proxy", "enable_request_compression", "unbounded_connection_retries", "credential_masking", "windows_sandbox_service",
];

fn codex_feature_kept(name: &str) -> bool {
    CODEX_FEATURES_KEPT.contains(&name)
}

/// The features to turn off, read from `codex features list`: every row except removed and
/// deprecated ones (a removed name does nothing and a deprecated one prints a warning into the
/// stream) and the kept ones. `None` when the listing has no `shell_tool` row: a listing this cannot
/// read is not a reason to run Codex with its tools on.
pub fn codex_features_to_disable(listing: &str) -> Option<Vec<String>> {
    let mut off = Vec::new();
    let mut read_it = false;
    for line in listing.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (Some(name), Some(last)) = (cols.first(), cols.last()) else { continue };
        if cols.len() < 3 || !matches!(*last, "true" | "false") || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            continue;
        }
        let stage = cols[1..cols.len() - 1].join(" ");
        read_it |= *name == "shell_tool";
        if stage == "removed" || stage == "deprecated" || codex_feature_kept(name) {
            continue;
        }
        off.push(name.to_string());
    }
    read_it.then_some(off)
}

/// Every built-in tool denied by permission, on top of `--tools ""`. Not redundant: Claude Code
/// itself reads a file named as `@/path` in the prompt and attaches it before the model runs, with
/// no tool event and `tools: []` in the start-up event (#212 round 3, measured: the file was opened
/// five times and its contents came back in the summary). A `Read` deny is what stops that read;
/// with this setting `strace` saw the file, a directory and `@~/.bashrc` opened zero times.
pub const CLAUDE_DENY_SETTINGS: &str = r#"{"permissions":{"deny":["Read","Write","Edit","Bash","WebFetch","WebSearch","Glob","Grep","NotebookEdit"]}}"#;

/// `claude -p` with every tool off and denied, no MCP server, no customisation, no session, and
/// structured output. The system prompt is a file: one argument is capped at 131 071 bytes on Linux.
pub fn claude_args(system_prompt_file: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["-p", "--tools", "", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--settings", CLAUDE_DENY_SETTINGS, "--output-format", "stream-json", "--verbose", "--system-prompt-file"]
        .iter()
        .map(OsString::from)
        .collect();
    a.push(system_prompt_file.as_os_str().to_owned());
    a
}

/// Codex's model list with the sub-agent version taken out of every model, from the one Codex keeps
/// at `models_cache.json`. A model whose catalog entry carries `multi_agent_version` is given
/// `spawn_agent` and its siblings whatever the features say, and a spawn leaves no event in `--json`
/// (#212 round 3, measured: a sub-agent ran a model turn of its own; with this catalog the tool is
/// gone). Only `models` is kept: the cache also holds an identity string the run has no use for.
/// `None` when there is no model list to read.
pub fn codex_catalog_without_sub_agents(cache: &str) -> Option<String> {
    fn strip(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::Object(m) => {
                m.remove("multi_agent_version");
                m.values_mut().for_each(strip);
            }
            serde_json::Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let parsed: serde_json::Value = serde_json::from_str(cache).ok()?;
    let mut models = parsed.get("models")?.clone();
    if models.as_array().is_none_or(|a| a.is_empty()) {
        return None;
    }
    strip(&mut models);
    Some(serde_json::json!({ "models": models }).to_string())
}

#[cfg(test)]
thread_local! {
    /// A test's stand-in for Codex's home, so no test reads the person's.
    static TEST_CODEX_HOME: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Where Codex keeps its state: `CODEX_HOME`, or `~/.codex`.
fn codex_home() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(h) = TEST_CODEX_HOME.with(|h| h.borrow().clone()) {
        return Some(h);
    }
    std::env::var_os("CODEX_HOME").map(Into::into).or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
}

/// Write Codex's catalog without sub-agents into `dir`, and say where. A Codex with no model list to
/// read is not run.
pub(crate) fn codex_catalog_file(dir: &Path) -> Result<std::path::PathBuf, AgentError> {
    let cli = AgentCli::Codex;
    let derived = codex_home()
        .map(|h| h.join("models_cache.json"))
        .and_then(|c| std::fs::read_to_string(c).ok())
        .and_then(|c| codex_catalog_without_sub_agents(&c))
        .ok_or(AgentError::Failed { cli, message: "its model list could not be read, so it was not run (run codex once in a terminal, then try again)".into() })?;
    let file = dir.join("models.json");
    std::fs::write(&file, derived).map_err(|e| AgentError::Spawn { cli, message: e.to_string() })?;
    Ok(file)
}

/// `codex exec` with the person's config and rules ignored, a read-only sandbox, no session,
/// structured output, `disabled` features off, web search off, no project instructions looked for
/// above the working directory, no skills, the system prompt as `developer_instructions`, and the
/// prompt read from stdin (`-`).
///
/// Measured 2026-10-25, each without its flag: web search ran a live query (`web_search` is a
/// setting, not a feature); an `AGENTS.md` beside a `.git` in a parent directory, which on Linux can
/// be the shared `/tmp`, was followed (`project_root_markers`); the person's skills were listed to
/// the model (`skills.*`).
pub fn codex_args(system_prompt: &str, disabled: &[String], catalog: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["exec", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json"]
        .iter()
        .map(OsString::from)
        .collect();
    for f in disabled {
        a.push("--disable".into());
        a.push(f.into());
    }
    for c in ["web_search=\"disabled\"", "project_root_markers=[]", "skills.include_instructions=false", "skills.bundled.enabled=false"] {
        a.push("-c".into());
        a.push(c.into());
    }
    a.push("-c".into());
    a.push(format!("model_catalog_json={}", toml_basic_string(&catalog.to_string_lossy())).into());
    a.push("-c".into());
    a.push(format!("developer_instructions={}", toml_basic_string(system_prompt)).into());
    a.push("-".into());
    a
}

/// A TOML basic string: `-c` parses its value as TOML first, so the instructions must be quoted
/// and escaped, or a newline or a quote in a template would change what Codex is told.
pub fn toml_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Variables passed through by name.
const PASSED: [&str; 16] = [
    "HOME", "USER", "LOGNAME", "LANG", "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
];
/// Variables passed through by prefix: locale, and each vendor's routing and auth.
const PASSED_PREFIXES: [&str; 6] = ["LC_", "AWS_", "ANTHROPIC_", "GOOGLE_", "OPENAI_", "CLAUDE_CODE_USE_"];
/// The rest of what a login, a proxy or Windows needs.
const PASSED_MORE: [&str; 4] = ["CLOUD_ML_REGION", "SystemRoot", "USERPROFILE", "APPDATA"];

/// The child's whole environment: the listed variables from `from`, and `PATH` set to `path`.
/// Nothing else, so the application's own variables (an AppImage sets several) do not reach it.
pub fn environment(from: impl IntoIterator<Item = (OsString, OsString)>, path: &OsStr) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = from
        .into_iter()
        .filter(|(k, _)| {
            let k = k.to_string_lossy();
            PASSED.contains(&k.as_ref()) || PASSED_MORE.contains(&k.as_ref()) || PASSED_PREFIXES.iter().any(|p| k.starts_with(p))
        })
        .collect();
    env.push(("PATH".into(), path.to_owned()));
    env.sort();
    env
}

/// Run `cli` once: the user prompt on stdin, in a fresh empty directory, within `timeout`.
pub async fn run(
    cli: AgentCli,
    binary: &Path,
    child_path: &OsStr,
    system_prompt: &str,
    user_prompt: &str,
    cancel: Option<&CancellationToken>,
    timeout: Duration,
) -> Result<String, AgentError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let spawn_err = |e: std::io::Error| AgentError::Spawn { cli, message: e.to_string() };
    // The working directory stays empty; the system prompt lives in a directory of its own.
    let work = work_dir().map_err(spawn_err)?;
    let prompt_dir = work_dir().map_err(spawn_err)?;
    let args = match cli {
        AgentCli::ClaudeCode => {
            let file = prompt_dir.path().join("system.txt");
            std::fs::write(&file, system_prompt).map_err(spawn_err)?;
            claude_args(&file)
        }
        AgentCli::Codex => {
            let features = codex_features(binary, child_path).await?;
            codex_args(system_prompt, &features, &codex_catalog_file(prompt_dir.path())?)
        }
    };
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(&args)
        .current_dir(work.path())
        .env_clear()
        .envs(environment(std::env::vars_os(), child_path))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(spawn_err)?;
    let pid = child.id();

    let mut stdin = child.stdin.take().expect("stdin was piped");
    let prompt = user_prompt.to_owned();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        // Dropping it closes stdin, so a CLI that asks for more input reads end-of-file.
    });
    // Read into buffers the reader tasks share, so what has arrived can be taken without waiting for
    // an end-of-file a detached descendant may never send.
    let out_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let err_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    fn reader(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static, buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                buf.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        })
    }
    let out = reader(child.stdout.take().expect("stdout was piped"), out_buf.clone());
    let err = reader(child.stderr.take().expect("stderr was piped"), err_buf.clone());

    let never = CancellationToken::new();
    let cancel = cancel.unwrap_or(&never);
    let deadline = tokio::time::Instant::now() + timeout;
    let status = tokio::select! {
        s = child.wait() => s.map_err(spawn_err)?,
        _ = cancel.cancelled() => { stop(&mut child, pid).await; return Err(AgentError::Cancelled); }
        _ = tokio::time::sleep_until(deadline) => { stop(&mut child, pid).await; return Err(AgentError::TimedOut { cli, secs: timeout.as_secs() }); }
    };
    // The CLI has exited; anything it left behind in its group goes with it.
    kill_group(pid);
    let drained = async {
        let _ = out.await;
        let _ = err.await;
    };
    tokio::select! {
        _ = drained => {}
        _ = cancel.cancelled() => return Err(AgentError::Cancelled),
        _ = tokio::time::sleep(DRAIN_GRACE) => log::warn!("{} exited but something it started still holds its output; reading what arrived", cli.display_name()),
    }
    writer.abort();
    let stdout = String::from_utf8_lossy(&out_buf.lock().unwrap()).into_owned();
    let stderr = String::from_utf8_lossy(&err_buf.lock().unwrap()).into_owned();

    let parsed = match cli {
        AgentCli::ClaudeCode => parse::claude(&stdout),
        AgentCli::Codex => parse::codex(&stdout),
    };
    if status.success() {
        return parsed;
    }
    match parsed {
        Err(e @ (AgentError::Failed { .. } | AgentError::ToolUsed { .. })) => Err(e),
        _ => {
            let tail: String = stderr.trim().lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ");
            Err(AgentError::Failed {
                cli,
                message: if tail.is_empty() { format!("it exited with {status}") } else { tail },
            })
        }
    }
}

/// Whether the CLI is logged in, asked the CLI itself with the call's own environment.
///
/// `claude auth status` prints JSON with `loggedIn`; `codex login status` prints "Logged in …" or
/// "Not logged in". Codex's check reads `config.toml` and the call ignores it, so the two can
/// disagree; when they do, the call's own failure is what the person is told. `None` when the check
/// itself could not be run or read.
pub async fn logged_in(cli: AgentCli, binary: &Path, child_path: &OsStr) -> Option<bool> {
    let args: &[&str] = match cli {
        AgentCli::ClaudeCode => &["auth", "status"],
        AgentCli::Codex => &["login", "status"],
    };
    let work = work_dir().ok()?;
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args)
        .current_dir(work.path())
        .env_clear()
        .envs(environment(std::env::vars_os(), child_path))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output()).await.ok()?.ok()?;
    read_login(cli, &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr))
}

/// What a login check printed, read. Pure, so both CLIs' wordings are held by tests.
pub fn read_login(cli: AgentCli, stdout: &str, stderr: &str) -> Option<bool> {
    match cli {
        AgentCli::ClaudeCode => serde_json::from_str::<serde_json::Value>(stdout.trim()).ok()?["loggedIn"].as_bool(),
        AgentCli::Codex => {
            let all = format!("{stdout}\n{stderr}");
            if all.lines().any(|l| l.trim_start().starts_with("Not logged in")) {
                Some(false)
            } else if all.lines().any(|l| l.trim_start().starts_with("Logged in")) {
                Some(true)
            } else {
                None
            }
        }
    }
}

/// Which features this Codex has, asked of it with the call's own environment, and which of them
/// go off. A Codex that cannot say is not run.
pub(crate) async fn codex_features(binary: &Path, child_path: &OsStr) -> Result<Vec<String>, AgentError> {
    let cli = AgentCli::Codex;
    let work = work_dir().map_err(|e| AgentError::Spawn { cli, message: e.to_string() })?;
    let mut cmd = tokio::process::Command::new(binary);
    // An empty home of its own: the listing is the binary's, so a `config.toml` the run ignores
    // cannot break it (#212 round 3, measured: an unparsable config made it exit 1 with nothing).
    cmd.args(["features", "list"])
        .current_dir(work.path())
        .env_clear()
        .envs(environment(std::env::vars_os(), child_path))
        .env("CODEX_HOME", work.path())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| AgentError::TimedOut { cli, secs: 10 })?
        .map_err(|e| AgentError::Spawn { cli, message: e.to_string() })?;
    codex_features_to_disable(&String::from_utf8_lossy(&out.stdout)).ok_or(AgentError::Failed {
        cli,
        message: "it did not say which features it has, so it was not run with them on".into(),
    })
}

/// An empty directory for one run, under this user's cache rather than the shared temporary
/// directory: Codex looks for project instructions in the directories above its own, and on Linux
/// the one above a temporary directory is `/tmp`, which every local user can write to.
fn work_dir() -> std::io::Result<tempfile::TempDir> {
    let base = dirs::cache_dir().map(|c| c.join("backchannel").join("agent-runs"));
    match base {
        Some(b) if std::fs::create_dir_all(&b).is_ok() => tempfile::Builder::new().prefix("bc-agent-").tempdir_in(b),
        _ => tempfile::Builder::new().prefix("bc-agent-").tempdir(),
    }
}

/// Stop the CLI on a timeout or a cancel: its group on Unix, its tree on Windows, then reap it.
async fn stop(child: &mut tokio::process::Child, pid: Option<u32>) {
    let _ = child.start_kill();
    kill_group(pid);
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: a plain signal to the process group `run` created for this child.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    // UNVERIFIED on Windows: the tree, since a CLI started through node has children of its own.
    #[cfg(windows)]
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = pid;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The wordings measured on 2026-10-25: Claude's JSON, and Codex's two lines (the second with the
    /// warning it prints when it cannot write its PATH aliases).
    #[test]
    fn both_login_checks_are_read() {
        assert_eq!(read_login(AgentCli::ClaudeCode, "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}", ""), Some(true));
        assert_eq!(read_login(AgentCli::ClaudeCode, "{\"loggedIn\": false}", ""), Some(false));
        assert_eq!(read_login(AgentCli::ClaudeCode, "not json", ""), None);
        assert_eq!(read_login(AgentCli::Codex, "Logged in using ChatGPT\n", ""), Some(true));
        assert_eq!(read_login(AgentCli::Codex, "", "WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)\nNot logged in\n"), Some(false));
        assert_eq!(read_login(AgentCli::Codex, "something else", ""), None);
    }

    #[test]
    fn claude_is_run_with_every_tool_off_and_no_customisation() {
        let a: Vec<String> = claude_args(Path::new("/p/system.txt")).iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(
            a,
            ["-p", "--tools", "", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--settings", CLAUDE_DENY_SETTINGS, "--output-format", "stream-json", "--verbose", "--system-prompt-file", "/p/system.txt"]
        );
        let deny: serde_json::Value = serde_json::from_str(CLAUDE_DENY_SETTINGS).unwrap();
        let denied: Vec<&str> = deny["permissions"]["deny"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(denied.contains(&"Read"), "Read is what stops an @-mentioned file being attached");
    }

    #[test]
    fn codexs_catalog_loses_its_sub_agent_version_and_nothing_else() {
        let cache = r#"{"fetched_at":"x","identity":"someone","models":[{"slug":"m1","multi_agent_version":"v2","context_window":1},{"slug":"m2","nested":{"multi_agent_version":"v2"}}]}"#;
        let out: serde_json::Value = serde_json::from_str(&codex_catalog_without_sub_agents(cache).unwrap()).unwrap();
        assert_eq!(out, serde_json::json!({"models":[{"slug":"m1","context_window":1},{"slug":"m2","nested":{}}]}));
        assert_eq!(codex_catalog_without_sub_agents("{}"), None);
        assert_eq!(codex_catalog_without_sub_agents(r#"{"models":[]}"#), None);
        assert_eq!(codex_catalog_without_sub_agents("not json"), None);
    }

    #[test]
    fn codex_is_run_isolated_read_only_and_with_its_features_off() {
        let a: Vec<String> = codex_args("Write a summary.", &["shell_tool".into(), "view_image".into()], Path::new("/p/models.json")).iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(
            a,
            [
                "exec", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json",
                "--disable", "shell_tool", "--disable", "view_image",
                "-c", "web_search=\"disabled\"", "-c", "project_root_markers=[]", "-c", "skills.include_instructions=false",
                "-c", "skills.bundled.enabled=false", "-c", "model_catalog_json=\"/p/models.json\"", "-c", "developer_instructions=\"Write a summary.\"", "-",
            ]
        );
    }

    /// Codex 0.163.0's own listing (`tests/fixtures/agent_cli/codex-features.txt`, recorded 2026-10-25).
    #[test]
    fn every_codex_feature_goes_off_except_removed_deprecated_and_kept_ones() {
        let listing = fixture("codex-features.txt");
        let off = codex_features_to_disable(&listing).expect("the listing is read");
        for tool in ["shell_tool", "unified_exec", "view_image", "image_generation", "multi_agent", "memories", "plugins", "hooks", "code_mode_host", "browser_use", "computer_use", "apps", "in_app_browser", "skill_search"] {
            assert!(off.iter().any(|f| f == tool), "{tool} is left on");
        }
        // Off whether or not it is on by default: the listing reflects the person's config, and the run ignores it.
        assert!(off.iter().any(|f| f == "multi_agent_v2"), "a feature the listing shows as off is left alone");
        for kept in CODEX_FEATURES_KEPT {
            assert!(!off.iter().any(|f| f == kept), "{kept} is turned off");
        }
        // Off although their names look like safety: no tool runs, so nothing is left to approve.
        for off_too in ["guardian_approval", "write_stdin_approval", "network_proxy", "guardian_conversation_history_tools"] {
            assert!(off.iter().any(|f| f == off_too), "{off_too} is left on");
        }
        for not_passed in ["sqlite", "steer", "collaboration_modes", "web_search_cached", "use_legacy_landlock"] {
            assert!(!off.iter().any(|f| f == not_passed), "{not_passed}, removed or deprecated, is passed and Codex would refuse or warn");
        }
        assert_eq!(off.len(), listing.lines().filter(|l| { let c: Vec<&str> = l.split_whitespace().collect(); c.len() >= 3 && !l.contains(" removed ") && !l.contains(" deprecated ") && !codex_feature_kept(c[0]) }).count());
    }

    #[test]
    fn a_listing_without_the_shell_row_is_not_read() {
        assert_eq!(codex_features_to_disable(""), None);
        assert_eq!(codex_features_to_disable("view_image  stable  true\n"), None);
        assert_eq!(codex_features_to_disable("shell_tool  stable  true\n"), Some(vec!["shell_tool".to_string()]));
    }

    /// The instructions survive TOML parsing unchanged, whatever a template holds.
    #[test]
    fn the_codex_instructions_round_trip_through_a_toml_reader() {
        let text = "Sections:\n**Action Items**\t\"quoted\" \\ back\\slash — ünïcode\r\nend\u{1}";
        let doc = format!("developer_instructions = {}", toml_basic_string(text));
        let parsed: toml::Table = toml::from_str(&doc).expect("valid TOML");
        assert_eq!(parsed["developer_instructions"].as_str(), Some(text));
    }

    #[test]
    fn the_childs_environment_is_the_listed_variables_and_path() {
        let from = [
            ("HOME", "/home/u"), ("LANG", "en_US.UTF-8"), ("LC_ALL", "C"), ("ANTHROPIC_BASE_URL", "x"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"), ("AWS_REGION", "eu"), ("CODEX_HOME", "/c"), ("https_proxy", "p"),
            ("APPIMAGE", "/x.AppImage"), ("LD_LIBRARY_PATH", "/tmp/.mount/usr/lib"), ("GST_PLUGIN_PATH", "/g"), ("SECRET_TOKEN", "s"),
        ]
        .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        let env = environment(from, OsStr::new("/bin:/usr/bin"));
        let keys: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert_eq!(keys, ["ANTHROPIC_BASE_URL", "AWS_REGION", "CLAUDE_CODE_USE_BEDROCK", "CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "https_proxy"]);
    }

    /// A fake CLI: a shell script that records how it was run, then prints `stream` and exits.
    #[cfg(unix)]
    fn fake_cli(dir: &Path, record: &Path, stream: &str, exit: i32, extra: &str) -> PathBuf {
        let stream_file = dir.join("stream.jsonl");
        std::fs::write(&stream_file, stream).unwrap();
        let script = dir.join("fakecli");
        let r = record.display();
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > {r}.args\npwd > {r}.cwd\nls -A > {r}.ls\nenv | cut -d= -f1 | sort > {r}.env\ncat > {r}.stdin\n{extra}\ncat {}\nexit {exit}\n",
                stream_file.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// A fake Codex: `features list` prints the recorded listing, anything else is a run.
    #[cfg(unix)]
    fn fake_codex(dir: &Path, record: &Path, listing: &str) -> PathBuf {
        let listing_file = dir.join("features.txt");
        std::fs::write(&listing_file, listing).unwrap();
        let run = fake_cli(dir, record, &fixture("codex-summary.jsonl"), 0, "");
        let script = dir.join("fakecodex");
        // Like the real one with a broken `config.toml`: asked for its features from the person's home
        // (no `CODEX_HOME`, which means `~/.codex`, or one holding a config), it exits 1 saying nothing.
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ \"$1\" = features ]; then if [ -z \"$CODEX_HOME\" ] || [ -e \"$CODEX_HOME/config.toml\" ]; then exit 1; fi; cat {}; exit 0; fi\nexec {} \"$@\"\n",
                listing_file.display(),
                run.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    /// A Codex home holding a model list with a sub-agent version, for the duration of a test.
    fn with_codex_home(dir: &Path) {
        std::fs::write(dir.join("models_cache.json"), r#"{"identity":"x","models":[{"slug":"m","multi_agent_version":"v2"}]}"#).unwrap();
        TEST_CODEX_HOME.with(|h| *h.borrow_mut() = Some(dir.to_path_buf()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_is_run_with_the_features_it_listed_turned_off() {
        let t = tempfile::tempdir().unwrap();
        with_codex_home(t.path());
        let rec = t.path().join("rec");
        let cli = fake_codex(t.path(), &rec, &fixture("codex-features.txt"));
        let got = run(AgentCli::Codex, &cli, OsStr::new("/usr/bin:/bin"), "S", "the transcript", None, TIMEOUT).await;
        assert_eq!(got, Ok("hello".to_string()));
        let args: Vec<String> = recorded(&rec, "args").lines().map(String::from).collect();
        let off: Vec<&str> = args.windows(2).filter(|w| w[0] == "--disable").map(|w| w[1].as_str()).collect();
        assert_eq!(off, codex_features_to_disable(&fixture("codex-features.txt")).unwrap(), "the run did not turn off what the listing named");
        assert!(off.contains(&"shell_tool") && off.contains(&"view_image"));
        // And it was handed the catalog without the sub-agent version.
        let catalog = args.iter().find_map(|a| a.strip_prefix("model_catalog_json=")).expect("a catalog was passed");
        assert!(!catalog.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_codex_with_no_model_list_is_not_run() {
        let t = tempfile::tempdir().unwrap();
        TEST_CODEX_HOME.with(|h| *h.borrow_mut() = Some(t.path().to_path_buf()));
        let rec = t.path().join("rec");
        let cli = fake_codex(t.path(), &rec, &fixture("codex-features.txt"));
        let got = run(AgentCli::Codex, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, TIMEOUT).await;
        assert!(matches!(got, Err(AgentError::Failed { .. })), "{got:?}");
        assert_eq!(recorded(&rec, "args"), "", "it was run anyway");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_codex_that_cannot_list_its_features_is_not_run() {
        let t = tempfile::tempdir().unwrap();
        with_codex_home(t.path());
        let rec = t.path().join("rec");
        let cli = fake_codex(t.path(), &rec, "error: unrecognized subcommand 'features'\n");
        let got = run(AgentCli::Codex, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, TIMEOUT).await;
        assert!(matches!(got, Err(AgentError::Failed { .. })), "{got:?}");
        assert_eq!(recorded(&rec, "args"), "", "it was run anyway");
    }

    #[cfg(unix)]
    fn recorded(record: &Path, what: &str) -> String {
        std::fs::read_to_string(format!("{}.{what}", record.display())).unwrap_or_default()
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent_cli").join(name)).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_summary_comes_back_from_an_empty_directory_with_the_prompt_on_stdin() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let cli = fake_cli(t.path(), &rec, &fixture("claude-summary.jsonl"), 0, "");
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "SYSTEM", "the transcript", None, TIMEOUT).await;
        assert_eq!(got, Ok("hello".to_string()));
        assert_eq!(recorded(&rec, "stdin"), "the transcript");
        assert_eq!(recorded(&rec, "ls").trim(), "", "the working directory was not empty");
        assert!(recorded(&rec, "cwd").contains("bc-agent-"), "not run in its own directory: {}", recorded(&rec, "cwd"));
        let args = recorded(&rec, "args");
        assert!(args.starts_with("-p\n--tools\n\n--strict-mcp-config\n"), "args: {args:?}");
        let file = args.lines().last().unwrap();
        assert!(!file.contains(recorded(&rec, "cwd").trim()), "the system prompt sits in the working directory");
        let env = recorded(&rec, "env");
        assert!(env.lines().all(|k| ["PATH", "PWD", "SHLVL", "_", "OLDPWD"].contains(&k) || PASSED.contains(&k) || PASSED_MORE.contains(&k) || PASSED_PREFIXES.iter().any(|p| k.starts_with(p))), "unlisted variables reached the CLI: {env}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_exit_is_said_with_what_it_printed() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let cli = fake_cli(t.path(), &rec, "", 1, "echo 'Error: not logged in' >&2");
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, TIMEOUT).await;
        assert_eq!(got, Err(AgentError::Failed { cli: AgentCli::ClaudeCode, message: "Error: not logged in".into() }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nothing_printed_or_more_input_asked_for_is_empty() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        // It reads all of stdin, then asks for more: stdin is closed, so it reads end-of-file and gives up.
        let cli = fake_cli(t.path(), &rec, "", 0, "printf 'Continue? ' ; read answer");
        // A short limit, so a stdin left open shows as a timeout rather than a five-minute wait.
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, Duration::from_secs(10)).await;
        assert_eq!(got, Err(AgentError::Empty(AgentCli::ClaudeCode)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn past_the_limit_it_is_stopped_with_everything_it_started() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let marker = t.path().join("still-running");
        let cli = fake_cli(t.path(), &rec, "", 0, &format!("(sleep 3; touch {}) & sleep 30", marker.display()));
        let started = std::time::Instant::now();
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, Duration::from_millis(500)).await;
        assert_eq!(got, Err(AgentError::TimedOut { cli: AgentCli::ClaudeCode, secs: 0 }));
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(!marker.exists(), "a process the CLI started outlived the kill");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancel_stops_it() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let cli = fake_cli(t.path(), &rec, "", 0, "sleep 30");
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            t2.cancel();
        });
        let started = std::time::Instant::now();
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", Some(&token), TIMEOUT).await;
        assert_eq!(got, Err(AgentError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// A process in a session of its own that holds the CLI's output, started before the CLI exits.
    /// The CLI waits until it is there: a background `setsid` not yet past its fork when the CLI exits
    /// is still in the group and is killed with it, which closed the pipe and made the cancel test
    /// return `Empty` once in four full runs (measured).
    #[cfg(unix)]
    fn detached(dir: &Path) -> String {
        let up = dir.join("detached-up");
        format!("setsid sh -c 'touch {u}; sleep 20' & while [ ! -e {u} ]; do sleep 0.05; done", u = up.display())
    }

    /// The adversary's case (#212 round 3): the CLI answers and exits at once, leaving a process in
    /// its group that would write later. The group is killed after the exit, so it never does.
    #[cfg(unix)]
    #[tokio::test]
    async fn what_the_cli_left_in_its_group_after_exiting_is_killed() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let marker = t.path().join("left-behind");
        // Its output closed, so the drain does not wait for it; still in the CLI's process group.
        let cli = fake_cli(t.path(), &rec, &fixture("claude-summary.jsonl"), 0, &format!("(exec >/dev/null 2>&1; sleep 2; touch {}) &", marker.display()));
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, TIMEOUT).await;
        assert_eq!(got, Ok("hello".to_string()));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!marker.exists(), "a process the CLI left in its group outlived it");
    }

    /// The adversary's case (#212 round 2): the CLI answers and exits, and a process it detached
    /// into a session of its own keeps stdout open. The answer is what arrived, within the grace.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_detached_process_holding_the_output_does_not_hold_the_summary() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let cli = fake_cli(t.path(), &rec, &fixture("claude-summary.jsonl"), 0, &detached(t.path()));
        let started = std::time::Instant::now();
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, TIMEOUT).await;
        assert_eq!(got, Ok("hello".to_string()));
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancel_after_the_cli_exits_still_ends_the_wait() {
        let t = tempfile::tempdir().unwrap();
        let rec = t.path().join("rec");
        let cli = fake_cli(t.path(), &rec, "", 0, &detached(t.path()));
        // Cancelled after the CLI has exited and while its detached child still holds the output:
        // a token cancelled before the run lets the first wait take it, which is not this case
        // (measured: that version stayed green with the drain's cancel removed).
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            t2.cancel();
        });
        let started = std::time::Instant::now();
        let got = run(AgentCli::ClaudeCode, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", Some(&token), TIMEOUT).await;
        assert_eq!(got, Err(AgentError::Cancelled));
        assert!(started.elapsed() < Duration::from_millis(1500), "the cancel waited for the drain's grace: {:?}", started.elapsed());
    }

    #[test]
    fn a_run_does_not_sit_in_the_shared_temporary_directory() {
        let d = work_dir().unwrap();
        if let Some(cache) = dirs::cache_dir() {
            assert!(d.path().starts_with(cache.join("backchannel").join("agent-runs")), "{}", d.path().display());
        }
        assert!(!d.path().starts_with(std::env::temp_dir()) || dirs::cache_dir().is_none(), "{}", d.path().display());
    }
}

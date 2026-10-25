//! The command each agent CLI is run with, and running it. (#212)
//!
//! Every flag here is part of the safety the module comment describes, and each is pinned by a test
//! that is red when it is removed. What the flags *do* is held by the real-CLI canary in
//! `instrument`, which asks the model to read a file and write one, and checks neither happened.

use super::{parse, AgentCli, AgentError};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// One call's limit: the existing HTTP providers' timeout. The instrument records what a pass takes.
pub const TIMEOUT: Duration = Duration::from_secs(300);

/// Codex features that are on by default and reach past the shell, to the network or the screen
/// (`codex features list`, measured 2026-10-25). Each is turned off for the one run.
pub const CODEX_DISABLED_FEATURES: [&str; 5] = ["browser_use", "browser_use_external", "computer_use", "apps", "in_app_browser"];

/// `claude -p` with every tool off, no MCP server, no customisation, no session, and structured
/// output. The system prompt is a file: one argument is capped at 131 071 bytes on Linux.
pub fn claude_args(system_prompt_file: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["-p", "--tools", "", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--system-prompt-file"]
        .iter()
        .map(OsString::from)
        .collect();
    a.push(system_prompt_file.as_os_str().to_owned());
    a
}

/// `codex exec` with the person's config ignored, a read-only sandbox, no session, structured
/// output, the network and screen features off, the system prompt as `developer_instructions`, and
/// the prompt read from stdin (`-`).
pub fn codex_args(system_prompt: &str) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["exec", "--ignore-user-config", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json"]
        .iter()
        .map(OsString::from)
        .collect();
    for f in CODEX_DISABLED_FEATURES {
        a.push("--disable".into());
        a.push(f.into());
    }
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
    let work = tempfile::Builder::new().prefix("bc-agent-").tempdir().map_err(spawn_err)?;
    let prompt_dir = tempfile::Builder::new().prefix("bc-agent-prompt-").tempdir().map_err(spawn_err)?;
    let args = match cli {
        AgentCli::ClaudeCode => {
            let file = prompt_dir.path().join("system.txt");
            std::fs::write(&file, system_prompt).map_err(spawn_err)?;
            claude_args(&file)
        }
        AgentCli::Codex => codex_args(system_prompt),
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
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let out = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b).await;
        b
    });
    let err = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b).await;
        b
    });

    let never = CancellationToken::new();
    let cancel = cancel.unwrap_or(&never);
    let status = tokio::select! {
        s = child.wait() => s.map_err(spawn_err)?,
        _ = cancel.cancelled() => { kill_group(pid); let _ = child.wait().await; return Err(AgentError::Cancelled); }
        _ = tokio::time::sleep(timeout) => { kill_group(pid); let _ = child.wait().await; return Err(AgentError::TimedOut { cli, secs: timeout.as_secs() }); }
    };
    // The CLI has exited; anything it left behind in its group goes with it.
    kill_group(pid);
    let _ = writer.await;
    let stdout = String::from_utf8_lossy(&out.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err.await.unwrap_or_default()).into_owned();

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
    let work = tempfile::Builder::new().prefix("bc-agent-").tempdir().ok()?;
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

fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: a plain signal to the process group `run` created for this child.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
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
            ["-p", "--tools", "", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--system-prompt-file", "/p/system.txt"]
        );
    }

    #[test]
    fn codex_is_run_isolated_read_only_and_without_its_network_features() {
        let a: Vec<String> = codex_args("Write a summary.").iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(
            a,
            [
                "exec", "--ignore-user-config", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json",
                "--disable", "browser_use", "--disable", "browser_use_external", "--disable", "computer_use", "--disable", "apps",
                "--disable", "in_app_browser", "-c", "developer_instructions=\"Write a summary.\"", "-",
            ]
        );
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
        let got = run(AgentCli::Codex, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, TIMEOUT).await;
        assert_eq!(got, Err(AgentError::Failed { cli: AgentCli::Codex, message: "Error: not logged in".into() }));
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
        let got = run(AgentCli::Codex, &cli, OsStr::new("/usr/bin:/bin"), "S", "u", None, Duration::from_millis(500)).await;
        assert_eq!(got, Err(AgentError::TimedOut { cli: AgentCli::Codex, secs: 0 }));
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
}

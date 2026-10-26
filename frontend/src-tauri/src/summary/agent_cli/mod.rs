//! Summaries written by an agent CLI the person already has and is logged in to. (#212)
//!
//! Claude Code and Codex. The transcript is someone else's words, so a meeting in which someone
//! says "read ~/.ssh and include it" must not become an agent doing it:
//!
//! - **Claude Code** runs with every tool off (`--tools ""`), no MCP server, and in `--safe-mode`
//!   (no CLAUDE.md, skills, plugins or hooks), keeping no session.
//! - **Codex** runs with the person's config, rules and skills ignored, a read-only sandbox, no
//!   session, web search off, no project instructions looked for above its directory, and every
//!   feature it lists turned off, so a tool a later release adds is off too (ADR 0028).
//! - **Both** run in a fresh, empty working directory under the user's cache with a listed
//!   environment, and **any tool event in what comes back fails the summary**: with tools off, a
//!   tool event means one ran. That is the second line: Codex has tools that leave no event, which is
//!   why the first line is turning them off.
//!
//! `discovery` finds the binaries the way Orca does (the login shell's `PATH`), `call` builds and
//! runs the command, `parse` turns each CLI's event stream into the summary or an error.

pub mod call;
pub mod discovery;
pub mod parse;
#[cfg(test)]
mod real;

use serde::Serialize;

/// An agent CLI that can write a summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AgentCli {
    ClaudeCode,
    Codex,
}

impl AgentCli {
    pub const ALL: [AgentCli; 2] = [AgentCli::ClaudeCode, AgentCli::Codex];

    /// The binary's name on `PATH`.
    pub fn binary(self) -> &'static str {
        match self {
            AgentCli::ClaudeCode => "claude",
            AgentCli::Codex => "codex",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AgentCli::ClaudeCode => "Claude Code",
            AgentCli::Codex => "Codex",
        }
    }
}

/// Why an agent CLI did not produce a summary, in words the person can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    NotFound(AgentCli),
    /// It exited with a failure, or said one with a zero exit (a usage cap, a lost login).
    Failed { cli: AgentCli, message: String },
    /// It finished without a summary.
    Empty(AgentCli),
    /// A tool ran, which the call forbids; the summary is not trusted.
    ToolUsed { cli: AgentCli, what: String },
    TimedOut { cli: AgentCli, secs: u64 },
    Cancelled,
    /// It could not be started at all.
    Spawn { cli: AgentCli, message: String },
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::NotFound(c) => write!(
                f,
                "{} is not in your shell's PATH. Install `{}` and log in, then try again.",
                c.display_name(),
                c.binary()
            ),
            AgentError::Failed { cli, message } => {
                write!(f, "{} could not write the summary: {}", cli.display_name(), message.trim())
            }
            AgentError::Empty(c) => write!(f, "{} finished without writing a summary.", c.display_name()),
            AgentError::ToolUsed { cli, what } => write!(
                f,
                "{} tried to use a tool ({what}) while writing the summary, which this app does not allow, so the summary was discarded.",
                cli.display_name()
            ),
            AgentError::TimedOut { cli, secs } => {
                write!(f, "{} did not answer within {secs} s.", cli.display_name())
            }
            AgentError::Cancelled => write!(f, "Summary generation was cancelled"),
            AgentError::Spawn { cli, message } => {
                write!(f, "{} could not be started: {message}", cli.display_name())
            }
        }
    }
}

/// What first run and Settings show for one CLI: where it was found, and whether it is logged in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The provider id it is offered under: `claude-code` or `codex`.
    pub id: &'static str,
    /// The path found, with the home directory written as `~`; `None` when not found.
    pub found: Option<String>,
    pub source: Option<discovery::Source>,
    /// `None` when the login check could not be run or read.
    pub logged_in: Option<bool>,
}

impl AgentCli {
    pub fn provider_id(self) -> &'static str {
        match self {
            AgentCli::ClaudeCode => "claude-code",
            AgentCli::Codex => "codex",
        }
    }
}

/// Look for both CLIs and ask each whether it is logged in.
pub async fn status() -> Vec<Status> {
    let world = discovery::World::current();
    let mut out = Vec::new();
    for cli in AgentCli::ALL {
        let found = discovery::find(cli.binary(), &world);
        let logged_in = match &found {
            Some(f) => call::logged_in(cli, &f.path, &child_path(&f.path, world.login_path.as_deref(), world.process_path.as_deref())).await,
            None => None,
        };
        // The line Stage 2 reads: a screen that says "not found" is otherwise the same with this
        // command never answering, since the screens treat no answer as none found.
        log::info!(
            "Agent CLI status: {} found={} via={:?} logged_in={:?}",
            cli.provider_id(),
            found.as_ref().map(|f| f.path.display().to_string()).unwrap_or_else(|| "none".into()),
            found.as_ref().map(|f| f.source),
            logged_in
        );
        out.push(Status {
            id: cli.provider_id(),
            found: found.as_ref().map(|f| tilde(&f.path, &world.home)),
            source: found.map(|f| f.source),
            logged_in,
        });
    }
    out
}

/// `/home/u/.local/bin/claude` as `~/.local/bin/claude`, as the approved screens show it.
fn tilde(path: &std::path::Path, home: &std::path::Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}

/// The Tauri command behind first run's agent option and Settings' status line.
#[tauri::command]
pub async fn agent_cli_status() -> Vec<Status> {
    status().await
}

/// Write one answer through `cli`: find it, run it with the system prompt and the user prompt, and
/// return what it wrote. The child's `PATH` is the login shell's when there is one, since a CLI
/// installed through nvm needs its `node` too; otherwise the application's own, with the binary's
/// directory in front.
pub async fn generate(
    cli: AgentCli,
    system_prompt: &str,
    user_prompt: &str,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<String, AgentError> {
    let world = discovery::World::current();
    let found = discovery::find(cli.binary(), &world).ok_or(AgentError::NotFound(cli))?;
    let child_path = child_path(&found.path, world.login_path.as_deref(), world.process_path.as_deref());
    log::info!("Summarising through {} at {} (found via {:?})", cli.display_name(), found.path.display(), found.source);
    call::run(cli, &found.path, &child_path, system_prompt, user_prompt, cancel, call::TIMEOUT).await
}

fn child_path(binary: &std::path::Path, login: Option<&str>, process: Option<&std::ffi::OsStr>) -> std::ffi::OsString {
    let mut dirs: Vec<std::path::PathBuf> = binary.parent().map(|d| vec![d.to_path_buf()]).unwrap_or_default();
    match (login, process) {
        (Some(l), _) => dirs.extend(std::env::split_paths(l)),
        (None, Some(p)) => dirs.extend(std::env::split_paths(p)),
        (None, None) => dirs.extend([std::path::PathBuf::from("/usr/bin"), std::path::PathBuf::from("/bin")]),
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_under_home_is_shown_with_a_tilde() {
        assert_eq!(tilde(std::path::Path::new("/home/u/.local/bin/claude"), std::path::Path::new("/home/u")), "~/.local/bin/claude");
        assert_eq!(tilde(std::path::Path::new("/usr/local/bin/codex"), std::path::Path::new("/home/u")), "/usr/local/bin/codex");
        assert_eq!(tilde(std::path::Path::new("/usr/bin/codex"), std::path::Path::new("")), "/usr/bin/codex");
    }

    #[test]
    fn the_status_is_sent_to_the_screens_in_their_field_names() {
        let s = Status { id: "codex", found: Some("~/.local/bin/codex".into()), source: Some(discovery::Source::LoginShell), logged_in: Some(false) };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v, serde_json::json!({"id": "codex", "found": "~/.local/bin/codex", "source": "LoginShell", "loggedIn": false}));
    }

    /// Unix only: a login shell and a `:`-separated `PATH` are what it is about (Windows has neither).
    #[cfg(unix)]
    #[test]
    fn the_childs_path_starts_with_the_binarys_directory_then_the_login_shells() {
        let p = child_path(std::path::Path::new("/home/u/.local/bin/claude"), Some("/home/u/.nvm/bin:/usr/bin"), Some(std::ffi::OsStr::new("/usr/bin")));
        assert_eq!(p, std::ffi::OsString::from("/home/u/.local/bin:/home/u/.nvm/bin:/usr/bin"));
        let p = child_path(std::path::Path::new("/opt/codex"), None, Some(std::ffi::OsStr::new("/usr/bin:/bin")));
        assert_eq!(p, std::ffi::OsString::from("/opt:/usr/bin:/bin"));
    }
}

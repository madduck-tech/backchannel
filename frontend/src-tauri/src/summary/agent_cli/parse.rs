//! What each CLI prints, turned into the summary or an error. (#212)
//!
//! Both are asked for structured output, one JSON event per line: Claude Code's
//! `--output-format stream-json --verbose`, Codex's `--json`. Measured on 2026-10-25 with one real
//! call each; the scrubbed streams are `tests/fixtures/agent_cli/*-summary.jsonl`.
//!
//! **A tool event fails the summary rather than being stripped.** Both calls turn tools off, so a
//! tool event in the stream means a tool ran on the transcript's say-so, and nothing it wrote can be
//! trusted. A line that is not JSON is ignored: the CLIs print warnings to stdout now and then.

use super::{AgentCli, AgentError};
use serde_json::Value;

fn events(stdout: &str) -> impl Iterator<Item = Value> + '_ {
    stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
}

/// Claude Code's stream: an `init` event naming the session's tools and MCP servers, `assistant`
/// messages, and a `result` event carrying the final text or the error.
pub fn claude(stdout: &str) -> Result<String, AgentError> {
    let cli = AgentCli::ClaudeCode;
    let mut result: Option<Result<String, AgentError>> = None;
    let mut started_bare = false;
    for e in events(stdout) {
        match e["type"].as_str() {
            Some("system") if e["subtype"] == "init" => {
                // Independent of what the model chose to do: the session itself must hold no tool.
                // Read closed: a list that is missing or not a list is not an empty one (#212 round 2).
                for list in ["tools", "mcp_servers"] {
                    match e[list].as_array() {
                        Some(a) if a.is_empty() => {}
                        Some(_) => return Err(AgentError::ToolUsed { cli, what: format!("the session started with {list} {}", e[list]) }),
                        None => return Err(AgentError::Failed { cli, message: format!("its start-up event did not list its {list}, so the summary was not trusted") }),
                    }
                }
                started_bare = true;
            }
            Some("assistant") => {
                for item in e["message"]["content"].as_array().into_iter().flatten() {
                    // `tool_use`, and `server_tool_use`, `mcp_tool_use`, `web_search_tool_result` and
                    // whatever else names a tool: refused by name, not by an exact list (#212 round 4).
                    if item["type"].as_str().is_some_and(|t| t.contains("tool")) {
                        let name = item["name"].as_str().unwrap_or("a tool").to_string();
                        return Err(AgentError::ToolUsed { cli, what: name });
                    }
                }
            }
            Some("result") => {
                let text = e["result"].as_str().unwrap_or("").to_string();
                result = Some(if e["is_error"].as_bool().unwrap_or(false) || e["subtype"] != "success" {
                    Err(AgentError::Failed {
                        cli,
                        message: if text.is_empty() { e["subtype"].as_str().unwrap_or("an error").to_string() } else { text },
                    })
                } else if text.trim().is_empty() {
                    Err(AgentError::Empty(cli))
                } else {
                    Ok(text)
                });
            }
            _ => {}
        }
    }
    // An answer is trusted only from a session that said it had no tools. Nothing printed, or an
    // error, is reported as itself: masking it would hide a lost login behind this check.
    match result {
        Some(Ok(_)) if !started_bare => Err(AgentError::Failed { cli, message: "it gave no start-up event saying it had no tools, so the summary was not trusted".into() }),
        Some(r) => r,
        None => Err(AgentError::Empty(cli)),
    }
}

/// Codex's stream: `thread.started`, `turn.started`, `item.*` events (`agent_message` is the answer;
/// any other item type is a tool or a step the model took), and `turn.completed`, or `error` /
/// `turn.failed`.
pub fn codex(stdout: &str) -> Result<String, AgentError> {
    let cli = AgentCli::Codex;
    let mut messages: Vec<String> = Vec::new();
    let mut completed = false;
    // A top-level `error` is not final: Codex prints one per reconnect ("Reconnecting... 1/5") and
    // may go on to finish (#212 round 3). It is the answer only if the turn never completes.
    let mut last_error: Option<String> = None;
    for e in events(stdout) {
        match e["type"].as_str() {
            Some(t) if t.starts_with("item.") => match e["item"]["type"].as_str() {
                // Codex says what it is about to do in a message of its own before the answer ("I'm
                // using the … skill"), so the answer is the last message, not all of them (#212
                // round 4).
                Some("agent_message") => {
                    if t == "item.completed" {
                        if let Some(text) = e["item"]["text"].as_str() {
                            messages = vec![text.to_string()];
                        }
                    }
                }
                // Its private reasoning is not a tool, and an `error` item is a notice Codex prints
                // about its own setup: with code mode's host off it says so on every run.
                Some("reasoning") => {}
                Some("error") => log::warn!("Codex: {}", e["item"]["message"].as_str().unwrap_or("")),
                Some(other) => return Err(AgentError::ToolUsed { cli, what: other.to_string() }),
                None => {}
            },
            Some("error") => {
                last_error = Some(e["message"].as_str().or_else(|| e["error"]["message"].as_str()).unwrap_or("an error").to_string());
            }
            Some("turn.failed") => {
                let message = e["error"]["message"].as_str().or_else(|| e["message"].as_str()).or(last_error.as_deref()).unwrap_or("an error").to_string();
                return Err(AgentError::Failed { cli, message });
            }
            Some("turn.completed") => completed = true,
            _ => {}
        }
    }
    let text = messages.concat();
    if !completed {
        return Err(last_error.map_or(AgentError::Empty(cli), |message| AgentError::Failed { cli, message }));
    }
    if text.trim().is_empty() {
        return Err(AgentError::Empty(cli));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent_cli").join(name);
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
    }

    #[test]
    fn claude_codes_recorded_stream_is_its_answer() {
        assert_eq!(claude(&fixture("claude-summary.jsonl")), Ok("hello".to_string()));
    }

    #[test]
    fn codexs_recorded_stream_is_its_answer() {
        assert_eq!(codex(&fixture("codex-summary.jsonl")), Ok("hello".to_string()));
    }

    /// The recorded stream with one change each, so every rule is shown on the real shape.
    fn with(name: &str, from: &str, to: &str) -> String {
        let s = fixture(name);
        assert_eq!(s.matches(from).count(), 1, "the fixture holds `{from}` once");
        s.replace(from, to)
    }

    #[test]
    fn a_claude_session_that_started_with_a_tool_is_refused() {
        let s = with("claude-summary.jsonl", "\"tools\":[]", "\"tools\":[\"Bash\"]");
        assert!(matches!(claude(&s), Err(AgentError::ToolUsed { .. })), "{:?}", claude(&s));
        let s = with("claude-summary.jsonl", "\"mcp_servers\":[]", "\"mcp_servers\":[{\"name\":\"x\"}]");
        assert!(matches!(claude(&s), Err(AgentError::ToolUsed { .. })));
    }

    #[test]
    fn a_tool_call_in_claudes_answer_fails_the_summary() {
        let s = with(
            "claude-summary.jsonl",
            "[{\"type\":\"text\",\"text\":\"hello\"}]",
            "[{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"file_path\":\"/home/<user>/.ssh/id_ed25519\"}},{\"type\":\"text\",\"text\":\"hello\"}]",
        );
        assert_eq!(claude(&s), Err(AgentError::ToolUsed { cli: AgentCli::ClaudeCode, what: "Read".into() }));
    }

    /// Exit 0 with an error: a usage cap or a lost login arrives as a `result` that is an error.
    #[test]
    fn claudes_error_result_is_a_failure_not_a_summary() {
        let s = with("claude-summary.jsonl", "\"is_error\":false", "\"is_error\":true");
        let s = s.replace("\"result\":\"hello\"", "\"result\":\"Claude usage limit reached\"");
        assert_eq!(claude(&s), Err(AgentError::Failed { cli: AgentCli::ClaudeCode, message: "Claude usage limit reached".into() }));
    }

    #[test]
    fn no_result_or_an_empty_one_is_empty() {
        let s: String = fixture("claude-summary.jsonl").lines().filter(|l| !l.contains("\"type\":\"result\"")).collect::<Vec<_>>().join("\n");
        assert_eq!(claude(&s), Err(AgentError::Empty(AgentCli::ClaudeCode)));
        assert_eq!(codex(""), Err(AgentError::Empty(AgentCli::Codex)));
    }

    /// The adversary's three shapes (#212 round 2): each returned the summary before.
    #[test]
    fn a_claude_stream_that_does_not_say_it_has_no_tools_is_not_trusted() {
        let no_init: String = fixture("claude-summary.jsonl").lines().filter(|l| !l.contains("\"subtype\":\"init\"")).collect::<Vec<_>>().join("\n");
        assert!(matches!(claude(&no_init), Err(AgentError::Failed { .. })), "{:?}", claude(&no_init));
        let no_list = with("claude-summary.jsonl", "\"tools\":[]", "\"toolz\":[]");
        assert!(matches!(claude(&no_list), Err(AgentError::Failed { .. })), "{:?}", claude(&no_list));
        let an_object = with("claude-summary.jsonl", "\"mcp_servers\":[]", "\"mcp_servers\":{\"x\":{}}");
        assert!(matches!(claude(&an_object), Err(AgentError::Failed { .. })), "{:?}", claude(&an_object));
        // Nothing printed is still nothing printed, not a distrusted answer.
        assert_eq!(claude(""), Err(AgentError::Empty(AgentCli::ClaudeCode)));
    }

    /// Codex 0.163.0 with code mode's host off prints this item first on every run (measured).
    #[test]
    fn codexs_setup_notice_is_not_a_tool() {
        let s = format!(
            "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"Code Mode is unavailable because code-mode host is disabled.\"}}}}\n{}",
            fixture("codex-summary.jsonl")
        );
        assert_eq!(codex(&s), Ok("hello".to_string()));
    }

    #[test]
    fn a_command_web_search_or_file_change_in_codexs_stream_fails_the_summary() {
        for kind in ["command_execution", "web_search", "file_change", "mcp_tool_call"] {
            let s = with("codex-summary.jsonl", "\"type\":\"agent_message\"", &format!("\"type\":\"{kind}\""));
            assert_eq!(codex(&s), Err(AgentError::ToolUsed { cli: AgentCli::Codex, what: kind.into() }), "{kind}");
        }
    }

    #[test]
    fn codexs_error_events_are_failures() {
        let mut s = fixture("codex-summary.jsonl");
        s.push_str("{\"type\":\"turn.failed\",\"error\":{\"message\":\"You've hit your usage limit\"}}\n");
        assert_eq!(codex(&s), Err(AgentError::Failed { cli: AgentCli::Codex, message: "You've hit your usage limit".into() }));
        let unfinished: String = fixture("codex-summary.jsonl").lines().filter(|l| !l.contains("turn.completed")).map(|l| format!("{l}\n")).collect();
        let s = format!("{unfinished}{{\"type\":\"error\",\"message\":\"stream disconnected before completion\"}}\n");
        assert_eq!(codex(&s), Err(AgentError::Failed { cli: AgentCli::Codex, message: "stream disconnected before completion".into() }));
    }

    /// The shape measured on a reconnect (#212 round 3): an `error` per retry, then the turn finishes.
    #[test]
    fn a_reconnect_that_recovers_is_not_a_failure() {
        let s = format!("{{\"type\":\"error\",\"message\":\"Reconnecting... 1/5 (stream disconnected before completion)\"}}\n{}", fixture("codex-summary.jsonl"));
        assert_eq!(codex(&s), Ok("hello".to_string()));
    }

    #[test]
    fn codex_without_a_completed_turn_is_empty() {
        let s: String = fixture("codex-summary.jsonl").lines().filter(|l| !l.contains("turn.completed")).collect::<Vec<_>>().join("\n");
        assert_eq!(codex(&s), Err(AgentError::Empty(AgentCli::Codex)));
    }

    #[test]
    fn claudes_other_tool_blocks_fail_the_summary_too() {
        for kind in ["server_tool_use", "mcp_tool_use", "web_search_tool_result"] {
            let s = with("claude-summary.jsonl", "[{\"type\":\"text\",\"text\":\"hello\"}]", &format!("[{{\"type\":\"{kind}\",\"name\":\"x\"}},{{\"type\":\"text\",\"text\":\"hello\"}}]"));
            assert!(matches!(claude(&s), Err(AgentError::ToolUsed { .. })), "{kind}: {:?}", claude(&s));
        }
    }

    /// The shape measured with a skill named in the transcript (#212 round 3): a preamble message, then the answer.
    #[test]
    fn codexs_answer_is_its_last_message() {
        let s = fixture("codex-summary.jsonl").replacen(
            "{\"type\":\"item.completed\"",
            "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_p\",\"type\":\"agent_message\",\"text\":\"I'm using the bcuser skill.\"}}\n{\"type\":\"item.completed\"",
            1,
        );
        assert!(s.contains("I'm using the bcuser skill."));
        assert_eq!(codex(&s), Ok("hello".to_string()));
    }

    #[test]
    fn a_warning_line_on_stdout_is_not_an_event() {
        let s = format!("WARNING: something unrelated\n{}", fixture("codex-summary.jsonl"));
        assert_eq!(codex(&s), Ok("hello".to_string()));
    }
}

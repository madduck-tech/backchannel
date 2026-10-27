# What each agent harness receives

Every instruction file under `.claude/`, and `frontend/AGENTS.md`, against the three harnesses this repository supports (#233, ADR 0032).
- **loaded:** the harness puts the text in front of the model.
- **indexed:** the root `AGENTS.md` names the file and the paths it governs. The agent is told to open it, and no instrument observes it doing so. Only #233's condition 8, a model-driven run, can.
- **not delivered:** the harness never sees it, for the reason in `scripts/agent-files-not-delivered.json`.

Measured on 2026-10-27 at `98d354e`, and at D's head for the commands, with Codex 0.163.0, opencode 1.18.32 and Claude Code 2.1.311.
- **Codex and opencode, every rule:** the instrument checks, for each of the five rules, that the embedded rule's last line or the scoped rule's index row is in Codex's `prompt-input` and in opencode's request, from the root and from `frontend/`. All 20 cells were present.
- **Claude Code:** five runs, each loading exactly `CLAUDE.md`, `workflow.md` and `testing.md` at start, and each scoped rule on its own file. The root `AGENTS.md` appears in no event.
- Every tool ran under `env -i`, with empty `HOME`, `CODEX_HOME` and XDG directories.
- Claude Code and opencode sent their requests to a local stub that records them, with a dummy key. No model was called.
- The instrument is the engineering session's `harness250.py`, quoted in #250's and #251's verdicts.

| file | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| `CLAUDE.md` (its Backchannel section) | loaded at `session_start` (`InstructionsLoaded`, 5 of 5 runs) | loaded: embedded in the root `AGENTS.md` (`prompt-input` shows its end sentinel) | loaded: embedded in the root `AGENTS.md` (the request carries its sentinel once, and no `# CLAUDE.md`) |
| `.claude/rules/workflow.md` | loaded at `session_start`, 5 of 5 | loaded: embedded (`prompt-input` shows its last line) | loaded: embedded (its last line in the request) |
| `.claude/rules/testing.md` | loaded at `session_start`, 5 of 5; once in the request | loaded: embedded (its last line shown) | loaded: embedded (its last line in the request) |
| `.claude/rules/design-system.md` | loaded on a matching file (`path_glob_match` on `@frontend/src/app/page.tsx`) | indexed (`prompt-input` shows its index row) | indexed (the request carries its index row) |
| `.claude/rules/docs.md` | loaded on a matching file (`path_glob_match` on `@docs/development-workflow.md`) | indexed (its row in `prompt-input`) | indexed (its row in the request) |
| `.claude/rules/platform-code.md` | loaded on a matching file (`path_glob_match` on `@frontend/src-tauri/src/audio/pipeline.rs`) | indexed (its row in `prompt-input`) | indexed (its row in the request) |
| `frontend/AGENTS.md` | loaded when a file under `frontend/` is read, through `frontend/CLAUDE.md`'s `@AGENTS.md` (`load_reason: include`) | loaded when started in `frontend/` (`prompt-input` shows `<!-- END:nextjs-agent-rules -->`); indexed when started at the root | loaded when started in `frontend/` (the request carries its title); indexed at the root |
| `.claude/skills/*` | loaded as skills | loaded: copied to `.agents/skills/` (`skills/list`, scope `repo`; #249) | loaded: from `.agents/skills/` or `.claude/skills/`, a race between identical copies (#249) |
| `.claude/commands/{critique,work}.md` | loaded as `/critique N` and `/work N` | loaded as skills under `.agents/skills/` (#252). `$work N` and `$critique N` inject the body (`codex exec` against the stub). An ordinary request ("work issue N") lists both with their descriptions and carries neither body | loaded as commands under `.opencode/command/` (#252). `--command work 42` sends the text with `**42**` in place, and does not fall back to the skill |
| `.claude/commands/issue.md` | loaded as `/issue` | loaded as a skill only when named: `$issue …` injects it, and with `allow_implicit_invocation: false` it is absent from `prompt-input` and from an ordinary request | loaded as `/issue`, with the request's text appended. The `issue` skill asks first (`permission.skill`, `opencode debug agent build`) |

**No file is loaded twice by one harness.** Claude Code does not read the root `AGENTS.md`, and `CLAUDE.md` does not import it. The `testing.md` sentinel appears once in Claude Code's request.

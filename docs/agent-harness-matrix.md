# What each agent harness receives

Every instruction file under `.claude/`, and `frontend/AGENTS.md`, against the three harnesses this repository supports (#233, ADR 0032).
- **loaded:** the harness puts the text in front of the model.
- **indexed:** the root `AGENTS.md` names the file and the paths it governs. The agent is told to open it, and no instrument observes it doing so. Only #233's condition 8, a model-driven run, can.
- **not delivered:** the harness never sees it, for the reason in `scripts/agent-files-not-delivered.json`.

Measured on 2026-10-27 at `a6cbcf2`, with Codex 0.163.0, opencode 1.18.32 and Claude Code 2.1.311.
- Every tool ran under `env -i`, with empty `HOME`, `CODEX_HOME` and XDG directories.
- Claude Code and opencode sent their requests to a local stub that records them, with a dummy key. No model was called.
- The instrument is the engineering session's `harness250.py`, quoted in #250's and #251's verdicts.

| file | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| `CLAUDE.md` (its Backchannel section) | loaded at `session_start` (`InstructionsLoaded`, 5 of 5 runs) | loaded: embedded in the root `AGENTS.md` (`prompt-input` shows its end sentinel) | loaded: embedded in the root `AGENTS.md` (the request carries its sentinel once, and no `# CLAUDE.md`) |
| `.claude/rules/workflow.md` | loaded at `session_start`, 5 of 5 | loaded: embedded (`prompt-input` shows its last line) | loaded: embedded |
| `.claude/rules/testing.md` | loaded at `session_start`, 5 of 5; once in the request | loaded: embedded (its last line shown) | loaded: embedded |
| `.claude/rules/design-system.md` | loaded on a matching file (`path_glob_match` on `@frontend/src/app/page.tsx`) | indexed (`prompt-input` shows its index row) | indexed (the request carries its index row) |
| `.claude/rules/docs.md` | loaded on a matching file (`path_glob_match` on `@docs/development-workflow.md`) | indexed | indexed |
| `.claude/rules/platform-code.md` | loaded on a matching file (`path_glob_match` on `@frontend/src-tauri/src/audio/pipeline.rs`) | indexed | indexed |
| `frontend/AGENTS.md` | loaded when a file under `frontend/` is read, through `frontend/CLAUDE.md`'s `@AGENTS.md` (`load_reason: include`) | loaded when started in `frontend/` (`prompt-input` shows `<!-- END:nextjs-agent-rules -->`); indexed when started at the root | loaded when started in `frontend/` (the request carries its title); indexed at the root |
| `.claude/skills/*` | loaded as skills | loaded: copied to `.agents/skills/` (`skills/list`, scope `repo`; #249) | loaded: from `.agents/skills/` or `.claude/skills/`, a race between identical copies (#249) |
| `.claude/commands/{critique,issue,work}.md` | loaded as `/critique`, `/issue` and `/work` | not delivered until #252 | not delivered until #252 |

**No file is loaded twice by one harness.** Claude Code does not read the root `AGENTS.md`, and `CLAUDE.md` does not import it. The `testing.md` sentinel appears once in Claude Code's request.

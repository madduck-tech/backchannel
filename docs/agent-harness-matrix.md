# What each agent harness receives

Every source of agent instructions, against the three harnesses this repository supports (#271, ADR 0033). The sources are `AGENTS.md` and `.agents/`; Claude Code reads the copies `scripts/gen-agent-files.mjs` makes of them (`CLAUDE.md`, `.claude/`).
- **loaded:** the harness puts the text in front of the model.
- **indexed:** the root `AGENTS.md` names the file and the paths it governs. The agent is told to open it, and no instrument observes it doing so.
- **not delivered:** the harness never sees it, for the reason in `scripts/agent-files-not-delivered.json` (empty today).

Measured on 2026-10-28 on #271's branch, macOS (Darwin 25.6.0), with Claude Code 2.1.312, codex-cli 0.163.0 and opencode 2.0.32, in a fixture repository built from the branch's files with a unique sentinel in `AGENTS.md`, `frontend/AGENTS.md`, `.agents/rules/docs.md`, `.agents/commands/work.md`, a fixture skill and `AGENTS.local.md`. Linux and Windows were not measured.

**The instruments needed no model**, except for `AGENTS.local.md`:
- Every one ran under `env -i`, with empty `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and XDG directories, and no credentials.
- **Claude Code:** `claude -p hi`, sending to a local stub that records each request body (`ANTHROPIC_BASE_URL`, a dummy key). Against this stub, which answers every request with an error, one run sent six bodies, and every count below is per body; a stub that answers differently sees fewer.
- **Codex:** `codex debug prompt-input hi`.
- **opencode:** two instruments, both against an OpenAI-compatible stub provider declared in the profile's config.
  - `opencode run --standalone`. One of its two attempts on the unmutated fixture hung with no request, and was recorded. The second ran.
  - For the commands and the configuration, a private `opencode serve` with `POST /api/session/{id}/command` and `GET /api/config`. 2.0.32 has no `debug skill` and no `run --command`, and `run "/work 42"` sends the literal text.

Each row's control is a mutation of the fixture that turned the observation red. One control was rewritten: the first scoped-rule control changed one of `docs.md`'s two globs and stayed green, because `*.md` still matched.

| source | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| `AGENTS.md` | loaded through its copy `CLAUDE.md`: the root sentinel once in each of 6 bodies, from the root and from `frontend/`. Control: `@AGENTS.md` appended gives 2; `CLAUDE.md` removed gives 0 from `frontend/` | loaded: the root sentinel once in `prompt-input`. Control: the line doubled gives 2 | loaded: once, with `CLAUDE.md` present and never sent. Control: `"instructions": ["CLAUDE.md"]` gives 2 |
| `.agents/rules/*.md` | loaded through `.claude/rules/` only for a matching path: 0 at start, 1 after `@docs/notes.md`. Controls: the copy without `paths:` gives 1 at start; both globs missing gives 0 after the `@` | indexed: every row in `prompt-input`, and the rule's own text absent. Controls: a row deleted gives 0; the rule's text pasted into `AGENTS.md` gives 1 | indexed: the rule's text absent from the request. Control: pasted into `AGENTS.md` gives 1 |
| `frontend/AGENTS.md` | loaded from `frontend/` through Next.js's `frontend/CLAUDE.md` (`@AGENTS.md`), along with the root copy. Control: `frontend/CLAUDE.md` removed gives 0 | loaded from `frontend/`. Negative cell: from the root, 0 | not measured from `frontend/` |
| `.agents/skills/*` | loaded through `.claude/skills/`: each description in each body. Control: a copy removed gives 0 | loaded: the descriptions in `prompt-input`. `issue` is absent, being implicit-off (#252). Control: a skill removed gives 0 | loaded: the descriptions in the request, once each, though it reads `.claude/skills/` too. Control: removed from both gives 0 |
| `.agents/commands/*.md` | loaded through `.claude/commands/` as `/work`, `/critique` and `/issue`: their descriptions in each body. Control: `.claude/commands/work.md` removed gives 0 | as skills in `.agents/skills/` (#252), and the command source is not read. `$work N` was not re-measured here | as commands in `.opencode/command/`: `work` with `42` sends its body with `**42**`. Control: the file removed gives `CommandNotFoundError` and no request |
| `issue` asks first | — | `allow_implicit_invocation: false` (#252), not re-measured | `GET /api/config` shows the rule `skill` / `issue` / `ask` loaded from `opencode.json`. Control: the rule removed, and no rule. That an ask is shown when a model invokes the skill was **not observed** |
| user-level `CLAUDE.md` | loaded beside the project's (`CLAUDE_CONFIG_DIR/CLAUDE.md`): its sentinel in each body, the root once. Control: without it, 0 | — | — |

**`AGENTS.local.md`** is read only when a model follows `AGENTS.md`'s instruction. Those runs are in #271's verdict.

**No file is loaded twice by one harness.** Claude Code loads `CLAUDE.md` and not `AGENTS.md`, because a full `CLAUDE.md` turns off its `AGENTS.md` fallback. opencode loads `AGENTS.md` and not `CLAUDE.md`. Codex never reads `CLAUDE.md`.

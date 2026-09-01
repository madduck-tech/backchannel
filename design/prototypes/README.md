# Prototypes

Single-file HTML prototypes rendered with OpenDesign against the `design/backchannel` package.
They are design references, not app code: the app implements screens in Tauri/React using the
tokens in `frontend/src/app/globals.css`.

| File | What it shows | Generated |
|---|---|---|
| `overlay-hint-and-answer.html` | Meeting overlay, dark theme, two states: a proactive "history" hint with collapsed input, and the expanded input with a streaming answer. Rendered over a mock video-call grid. | 2026-09-01, OpenDesign 0.21.1, Claude Code runtime |

Regenerate or add prototypes from Claude Code through the `open-design` MCP server
(`start_run` with `project: "backchannel-prototypes"`) or in the OpenDesign Studio UI.

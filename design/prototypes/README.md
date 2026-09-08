# Prototypes

Single-file HTML prototypes rendered with OpenDesign against the `design/backchannel` package.
They are design references, not app code: the app implements screens in Tauri/React using the
tokens in `frontend/src/app/globals.css`.

| File | What it shows | Generated |
|---|---|---|
| `overlay-hint-and-answer.html` | Meeting overlay, dark theme, two states: a proactive "history" hint with collapsed input, and the expanded input with a streaming answer. Rendered over a mock video-call grid. | 2026-09-01, OpenDesign 0.21.1, Claude Code runtime |
| `onboarding-catalogue.html` | First run, the model catalogue behind one button. One search field over all rows; no row count anywhere, no sort control, no installed-only filter, no paragraph about error rates. Approved as variant `a4` after three revisions. | 2026-09-08, OpenDesign, run `bc-catalogue-a4-ring-room` |
| `onboarding-download.html` | First run, fetching what was chosen. Two rows: the transcription model with its progress, the summary model stated as already on the device rather than shown as a bar at 0%. Approved as `a-two-rows`. | 2026-09-08, OpenDesign, run `bc-onboarding-screens-2` |
| `onboarding-summariser.html` | First run, choosing where summaries are written. Seven options, each naming its destination; picking a remote one opens the key field inside that option and scrolls it to the top so the reveal cannot land below the fold. Approved as `c-inline-scroll`. | 2026-09-08, OpenDesign, run `bc-onboarding-screens-2` |

## What a committed prototype means

A file here is **an approved decision**, not a sketch. ADR 0022 decision 5: a screen with no committed
prototype is not implemented. ADR 0023: an instruction that removes something from one of these ships
as a test that fails while the thing is present.

**Measured before committing** (headless Chrome over the served file), because a prototype is checked
by nothing and one of these shipped a defect that reached the product owner:

| | `onboarding-catalogue.html` |
|---|---|
| gap between the search field and the list | **17px** — the focus ring draws 4px outside the box |
| interactive boxes intersecting, ring included | **0** |
| row count rendered anywhere | none |
| text inputs above the list | 1 |

The gap is why `a4` exists. Removing the language chips — an instruction — collapsed it from 106px to
1px, and the field's focus ring landed on the table header. The removal had been verified only by
checking the element was gone. That geometry is #132's debt: a prototype must pass the checks the
implementation passes.

Regenerate or add prototypes from Claude Code through the `open-design` MCP server
(`start_run` with `project: "backchannel-prototypes"`) or in the OpenDesign Studio UI.

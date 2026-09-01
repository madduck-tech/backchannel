# ADR 0011: Design system as a repository package; OpenDesign as the prototyping tool

Date: 2026-09-01
Status: accepted

## Context

The spec describes several product surfaces (agent chat + card, Setup Master, meeting review,
analytics, and a compact overlay) that will be built after Milestone 0. The question was whether
to fix a design system now. The fork already carried one: a `DESIGN.md` at the repository root,
an OKLCH semantic token layer in `frontend/src/app/globals.css`, a Tailwind theme bound to it,
light and dark themes, and 22 shadcn/ui-based primitives.

OpenDesign (`nexu-io/open-design`, Apache-2.0, v0.21.1 on 2026-08-31) turns a coding agent into
a design engine driven by a **design-system package**: `manifest.json` + `DESIGN.md` (prose for
agents, at least seven H2 sections) + `tokens.css` (a shared semantic-token contract), optionally
component fixtures and previews. It exposes a stdio MCP server (`od mcp`) with tools to list and
read project files, create artifacts and start agent runs, and it can import a design system from
a local folder. On Linux there is no packaged desktop build; it runs from source (Node 24, pnpm
10) or Docker.

## Decision

1. **The design system lives in this repository** as an OpenDesign-compatible package at
   `design/backchannel/`: `manifest.json`, `DESIGN.md`, `tokens.css`, `USAGE.md`. The former root
   `DESIGN.md` moved there and was rewritten for Backchannel. Code comments point to the new path.
2. **Two sources of truth, one per consumer, kept in sync by hand until a generator exists:**
   `frontend/src/app/globals.css` for the app (bare OKLCH components for Tailwind alpha),
   `design/backchannel/tokens.css` for prototypes (full `oklch()` values in the OpenDesign
   contract, plus documented Backchannel extensions such as `--surface-sunken`, `--border-strong`,
   `--accent-soft`, `--info`, `--overlay-w`). Token *names* in the app are not renamed.
3. **Brand hue rotated from 110° (olive) to 190° (teal)** in both files. Lightness and chroma are
   unchanged, so the measured contrast ratios hold to within rounding; re-measure before the first
   release. The hue is provisional until brand work happens and is a single number to change.
4. **DESIGN.md gained product content:** product principles from the spec, an "app window and
   overlay" surfaces section with the overlay's constraints, terminology from ADR 0009, and an
   agent prompt guide. The inherited structure (theme, color strategy, typography, elevation,
   layout, motion, z-index, component rules) is kept with attribution to Conversationaly.
5. **OpenDesign runs from source on the development machine** (`~/.local/opt/open-design`) and is
   registered with Claude Code as a project-local MCP server. New screens are prototyped there
   against this package before they are built in Tauri. The package is kept minimal (no component
   fixtures yet) so it survives OpenDesign's evolving package contract.
6. **Component documentation and screen patterns come after Milestone 0**, when the platform-layer
   screens are designed. This ADR fixes the foundation, not the component library.

## Consequences

- `PRODUCT.md` at the repository root is still Conversationaly's product definition and must be
  rewritten for Backchannel; tracked as follow-up, not part of this decision.
- Storage keys such as `conversationaly.theme` are renamed together with the app rebrand, not here.

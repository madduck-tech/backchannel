# Backchannel — Design

> Category: Product
> Design system of the Backchannel desktop app: a realtime meeting copilot. Restrained tinted
> neutrals, one teal brand hue, the IBM Plex superfamily, border-first elevation. Two surfaces:
> the app window and a compact overlay that lives beside a call.

Every value here exists as a CSS custom property in `frontend/src/app/globals.css` and, where
useful, as a Tailwind token in `frontend/tailwind.config.js`. **`globals.css` is the source of
truth for the app; `tokens.css` next to this file is the same system in the OpenDesign token
contract for prototypes.** Keep the two in sync. No component may hardcode a Tailwind palette
color (`bg-gray-50`, `text-blue-600`, `bg-red-500`). If a color is needed that isn't here, add it
here first.

Provenance: inherited from Conversationaly's design system (MIT) and rebranded. The structure,
contrast discipline and component rules are theirs; the hue, the product principles and the
overlay surface are ours.

## Product principles

The interface exists for five moments: create an agent, start a meeting, get useful help, save a
structured result, ask questions across meetings. Anything that does not serve one of them is
chrome.

- **Agent-centric.** The home screen is *My Agents*. A meeting is something an agent does, not a
  top-level object.
- **Chat first, card beside.** An agent is created and changed by talking to it. The configuration
  card next to the chat shows the current state and updates itself; manual fields are the
  exception, not the workflow.
- **Transcript in the background.** It is captured always and shown on its own tab. It is never the
  main meeting surface.
- **The overlay is quiet.** It shows a hint, a short answer, or a one-line prompt. It never
  competes with the call.
- **Share protection, never stealth.** The overlay can be excluded from screen sharing where the OS
  allows it. The UI says "share protection"; it never says stealth, invisible or undetectable.
- **Manual settings live in Advanced.** The Setup Master (a chat) is the primary way to configure
  the app. Advanced Settings exist for experts and debugging.

## Theme

Two first-class themes. Default follows `prefers-color-scheme`; a manual override persists to
`localStorage` (key currently `conversationaly.theme`, renamed with the app rebrand) and is applied
by an inline script in `<head>` before paint, so there is no flash.

Dark is the primary *working* theme (monitor-lit room, a 90-minute session beside a call). Light is
the primary *reading* theme (bright room, reviewing a meeting). Neither is a downgrade of the
other: they have independent token values, not a filter.

## Color

OKLCH throughout. Hue anchors: **brand 190°** (teal), **danger 25°** (red), **warn 72°** (amber),
**info 262°** (indigo). The brand hue is provisional until brand work happens; changing it is a
single number in `globals.css` and `tokens.css`, because every neutral and every brand token is
tinted toward the same hue.

### Strategy: restrained

Tinted neutrals carry about 92% of every surface. One brand color for identity, primary action and
current selection. Red is not part of the palette; it is a **signal**, reserved for live capture
and destructive actions, and appears nowhere else. Success does not get its own hue: the brand teal
*is* the success color, so "working correctly" and "this product" read as the same thing.

Neutrals are tinted 0.004–0.014 chroma toward 190°. This is below the threshold of "cool-tinted":
it keeps grays from reading as dead digital gray without landing anywhere near cyan.

### Light

| Role | Value | Use |
|---|---|---|
| `--bg` | `oklch(1 0 0)` | Canvas. Pure white: the transcript and the review are documents. |
| `--panel` | `oklch(0.976 0.004 190)` | Sidebar, toolbars, rails. The second neutral layer. |
| `--elevated` | `oklch(1 0 0)` | Popovers, dialogs, menus. Sits on a scrim with a border and a shadow. |
| `--sunken` | `oklch(0.968 0.005 190)` | Input wells, code, inset readouts. |
| `--border` | `oklch(0.912 0.006 190)` | Default hairline. |
| `--border-strong` | `oklch(0.855 0.008 190)` | Input outlines, dividers that must read. |
| `--ink` | `oklch(0.215 0.013 190)` | Body text. About 17.5:1 on `--bg`. |
| `--ink-muted` | `oklch(0.46 0.014 190)` | Secondary text. About 7.1:1, deliberately darker than the usual muted gray. |
| `--ink-faint` | `oklch(0.54 0.012 190)` | Tertiary / metadata. About 5.1:1. |
| `--brand` | `oklch(0.365 0.082 190)` | Primary buttons, active nav, success. Carries white text. |
| `--brand-hover` | `oklch(0.315 0.078 190)` | |
| `--brand-soft` | `oklch(0.955 0.022 190)` | Selection / active-row tint. |
| `--brand-soft-ink` | `oklch(0.33 0.075 190)` | Text on `--brand-soft`. |
| `--danger` | `oklch(0.545 0.205 25)` | Record button, destructive fills. White text. |
| `--danger-ink` | `oklch(0.47 0.19 25)` | Red text on canvas. |
| `--danger-soft` | `oklch(0.962 0.022 25)` | Destructive-state backgrounds. |
| `--warn` / `--warn-ink` / `--warn-soft` | `oklch(0.72 0.15 72)` / `oklch(0.47 0.11 72)` / `oklch(0.966 0.03 72)` | Permission gaps, degraded state, "you are on speakers". |
| `--info` / `--info-ink` / `--info-soft` | `oklch(0.52 0.115 262)` / `oklch(0.52 0.115 262)` / `oklch(0.962 0.018 262)` | Local-model and device readouts. |

### Dark

| Role | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.155 0.004 190)` | Canvas. |
| `--panel` | `oklch(0.185 0.005 190)` | Sidebar, toolbars. |
| `--elevated` | `oklch(0.225 0.006 190)` | Popovers, dialogs. |
| `--sunken` | `oklch(0.125 0.004 190)` | Input wells. |
| `--border` | `oklch(0.285 0.007 190)` | |
| `--border-strong` | `oklch(0.37 0.009 190)` | |
| `--ink` | `oklch(0.945 0.006 190)` | About 16.7:1. |
| `--ink-muted` | `oklch(0.72 0.011 190)` | About 7.9:1. |
| `--ink-faint` | `oklch(0.625 0.01 190)` | About 5.0:1. |
| `--brand` | `oklch(0.8 0.115 190)` | Bright aqua. **Takes dark ink, not white**: `--brand-ink` `oklch(0.16 0.03 190)`. |
| `--brand-soft` | `oklch(0.255 0.032 190)` | |
| `--danger` | `oklch(0.55 0.21 25)` | Held at L 0.55 so white text still passes. |
| `--danger-ink` | `oklch(0.72 0.16 25)` | |

**All three ink tiers clear 4.5:1 against all four surfaces (`bg`, `panel`, `sunken`, `elevated`)
in both themes.** The ratios above were measured at the inherited hue 110°; lightness and chroma
are unchanged by the rotation to 190°, so they hold to within rounding, but re-measure in the
browser before the first release. There is deliberately no "large text only" tier: in a codebase
this size that becomes a footgun the moment someone reaches for the lightest gray on a caption.

The brand flips polarity between themes: a deep teal that carries white text in light, a bright
aqua that carries dark text in dark. This keeps the accent legible without either theme feeling
like a tint of the other.

## Typography

**One superfamily: IBM Plex.** Three optical registers with shared metrics, designed together,
not a pairing of two similar sans.

- **Plex Sans** (`--font-sans`): all UI chrome, labels, buttons, navigation, transcript body,
  overlay text. Speech is not prose; sans is the honest setting for it.
- **Plex Serif** (`--font-serif`): generated summary body and large meeting titles only. The
  review surface is a document and should read like one.
- **Plex Mono** (`--font-mono`): timestamps, durations, model IDs, device names, confidence
  values, file paths, version. Anything that is a *machine fact*.

Fixed rem scale, 16px root, ratio about 1.08 at UI sizes and about 1.2 above. No `clamp()`: users
view at a consistent DPI and a fluid heading in a 256px sidebar looks worse.

| Token | Size / line-height | Use |
|---|---|---|
| `text-2xs` | 11 / 15 | Mono readouts, timestamps |
| `text-xs` | 12 / 17 | Captions, meta, overlay secondary line |
| `text-sm` | 13 / 19 | Dense labels, buttons |
| `text-base` | 14 / 21 | Default UI body, overlay hint |
| `text-md` | 15 / 24 | Transcript body |
| `text-lg` | 17 / 27 | Summary body (serif) |
| `text-xl` | 20 / 27 | Panel titles |
| `text-2xl` | 25 / 31 | Page titles |
| `text-3xl` | 31 / 37 | Meeting title |

Prose measure is capped at 68ch (`--measure`) on the transcript, where the column is the whole
surface. The review document runs the full width of its pane: it carries tables and reference
columns, and the pane is the user's to drag. `text-wrap: balance` on titles, `pretty` on prose.

## Shape & elevation

Radii are tight: instrument, not app-store icon.

`--r-sm 4px` · `--r-md 6px` · `--r-lg 10px` · `--r-xl 14px` · `--r-full 999px`

Elevation is border-first: a hairline always, a shadow only when the element genuinely floats
(popover, dialog, the recording transport, the overlay). Two shadow tokens, `--shadow-pop` and
`--shadow-float`. No shadow on static cards.

## Layout

- Sidebar rail: 304px expanded / 56px collapsed, `--panel`, hairline right border. Expanded on
  launch. Rail rows are set one step down the scale (`text-xs`): the rail is dense navigation.
- Rail zones, in rank order: identity · capture · find · views and lists *(the only scrolling
  zone)* · utilities. The primary action never sits below a scrolling list, and the capture zone
  holds its height across every route and state.
- **One rail axis.** `--rail-gutter` (8px, exposed to Tailwind as `px-gutter`) insets every zone,
  and every row pads by it again, so each row's content box starts at 2×gutter. Hardcoded `px-2`
  / `px-3` / `px-5` in the rail is a bug.
- **Panes are user-resizable, pane widths persist, collapse does not.** Dividers are a 5px hit
  target straddling the hairline the pane already draws: nothing at rest, a `--brand` rule while
  grabbed, double-click to reset. A drag writes the custom property directly, never React state.
- Content max measure 68ch for prose; toolbars and tables run full width.
- Responsive behavior is **structural** (collapse the rail, stack two panes below 1100px), never
  fluid type.
- The recording transport is `position: fixed`, bottom-centered on the content column, and
  offsets with the rail via a CSS variable, not inline style math.

## Surfaces: app window and overlay

The app has two surfaces with different jobs and different constraints.

**App window.** Everything above applies. It is where agents are built, meetings are reviewed and
history is queried. It is open before and after a meeting, rarely during one.

**Overlay.** A compact always-on-top window shown during a meeting, beside a call, often on the
same screen as the video grid. Rules:

- One column, one thing at a time: the current hint or answer, an optional one-line source, and a
  single input row that opens on the hotkey. No navigation, no tabs, no transcript.
- Width 360–480px, height grows with content up to about a third of the screen, then scrolls
  inside. Corner radius `--r-xl`, `--elevated` fill, hairline, `--shadow-float`.
- Text is `text-base` for the hint and `text-xs` for meta. Never smaller: it is read at a glance
  from further away than the app window.
- Contrast is the app's dark theme by default regardless of the app theme, because the overlay
  sits over arbitrary content; the user can pin it to light.
- Hints fade in with an opacity crossfade only and fade out on a timer. No slide, no bounce, no
  badge counters.
- The overlay never uses red except for the live-capture dot. A hint that disagrees with the
  speaker is still `--ink` on `--elevated`; the *kind* of hint is a small mono label, not a color.
- Share protection is a window property, not a visual style. The overlay looks the same whether
  or not the OS excludes it from capture; a small mono readout in its footer states which.
- On Linux under Wayland the overlay is a normal window with the same visual rules.

## Motion

Tokens: `--dur-fast 120ms` · `--dur 180ms` · `--dur-slow 260ms`, easing `--ease`
`cubic-bezier(0.16, 1, 0.3, 1)`.

Motion reports state and nothing else: a level changing, a status advancing, a segment arriving,
a hint appearing, a panel collapsing. There is no page-load choreography; a tool the user opens
forty times a day must not feel slow.

The rail collapse is instant. Animating the rail width and the content column's margin re-ran
layout on every frame, and the thing being re-laid-out is a virtualized transcript that can hold
thousands of rows. Motion may report state; it may not make reporting state cost a relayout.

`prefers-reduced-motion: reduce` collapses all durations to 1ms except opacity crossfades, and
the audio level meter stops animating and renders a static numeric readout instead. Reduced
motion must not remove information.

## Z-index

Semantic scale only. No arbitrary values.

`--z-sticky 200` · `--z-rail 300` · `--z-overlay 400` · `--z-modal 500` · `--z-dropdown 550` ·
`--z-toast 600` · `--z-tooltip 700`

Transient layers (dropdown, select, popover, tooltip) sit **above** modal. They portal to
`<body>`, so a menu opened inside a dialog is a sibling of the dialog, not a child: below it means
invisible.

## Component rules

- Every interactive element ships all seven states: default, hover, focus-visible, active,
  disabled, loading, error. Half a set is a bug.
- One button vocabulary across every screen: `primary` (brand fill), `secondary` (border +
  `--panel`), `ghost` (transparent, hover tint), `danger` (red fill). Sizes `sm` / `md`. Nothing
  else.
- Loading is a skeleton in content areas; a spinner only inside a button or on a control smaller
  than 32px.
- Empty states teach the next action and name it as a button. The empty *My Agents* screen is
  the create-agent chat itself, not a placeholder with an arrow.
- **Two selection languages, never one.** *Chrome* selection (the route you are on, the tab you
  are in) is a filled surface: `--brand-soft` with `--brand-soft-ink` for a rail row, a 2px
  `--brand` underline for a tab strip. *Item* selection (an open meeting, the chosen model, the
  active agent) is a **brand border, never a fill**: a 2px `--brand` edge in the gutter for a
  list row, a `--brand` hairline for a card, and the status word set in `--brand`. `--info` is
  for local-model and device *readouts*, never for selection.
- **Highlight is not selection.** The keyboard/pointer highlight inside a menu, select or command
  list is neutral (`--ink` at 5%). Brand marks the *chosen* item.
- **Fields are wells.** Input, textarea and the select trigger share one treatment: `--sunken`
  fill, `--border-strong` outline, `--brand` border on focus, and the app's one global
  `:focus-visible` ring on top. A primitive must never set `outline-none` to install a ring of
  its own.
- **Tooltips are not brand.** `--elevated` with a hairline and `--shadow-pop`.
- **Two tab voices.** `segmented` is the in-panel switch (sunken track, active option raised to
  `--elevated`); `underline` is the page-level view switcher.
- Floating surfaces (menu, popover, select, tooltip, command, overlay hint) are `--elevated` +
  hairline + `--shadow-pop`, and they **fade only**.
- Focus ring: `2px` `--ring` with a `2px` `--bg` offset, on `:focus-visible` only.
- Recording state is never communicated by color alone: the live indicator is a filled dot
  **plus** the word "Listening" **plus** an elapsed mono timer.
- The agent card is a read-mostly document: label / value pairs in `text-sm`, values in `--ink`,
  labels in `--ink-muted`, sections separated by whitespace, not rules. Editable fields look like
  wells only on hover.

## Agent prompt guide

- When in doubt, subtract. Fewer boxes, less chrome, more space.
- Use the brand color for at most one primary action and the current selection per screen.
- Do not invent color values outside this palette. If a request needs one, leave a comment in
  the artifact and use the closest existing token.
- Prototype the overlay at its real size on a dark video-call background, not on a white canvas.
- Speech and machine facts are sans and mono. Serif is only for the review document.
- Write UI copy in English, sentence case, no exclamation marks. The product never says
  "stealth", "invisible" or "undetectable".

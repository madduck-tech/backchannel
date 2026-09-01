---
paths:
  - "design/**"
  - "frontend/src/app/globals.css"
  - "frontend/tailwind.config.js"
  - "frontend/src/components/ui/**"
  - "frontend/src/app/**/*.tsx"
  - "frontend/src/components/**/*.tsx"
---
# Design-system rules

Source of truth: `design/backchannel/DESIGN.md` for intent and rules; `frontend/src/app/globals.css`
for app token values; `design/backchannel/tokens.css` for prototype token values.

- A change to a token, a component rule or a surface constraint touches `DESIGN.md`, `tokens.css`
  and `globals.css` in the same commit. Never one without the others.
- Token names in the app are not renamed. New tokens are added to all three files and documented.
- No component hardcodes a Tailwind palette color (`bg-gray-50`, `text-blue-600`). Use the semantic
  tokens: `canvas`, `panel`, `elevated`, `sunken`, `line`, `ink`, `brand`, `danger`, `warn`, `info`.
- Red is a signal (live capture, destructive actions), never decoration. Success uses `brand`.
- Every interactive element ships all seven states. Floating surfaces fade only. No mount choreography.
- The overlay follows `DESIGN.md` § "Surfaces: app window and overlay": one column, one thing at a
  time, dark theme by default, no red except the live dot, no tabs, no transcript.
- Prototypes are made in OpenDesign against the `backchannel` design system and are committed to
  `design/prototypes/` only after the maintainer has seen and approved them. They are references;
  the app ports them into React with the same token names, it never embeds the HTML.
- Design-system files and the shadcn primitives in `components/ui/` are shared by every screen:
  a change there is reviewed as a system change, not a screen change.

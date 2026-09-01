# Backchannel Usage

Package guide for OpenDesign agents and reviewers.

## Read order

1. Read this file to understand the package contract.
2. Read `DESIGN.md` for product principles, visual intent, constraints and the two surfaces.
3. Paste the `:root` block of `tokens.css` into the first `<style>` of the artifact before writing
   component CSS. Add the `.dark` block when prototyping the overlay or the dark theme.
4. Reuse the component rules in `DESIGN.md` before inventing new controls; the app's primitives
   are shadcn/ui-based and live in `frontend/src/components/ui/`.

## Design highlights

- Canvas `--bg` pure white in light, `oklch(0.155 0.004 190)` in dark; surfaces are tinted neutrals.
- One brand color `--accent` (teal 190°) for identity, primary action and selection. It is also the success color.
- Red `--danger` is a signal: live capture and destructive actions only.
- IBM Plex Sans for UI and speech, Plex Serif for the review document, Plex Mono for machine facts.
- Elevation is border-first; shadows only on things that float.

## Do

- Keep the token names exactly; overwrite values, never rename keys.
- Prototype the overlay at 360–480px wide on a dark video-call background.
- Use `--accent` at most for one primary action and the current selection per screen.
- Write UI copy in English, sentence case.

## Avoid

- Raw color values outside the pasted `:root` block.
- Red for anything that is not live capture or destruction.
- The words "stealth", "invisible", "undetectable" anywhere in the UI.
- Page-load choreography; motion reports state only.

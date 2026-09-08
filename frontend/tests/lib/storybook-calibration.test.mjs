// The catalogue measures this application, or it measures nothing. (#124 condition 1)
//
// Every geometry assertion a story makes is a multiple of one quantity: the width of a `ch`. That
// resolves against the **loaded** face, and this application's face arrives through a content-hashed
// class `next/font` generates, which `layout.tsx` puts on `<body>`. A story renders a component, not
// `layout.tsx`.
//
// Measured while writing this, in headless Chrome over the project's compiled CSS:
//
//     without the class   --font-sans: (undefined)   60ch @14px = 480.469px
//     with the class      --font-sans: "IBM Plex…"   60ch @14px = 503.984px
//
// 23.515px, 4.8% — the same error `transcript-matches-the-prototype.test.mjs:8` records as 8.0078px
// against 8.3998px per `ch`. It produces plausible numbers rather than an error, so an unguarded
// catalogue would not fail; it would quietly publish figures 4.8% small, and the natural repair would
// be to write them into the assertions.
//
// **A colour token cannot stand in for this.** #124 v1 nominated one: `getComputedStyle` on
// `bg-brand-soft` returns `oklch(0.955 0.022 190)` with the font class and without it, measured. The
// guard has to be the font.
//
// **The family string alone cannot either.** `next/font` emits `"IBM Plex Sans Fallback"` as a
// metric-adjusted local face, so `--font-sans` can hold the right value while the woff2 never loads.
// Hence `document.fonts.check`, and hence the width.
import assert from 'node:assert/strict';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

/** Measured on this machine's Google Chrome. See TOLERANCE. */
const CH60_WITH_PLEX = 503.984;
const CH60_FALLBACK = 480.469;
/**
 * Chosen once, here, rather than widened later to make something pass. It has to be far below the
 * 23.5px it exists to catch and above the last-decimal drift between Chromium builds.
 */
const TOLERANCE = 0.75;

const sb = await serveStorybook();
const b = await browser();

const read = `() => {
  const el = document.querySelector('[data-probe="ch60"]');
  return {
    ch60: parseFloat(getComputedStyle(el).width),
    family: getComputedStyle(el).fontFamily.split(',')[0].replace(/"/g, ''),
    plexLoaded: document.fonts.check("14px 'IBM Plex Sans'"),
    bodyFontSize: getComputedStyle(document.body).fontSize,
  };
}`;

const m = await b.evaluate(
  storyUrl(sb.origin, 'instrument-typography--calibration'),
  read,
  { readyFn: `document.querySelector('[data-probe="ch60"]')` }
);

// --- the application's face is loaded, not merely named ------------------------------------------
assert.equal(
  m.plexLoaded, true,
  `the story is not drawing with IBM Plex Sans. Its first family is ${JSON.stringify(m.family)} and\n` +
    `  a 60ch box measures ${m.ch60}px. Every geometry assertion in this catalogue is now wrong.`
);
assert.equal(m.family, 'IBM Plex Sans', `first family was ${JSON.stringify(m.family)}`);

// --- and the number proves it, because the family string can be right while the face is missing ---
assert.ok(
  Math.abs(m.ch60 - CH60_WITH_PLEX) <= TOLERANCE,
  `60ch measured ${m.ch60}px; expected ${CH60_WITH_PLEX} ± ${TOLERANCE}.\n` +
    `  ${Math.abs(m.ch60 - CH60_FALLBACK) <= TOLERANCE
      ? 'That is the fallback face — the next/font class is not reaching the story.'
      : 'Neither this application\'s face nor the known fallback.'}`
);

// --- the rest of the application's type scale comes with it ---------------------------------------
assert.equal(
  m.bodyFontSize, '14px',
  `body is ${m.bodyFontSize}; globals.css sets 0.875rem, so the app stylesheet is not applied`
);

await b.close();
await sb.stop();
console.log(`ok - the catalogue draws with the application's face: 60ch = ${m.ch60}px, body 14px`);

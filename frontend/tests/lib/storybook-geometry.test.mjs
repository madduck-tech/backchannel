// The transcript's width rule, measured rather than declared. (#124 condition 2)
//
// `transcript-matches-the-prototype.test.mjs` reads numbers out of the committed prototype and
// compares them to numbers in the source. It is a **declaration** check: it cannot see a rendered
// pixel, which is why #118's approved variant lost the side entirely at the minimum window and the
// loss was found by hand. This one lays the component out in a real browser and reads the boxes.
//
// **Two cells, two controls, and that is the point.** #124 v1 offered one — revert `min(60ch, 78%)`
// to bare `78%` — which moves the wide cell and leaves the narrow one identical, because at a 400px
// content box 78% is already the smaller term. The narrow cell is where the regression the issue
// cites actually lived, so it gets its own mutation: bare `60ch`, which at 400px overflows the box
// and collapses the offset to nothing.
import assert from 'node:assert/strict';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

/**
 * #118's table, as content boxes. The component carries 16px of padding each side, so the pane is
 * 32px wider — measured here, not assumed: `pad` is read from the story on every run and a change to
 * it fails the assertion below rather than silently shifting every other number.
 */
const CELLS = [
  { story: 'transcript-width--wide-pane', pane: 1096, content: 1064, bubble: 503.98, offset: 560.02 },
  { story: 'transcript-width--narrow-pane', pane: 432, content: 400, bubble: 312, offset: 88 },
];
/** A `ch` is a font advance width; the last decimal moves between Chromium builds. */
const TOLERANCE = 0.75;

const read = `() => {
  const pane = document.querySelector('[data-pane]');
  const pb = pane.getBoundingClientRect();
  // Selected on the semantic attribute, never on the class under test: a selector that names
  // \`60ch\` finds nothing the moment a control removes it, and "found 0 bubbles" is a selector
  // artifact rather than a measurement. Caught exactly that way while writing this (#124).
  const rects = [...pane.querySelectorAll('article[aria-label]')]
    .map((e) => e.getBoundingClientRect());
  if (rects.length < 2) return { bubbles: rects.length };
  const pad = Math.min(...rects.map((r) => r.left - pb.left));
  const content = pb.width - 2 * pad;
  return {
    bubbles: rects.length,
    pane: +pb.width.toFixed(2),
    pad,
    content: +content.toFixed(2),
    bubble: +rects[0].width.toFixed(2),
    offset: +(content - rects[0].width).toFixed(2),
    widths: rects.map((r) => +r.width.toFixed(2)),
  };
}`;

const sb = await serveStorybook();
const b = await browser();

for (const cell of CELLS) {
  const m = await b.evaluate(storyUrl(sb.origin, cell.story), read, {
    readyFn: `document.querySelector('[data-pane]')`,
    
  });

  assert.equal(m.bubbles, 2, `${cell.story}: expected two sides, found ${m.bubbles} capped bubbles`);
  assert.equal(m.pad, 16, `${cell.story}: the component's padding is ${m.pad}px, not the 16 these numbers assume`);
  assert.equal(m.content, cell.content, `${cell.story}: content box is ${m.content}, expected ${cell.content}`);

  assert.ok(
    Math.abs(m.bubble - cell.bubble) <= TOLERANCE,
    `${cell.story}: a side is ${m.bubble}px wide; ${cell.bubble} ± ${TOLERANCE} is what #118 approved.\n` +
      `  At a ${cell.content}px content box the cap is min(60ch, 78%) = min(503.98, ${(cell.content * 0.78).toFixed(2)}).`
  );

  assert.ok(
    Math.abs(m.offset - cell.offset) <= TOLERANCE,
    `${cell.story}: the corridor beside a side is ${m.offset}px, expected ${cell.offset} ± ${TOLERANCE}.\n` +
      `  ${m.offset < 1 ? 'It has collapsed — the two sides no longer read as two.' : ''}`
  );

  assert.deepEqual(
    m.widths, [m.bubble, m.bubble],
    `${cell.story}: the two sides are ${m.widths.join(' and ')}px — the cap is not applying to both`
  );
}

await b.close();
await sb.stop();
console.log('ok - the transcript keeps #118\'s corridor at both widths: 1064→503.98/560.02, 400→312/88');

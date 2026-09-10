// Choosing a remote summariser puts its key field where the person can see it. (#138 condition 3)
//
// On 2026-09-08 the product owner chose OpenAI and reported that nothing happened. The field was
// there — `SummariserStep.tsx:86-91` holds `apiKey` and gates Continue on it — it was below the fold.
//
// **The window is 720x520, and the height is the point.** `tauri.conf.json` has `minWidth: 720,
// minHeight: 520`; a field below the fold is a height problem, and the issue's first version named
// only the width, at which this assertion could not fail — every instrument here defaults to 900.
import assert from 'node:assert/strict';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

const STORY = 'onboarding-summariser--fresh';
/** `tauri.conf.json:18-19`. Read as numbers here so a change there makes this stale, not silently wrong. */
const WINDOW = { width: 720, height: 520 };

/**
 * The order a person reads down, and where the field lands.
 *
 * The group order is a rendering decision, so a source check cannot see it: reversing the two groups
 * in `SummariserStep.tsx` leaves every declaration check green, because they read the `OPTIONS`
 * array and the array is not what is on screen. Measured here instead.
 */
const pickAndMeasure = `async () => {
  const remote = [...document.querySelectorAll('button, [role=radio], [role=button], div[class*="cursor-pointer"]')]
    .find((e) => /OpenAI/.test(e.textContent || ''));
  if (!remote) return { picked: false };
  remote.click();
  await new Promise((r) => setTimeout(r, 500));

  const field = document.querySelector(
    'input[type=password], input[placeholder*="key" i], input[aria-label*="key" i]'
  );
  if (!field) return { picked: true, field: false };
  const groups = [...document.querySelectorAll('div')]
    .map((d) => (d.children.length === 0 ? (d.textContent || '').trim() : ''))
    .filter((t) => t === 'ON THIS MACHINE' || t === 'SENT TO A PROVIDER');
  const r = field.getBoundingClientRect();
  return {
    picked: true, field: true,
    rect: [Math.round(r.top), Math.round(r.bottom)],
    viewport: window.innerHeight,
    inView: r.top >= 0 && r.bottom <= window.innerHeight,
    groups,
    insideOption: !!field.closest('[role=radio]'),
  };
}`;

const sb = await serveStorybook();
const b = await browser();

const m = await b.evaluate(storyUrl(sb.origin, STORY), pickAndMeasure, {
  readyFn: `/Where should the summary be written/.test(document.body.innerText)`,
  viewport: WINDOW,
});

await b.close();
await sb.stop();

assert.equal(m.picked, true, 'no remote provider to choose on the summariser screen');
assert.equal(m.field, true, 'choosing a remote provider revealed no key field at all');
assert.ok(
  m.inView,
  `the key field is at ${m.rect?.join('..')} in a ${m.viewport}px viewport — below the fold.\n` +
    '  The person sees nothing happen, which is what was reported. The approved prototype scrolls the\n' +
    '  chosen option to the top and opens the field inside it.'
);

assert.deepEqual(
  m.groups, ['ON THIS MACHINE', 'SENT TO A PROVIDER'],
  `the approved order is what runs here first, what leaves second; got ${JSON.stringify(m.groups)}`
);
assert.ok(
  m.insideOption,
  'the key field must open inside the chosen option — that is what `c-inline-scroll` is, and a\n' +
    '  sibling of the list is where it was when the product owner could not see it'
);

console.log(
  `ok - the key field is inside its option and in view at ${WINDOW.width}x${WINDOW.height}, ` +
    'and the groups read local first'
);

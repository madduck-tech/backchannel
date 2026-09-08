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

/** Choose the remote provider, let the reveal settle, then measure where its field landed. */
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
  const r = field.getBoundingClientRect();
  return {
    picked: true, field: true,
    rect: [Math.round(r.top), Math.round(r.bottom)],
    viewport: window.innerHeight,
    inView: r.top >= 0 && r.bottom <= window.innerHeight,
  };
}`;

const sb = await serveStorybook();
const b = await browser();

const m = await b.evaluate(storyUrl(sb.origin, STORY), pickAndMeasure, {
  readyFn: `/Choose a summariser/.test(document.body.innerText)`,
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

console.log(`ok - the key field is in view at ${WINDOW.width}x${WINDOW.height}`);

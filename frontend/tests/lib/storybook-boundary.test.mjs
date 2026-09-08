// A story that reaches the backend fails loudly. (#124 condition 4)
//
// The alias in `.storybook/main.ts` points `@tauri-apps/api/core` at `.storybook/tauri-boundary.ts`.
// Without it a component calling `invoke` from a story waits on a `window.__TAURI_INTERNALS__` that
// is not there, and a hang is worse than a throw: it reads as a slow render, and the driver reports a
// timeout instead of the reason.
//
// The sentence is deliberately the one `tests/lib/tauri-stubs.mjs` throws. Two boundaries that
// disagree are how a catalogue starts describing a different application, and this test is what holds
// them in step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

// --- the two boundaries throw the same sentence ---------------------------------------------------
const SENTENCE = 'invoked an unstubbed command: ';
for (const file of ['tauri-stubs.mjs', '../../.storybook/tauri-boundary.ts']) {
  const body = fs.readFileSync(path.join(here, file), 'utf8');
  assert.ok(
    body.includes(SENTENCE),
    `${file} no longer throws \`${SENTENCE}<cmd>\`. The jsdom boundary and the browser boundary have ` +
      'drifted, and a component will behave differently in the catalogue than under test.'
  );
}

// --- and the browser one actually fires ------------------------------------------------------------
const sb = await serveStorybook();
const b = await browser();
const m = await b.evaluate(
  storyUrl(sb.origin, 'instrument-boundary--unstubbed-command'),
  `() => ({ state: document.querySelector('[data-boundary]').dataset.boundary })`,
  { readyFn: `document.querySelector('[data-boundary]') &&
              document.querySelector('[data-boundary]').dataset.boundary !== 'pending'` }
);

assert.equal(
  m.state, `${SENTENCE}check_first_launch`,
  `a story invoked a command no story declared and got ${JSON.stringify(m.state)}.\n` +
    '  "resolved" means the boundary answered something it should not have; anything else means the\n' +
    '  alias is not in place and the real bridge was reached.'
);

await b.close();
await sb.stop();
console.log('ok - a story reaching an undeclared command throws, and both boundaries say the same thing');

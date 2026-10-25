// A model outside the recommended four shows its size before its first progress event. (#166 condition 7)
//
// The download screen took the chosen model's size from the frontend, which carries only the four
// recommended models. Every other model read "0 of 0 MB" until the HTTP response, and #166 made 82 more
// models choosable in first run. The size is now the catalogue's, read from the backend.
//
// **Rendered in a browser, from the story.** The window is one request long in the real application:
// the first progress event arrives with the HTTP response (`engine.rs:431-433`), so a polling pass
// cannot see it. The story's download is accepted and never finishes, so no progress event comes.
import assert from 'node:assert/strict';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

const STORY = 'onboarding-download--chosen-outside-the-four';

const readRow = `async () => {
  await new Promise((r) => setTimeout(r, 400));
  const row = document.querySelector('section[aria-label="whisper-tiny-q8"]');
  return {
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    row: row ? (row.innerText || '').replace(/\\s+/g, ' ').trim() : null,
  };
}`;

const sb = await serveStorybook();
const b = await browser();
const seen = await b.evaluate(storyUrl(sb.origin, STORY), readRow, {
  readyFn: `!!document.querySelector('section[aria-label="whisper-tiny-q8"]')`,
});
await b.close();
await sb.stop();

assert.ok(seen.row, `no row for the chosen model whisper-tiny-q8.\n  Page read: "${seen.body}"`);
assert.ok(
  !/\b0 of 0 MB\b/.test(seen.row),
  `the chosen model's row reads "0 of 0 MB" before its first progress event.\n  Whole row: "${seen.row}"`
);
assert.match(
  seen.row, /\b0 of 44 MB\b/,
  `the chosen model's row does not state the catalogue's 44 MB.\n  Whole row: "${seen.row}"`
);

console.log("ok - a model outside the recommended four shows the catalogue's size before its first progress event");

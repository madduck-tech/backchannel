// A file already on disk is stated, not drawn as a progress bar over a zero counter. (#138 defect 4)
//
// The product owner photographed this screen showing `0.0 MB / 705.3 MB` while the file was already
// there. `ceb57a1` fixed the *behaviour* behind it — the download follows the model the person chose
// — and left the readout alone, because the behaviour and the readout are different code.
//
// **Rendered, not read from source, and that distinction is the whole reason this file exists.** Two
// controls for the declaration version of this check failed to land: one put the wording in a JS
// comment (never reaches the page), one anchored on `parakeetDownloaded`, which occurs 13 times in
// the component. A source regex for *"already"* matches `parakeetDownloaded` and a `console.log`; a
// rendered one cannot.
//
// The approved prototype is `design/prototypes/onboarding-download.html` (`a-two-rows`): the present
// row carries the sentence "Already here from an earlier install. Nothing to fetch." and **no bar**.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STORY = 'onboarding-download--one-already-on-disk';

// The decision is read out of the approved prototype rather than retyped, so a change there makes
// this check stale instead of silently asserting a wording nobody approved.
const proto = fs.readFileSync(
  path.join(root, 'design', 'prototypes', 'onboarding-download.html'), 'utf8'
);
const PRESENT_LINE = /Already here from an earlier install\. Nothing to fetch\./;
assert.ok(
  PRESENT_LINE.test(proto),
  'the approved download prototype no longer carries the present-row sentence this check follows'
);

/**
 * Read the two rows as a person sees them: their text, and whether each draws a bar.
 *
 * Located by `<section aria-label>`, which is the approved arrangement's own handle. It used to look
 * for `<h3>Summary Engine</h3>`: #154 built `a-two-rows`, where a row is named by the file it is
 * fetching — `gemma4:e2b`, `parakeet-tdt-0.6b-v3-q8` — so a name from the layout before it can no
 * longer be found. The assertions below are unchanged.
 */
const readRows = `async () => {
  await new Promise((r) => setTimeout(r, 400));
  const cards = [...document.querySelectorAll('section[aria-label]')];
  return {
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    rows: cards.map((c) => ({
      text: (c.innerText || '').replace(/\\s+/g, ' ').trim(),
      bars: c.querySelectorAll('div[style*="width"]').length,
    })),
  };
}`;

const sb = await serveStorybook();
const b = await browser();
const seen = await b.evaluate(storyUrl(sb.origin, STORY), readRows, {
  readyFn: `/Getting the/.test(document.body.innerText)`,
});
await b.close();
await sb.stop();

const summary = seen.rows.find((r) => /Writes the summary when a meeting ends/.test(r.text));
assert.ok(summary, `no summary row rendered.\n  Page read: "${seen.body}"`);

// 1. The zero counter itself. This is the pixel the product owner photographed.
const counter = summary.text.match(/[\d.]+ Mi?B \/ [\d.]+ Mi?B/);
assert.equal(
  counter, null,
  `the already-present row renders a byte counter: "${counter?.[0]}"\n` +
    `  Whole row: "${summary.text}"\n` +
    '  Nothing is being fetched, so there are no bytes to count. The approved prototype states\n' +
    '  presence in a sentence and gives the row no bar at all.'
);

// 2. And it says so, in words a person reads — not a tick alone, and not a log line.
assert.match(
  summary.text, /already/i,
  `the already-present row never says the file is already here.\n  Whole row: "${summary.text}"\n` +
    `  The prototype's sentence is: ${PRESENT_LINE.source.replace(/\\\\/g, '')}`
);

console.log('ok - a file already on disk is stated in words, with no bytes counted');

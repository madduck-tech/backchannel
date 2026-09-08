// An open menu, which nothing in this repository could render before. (#124 condition 3)
//
// `dom-harness.mjs` records that Radix popovers are never opened under jsdom, and the whole suite
// contains one `.click()`. So every item that lives behind the meeting action bar's overflow menu was
// asserted by reading the source, never by seeing it.
//
// **The click has to be a real pointer.** Measured while writing this: `el.click()` on the trigger
// returns cleanly, throws nothing, and opens no menu — Radix listens for `pointerdown`. That is
// exactly the shape `.claude/rules/testing.md` names, one level in: a call that returned success and
// did nothing. `browser.mjs` dispatches through CDP's Input domain instead.
import assert from 'node:assert/strict';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

const STORY = 'meetingdetails-actionbar--narrow';
const TRIGGER = '[aria-label="More actions"]';
/** What the bar hides below its `@[560px]/bar` breakpoint, plus the item that is always there. */
const EXPECTED = ['Retranscribe', 'Label speakers', 'Open meeting folder'];

const items = `() => ({
  items: [...document.querySelectorAll('[role=menuitem]')].map((e) => e.textContent.trim()),
})`;

const sb = await serveStorybook();
const b = await browser();
const ready = `document.querySelector('[data-bar-pane]')`;

// --- closed, the items are not merely hidden — they are not rendered ------------------------------
const closed = await b.evaluate(storyUrl(sb.origin, STORY), items, { readyFn: ready });
assert.deepEqual(
  closed.items, [],
  `the menu's items are in the DOM before it is opened: ${closed.items.join(', ')}.\n` +
    '  Then the assertion below would pass without the menu ever opening.'
);

// --- opened with a real pointer -------------------------------------------------------------------
const open = await b.evaluate(storyUrl(sb.origin, STORY), items, {
  readyFn: ready,  clickFirst: TRIGGER,
});
assert.deepEqual(
  open.items, EXPECTED,
  `the overflow menu offered ${JSON.stringify(open.items)}; expected ${JSON.stringify(EXPECTED)}.\n` +
    '  An empty list usually means the pointer event did not reach Radix, not that the items are gone.'
);

await b.close();
await sb.stop();
console.log(`ok - the action bar's overflow menu opens and offers ${EXPECTED.length} items`);

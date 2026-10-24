// The meeting's action bar is one row that fits, at every room the application can give it. (#165)
//
// The product owner photographed it as a tall capsule: `recorded 1:13`, Copy and `•••` stacked one
// under another. Measured in Chrome at `main` `ccd3f42`: 26 × 115 at every pane width. `@container/bar`
// and `w-fit` sat on one box; inline-size containment sized that box as if empty, and `w-fit`
// resolved to the empty width, which is the bar's own padding and border.
//
// The target is prototype `114-meeting-controls.html` with the product owner's decisions of
// 2026-10-24: wide shows Copy · Retranscribe · Speakers · Open folder with no `•••`; narrow shows
// Copy · `•••`; the breakpoint is where the wide arrangement fits on one row with the longest recorded
// time, so the bar is one row everywhere.
//
// **Every condition is evaluated, and every failure is reported.** Nothing stops at the first one,
// because #165's controls are read as a matrix: under each mutation, which conditions went red. A
// test that stopped early would hide the neighbours, and two rounds of the critic showed that
// predicting them by hand gets rows wrong.
//
// Conditions (numbered as in #165): 1 one row · 2 content-sized · 3 wide renders the three ·
// 4 wide renders no `•••` · 5 narrow drops the three · 6 narrow renders `•••` · 7a/7b the menu's items
// · 8 N is the measured rule · 9 the nearest `bar` container is the toolbar's parent · 10 an open menu
// closes when the bar turns wide · 12 it fits · 13 N exists once. Condition 11 is the application, in
// `stage2-core-check.sh`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from './browser.mjs';
import { serveStorybook, storyUrl } from './storybook-server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // frontend/
const COMPONENT = path.join(root, 'src/components/MeetingDetails/MeetingActionBar.tsx');
const STORIES = path.join(root, 'src/components/MeetingDetails/MeetingActionBar.stories.tsx');
const PAGE = path.join(root, 'src/app/meeting-details/page-content.tsx');

const failures = [];
const fail = (c, msg) => failures.push(`[${c}] ${msg}`);
const check = (c, ok, msg) => { if (!ok) fail(c, msg); };

/** Comments out, so a number explained in a comment is not mistaken for a second copy of it. */
const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// --- 13: N exists once, in CSS ----------------------------------------------------------------------
// A JavaScript copy compared with the wrapper's width could drift from the class, and nothing that
// renders would show it until it did. Read in the component and the local modules it imports.
const component = code(fs.readFileSync(COMPONENT, 'utf8'));
const classN = [...component.matchAll(/@\[(\d+)px\]\/bar:/g)].map((m) => Number(m[1]));
const N = classN[0];
check(13, classN.length > 0 && classN.every((n) => n === N), `the bar's breakpoint classes disagree: ${classN.join(', ')}`);
const localImports = [...component.matchAll(/from\s+'((?:\.|@\/)[^']+)'/g)].map((m) => m[1]);
const sources = [['MeetingActionBar.tsx', component]];
for (const spec of localImports) {
  const base = spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2)) : path.resolve(path.dirname(COMPONENT), spec);
  const file = [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
  if (file) sources.push([path.relative(root, file), code(fs.readFileSync(file, 'utf8'))]);
}
for (const [name, text] of sources) {
  const strays = [...text.matchAll(new RegExp(`\\b${N}\\b`, 'g'))].filter(
    (m) => !text.slice(Math.max(0, m.index - 2), m.index + String(N).length + 9).startsWith(`@[${N}px]/bar`)
  );
  check(13, strays.length === 0, `${name} holds ${strays.length} copy(ies) of ${N} outside the @[${N}px]/bar classes`);
  check(
    13,
    !/(clientWidth|offsetWidth|contentRect\.width|getBoundingClientRect\(\)\.width)\s*[<>]=?\s*[1-9]/.test(text),
    `${name} compares a width with a number: the close must follow the trigger's box, not a copy of N`
  );
}
check(13, /new ResizeObserver\(/.test(component) && /observer\.observe\(el\)/.test(component) && /const el = trigger\.current/.test(component),
  'the menu close must observe the `•••` trigger itself');

// --- the story's host is the page's host ------------------------------------------------------------
const pageHost = /<div className="([^"]+)">\s*<MeetingActionBar/.exec(fs.readFileSync(PAGE, 'utf8'))?.[1];
const storyHost = /const BAR_HOST_CLASSES = '([^']+)'/.exec(fs.readFileSync(STORIES, 'utf8'))?.[1];
check('host', pageHost && pageHost === storyHost, `the story's host (${storyHost}) is not the page's (${pageHost}), so the room measured here is not the application's`);

// --- the measurements, in Chrome -----------------------------------------------------------------------
const measure = (rooms) => `async () => {
  const pane = document.querySelector('[data-bar-pane]');
  const bar = document.querySelector('[role="toolbar"][aria-label="Meeting actions"]');
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const rendered = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out = [];
  for (const room of ${JSON.stringify(rooms)}) {
    pane.style.width = (room + 32) + 'px';
    await frame();
    const cs = getComputedStyle(bar);
    const px = (k) => parseFloat(cs[k]);
    // The rendered flex items. The three wide controls sit in a \`display: contents\` group, which has
    // no box, so the toolbar's direct children are not the items.
    const items = [];
    for (const child of bar.children) {
      if (getComputedStyle(child).display === 'contents') items.push(...child.children);
      else items.push(child);
    }
    const boxes = items.filter(rendered).map((e) => e.getBoundingClientRect());
    const br = bar.getBoundingClientRect();
    const content = {
      left: br.left + px('borderLeftWidth') + px('paddingLeft'),
      right: br.right - px('borderRightWidth') - px('paddingRight'),
      top: br.top + px('borderTopWidth') + px('paddingTop'),
      bottom: br.bottom - px('borderBottomWidth') - px('paddingBottom'),
    };
    const words = (w) => [...bar.querySelectorAll('button')].some((b) => b.textContent.trim() === w && rendered(b));
    const wrapper = bar.parentElement;
    out.push({
      room,
      roomRead: wrapper.getBoundingClientRect().width,
      height: br.height,
      width: br.width,
      oneRowMax: Math.max(...boxes.map((b) => b.height)) + px('paddingTop') + px('paddingBottom') + px('borderTopWidth') + px('borderBottomWidth') + 1,
      natural: boxes.reduce((a, b) => a + b.width, 0) + Math.max(0, boxes.length - 1) * px('columnGap') + px('paddingLeft') + px('paddingRight') + px('borderLeftWidth') + px('borderRightWidth'),
      outside: boxes.filter((b) => b.left < content.left - 0.5 || b.right > content.right + 0.5 || b.top < content.top - 0.5 || b.bottom > content.bottom + 0.5).length,
      three: ['Retranscribe', 'Speakers', 'Open folder'].filter(words),
      trigger: rendered(bar.querySelector('[aria-label="More actions"]')),
      containerName: getComputedStyle(wrapper).containerName,
      hostContainer: getComputedStyle(wrapper.parentElement).containerType,
    });
  }
  return out;
}`;

const sb = await serveStorybook();
const b = await browser();
const ready = `document.querySelector('[role="toolbar"][aria-label="Meeting actions"]')`;
const at = (story, rooms, opts = {}) =>
  b.evaluate(storyUrl(sb.origin, `meetingdetails-actionbar--${story}`), measure(rooms), { readyFn: ready, viewport: { width: 1200, height: 900 }, ...opts });

// --- 8: N is the product owner's rule, measured -------------------------------------------------------
// Derived here, never read from the class: an N larger than the rule passes every other condition.
const [widest] = await at('sized-longest', [864]);
const N0 = Math.ceil(widest.natural) + 32;
check(8, N === N0, `the class's breakpoint is ${N}px; the rule measures ${N0}px (widest natural width ${widest.natural.toFixed(2)} + 32)`);

const ROOMS = [864, 688, 588, N0, N0 - 1, 448, 400];
const CASES = [
  ['sized', true], ['sized-longest', true], ['sized-hours', true], ['sized-unknown-length', true], ['sized-no-retranscribe', false],
];
for (const [story, retranscribe] of CASES) {
  for (const m of await at(story, ROOMS)) {
    const where = `${story} @ room ${m.room}`;
    const wide = m.room >= N0;
    check('room', Math.abs(m.roomRead - m.room) < 0.5, `${where}: the wrapper is ${m.roomRead.toFixed(1)}px, not the room set`);
    check(1, m.height <= m.oneRowMax, `${where}: ${m.width.toFixed(0)} × ${m.height.toFixed(0)} is not one row (at most ${m.oneRowMax.toFixed(1)})`);
    check(12, m.outside === 0, `${where}: ${m.outside} control(s) lie outside the bar's content box`);
    check(9, m.containerName === 'bar' && m.hostContainer === 'normal', `${where}: container-name on the toolbar's parent is "${m.containerName}", host container-type "${m.hostContainer}"`);
    if (wide) {
      check(2, m.width <= m.natural + 1 && m.width < m.room, `${where}: ${m.width.toFixed(1)}px wide against a natural ${m.natural.toFixed(1)}px in a ${m.room}px room — not content-sized`);
      const want = retranscribe ? ['Retranscribe', 'Speakers', 'Open folder'] : ['Open folder'];
      check(3, JSON.stringify(m.three) === JSON.stringify(want), `${where}: wide renders [${m.three}], expected [${want}]`);
      check(4, !m.trigger, `${where}: a wide bar renders \`•••\``);
    } else {
      check(5, m.three.length === 0, `${where}: narrow renders [${m.three}] on the bar`);
      check(6, m.trigger, `${where}: narrow renders no \`•••\``);
    }
  }
}
// The flip itself, on the widest case: narrow just below N₀, wide at it.
const [below, atN] = await at('sized-longest', [N0 - 1, N0]);
check(8, below.trigger && !atN.trigger, `the widest case does not flip at ${N0}: \`•••\` rendered ${below.trigger} at ${N0 - 1}, ${atN.trigger} at ${N0}`);

// --- 7: the menu, opened at room 448 ---------------------------------------------------------------
const items = `() => [...document.querySelectorAll('[role=menuitem]')].map((e) => e.textContent.trim())`;
const menu = async (story) => b.evaluate(storyUrl(sb.origin, `meetingdetails-actionbar--${story}`), items, { readyFn: ready, clickFirst: '[aria-label="More actions"]' });
const withIt = await menu('narrow');
check('7a', JSON.stringify(withIt) === JSON.stringify(['Retranscribe', 'Label speakers', 'Open meeting folder']), `the menu offers ${JSON.stringify(withIt)}`);
const without = await menu('narrow-no-retranscribe');
check('7b', JSON.stringify(without) === JSON.stringify(['Open meeting folder']), `with no meeting folder the menu offers ${JSON.stringify(without)}`);

// --- 10: an open menu closes when the bar turns wide --------------------------------------------------
// Seen open first: absence alone is also true of a menu that never opened (#157, #160). And read as
// `data-state`, because the content has an exit animation and lingers in the DOM while it closes.
const resize = `async () => {
  const pane = document.querySelector('[data-bar-pane]');
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const state = () => document.querySelector('[role=menu]')?.getAttribute('data-state') ?? 'absent';
  pane.style.width = (${N0 - 1} + 32) + 'px'; await frame(); await new Promise((r) => setTimeout(r, 150));
  const before = state();
  pane.style.width = (${N0} + 32) + 'px'; await frame(); await new Promise((r) => setTimeout(r, 400));
  return { before, after: state() };
}`;
const closing = await b.evaluate(storyUrl(sb.origin, 'meetingdetails-actionbar--narrow'), resize, { readyFn: ready, clickFirst: '[aria-label="More actions"]' });
check(10, closing.before === 'open', `the menu was not open at room ${N0 - 1} before the resize (${closing.before}), so its closing would prove nothing`);
check(10, closing.after === 'closed' || closing.after === 'absent', `the menu is still "${closing.after}" after the bar turned wide at room ${N0}`);

await b.close();
await sb.stop();

if (failures.length) {
  const red = [...new Set(failures.map((f) => f.slice(1, f.indexOf(']'))))];
  console.error(`RED CONDITIONS: ${red.join(' ')}`);
  assert.fail(`${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
}
console.log(
  `ok - the action bar is one row that fits at rooms ${ROOMS.join(', ')} for ${CASES.length} data cases; ` +
    `it turns wide at ${N0}px, the measured rule (widest natural ${widest.natural.toFixed(2)} + 32); wide renders ` +
    `the three and no \`•••\`, narrow the reverse; the menu lists its items and closes when the bar turns wide`
);

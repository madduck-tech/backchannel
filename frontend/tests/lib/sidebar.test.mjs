// What the sidebar does to the meetings list, driven rather than read.
//
// #66, component 2 of 8. The issue's row: *"holds the meetings list, current meeting and recording
// status that every other screen reads"* — 690 lines that nothing had ever rendered. Those three
// are what this asserts, plus the two guards around them where a bug costs a user something:
//
//   1. One row per meeting, and the current one is marked. Every other screen reads `currentMeeting`;
//      if the sidebar disagrees about which one it is, they all do.
//   2. Deleting a meeting calls the command with that meeting's id and drops it from the list.
//   3. Deleting the meeting you are *looking at* also resets `currentMeeting` and routes home.
//      Without it the user is left on a page for a meeting that no longer exists — the sharpest
//      of the five, and invisible to anything that only reads markup.
//   4. Renaming updates the list **and** `currentMeeting` when they are the same meeting. A bug
//      here leaves the sidebar and the open meeting disagreeing about the title.
//   5. A blank title is refused *before* the command runs. `handleEditConfirm` returns early on an
//      empty string; if that guard goes, an empty title is written to the database.
//   6. Recording status reaches the rail: while recording, the live surface is offered and the
//      not-recording one is gone.
//
// Six assertions, six controls in the pull request.
//
// Scaffolding divergences, written here rather than discovered later (#66 condition 4):
//   * `useSidebar`, `useRecordingState` and `useImportDialog` are stubbed rather than wrapped.
//     Each throws outside its provider, and stubbing is what lets "recording" and "not recording"
//     be two renders instead of two effects.
//   * The rename dialog is a Radix `Dialog`, which portals to `document.body`. Its contents are
//     therefore queried from `document.body`, not from the render container.
//   * `next/navigation` is stubbed: `useRouter().push` is the observable in assertion 3.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const MEETINGS = [
  { id: 'm-1', title: 'Weekly planning' },
  { id: 'm-2', title: 'Design review' },
];

/** One render's worth of state, with everything the assertions observe recorded. */
function harness({ isRecording = false, currentId = 'm-1' } = {}) {
  const seen = { pushed: [], meetings: null, currentMeeting: null };
  const stubs = tauriStubs({
    extra: { api_delete_meeting: null, api_save_meeting_title: null },
  });
  const sidebar = {
    currentMeeting: { id: currentId, title: MEETINGS.find((m) => m.id === currentId)?.title ?? '' },
    setCurrentMeeting: (m) => { seen.currentMeeting = m; },
    // The rendered list comes from `sidebarItems`; `meetings` is the array delete and rename
    // mutate. Two arrays for one thing, both from the provider — noted because a test that fed
    // only one of them would render an empty list and pass its own assertions vacuously.
    sidebarItems: MEETINGS.map((m) => ({ ...m, type: 'file' })),
    isCollapsed: false,
    toggleCollapse: () => {},
    handleRecordingToggle: () => {},
    searchTranscripts: async () => {},
    searchResults: [],
    isSearching: false,
    meetings: MEETINGS,
    setMeetings: (m) => { seen.meetings = m; },
  };
  const overrides = {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    'next/navigation': {
      useRouter: () => ({ push: (to) => seen.pushed.push(to) }),
      // Home. The rail reports capture state here rather than duplicating the in-page transport,
      // which is the branch assertion 6 is about (`isHome = pathname === '/'`).
      usePathname: () => '/',
    },
    './SidebarProvider': { useSidebar: () => sidebar },
    '@/contexts/RecordingStateContext': { useRecordingState: () => ({ isRecording }) },
    '@/contexts/ImportDialogContext': { useImportDialog: () => ({ openImportDialog: () => {} }) },
    '@/hooks/useAppVersion': { useAppVersion: () => '0.0.0-test' },
    // Icons render as SVG and carry nothing asserted here.
    // Toasts are user feedback, not state. Asserting on them would test sonner.
  };
  return { seen, stubs, overrides };
}

// The rail's controls sit inside Radix `Tooltip`s, which throw outside a `TooltipProvider`. The
// application wraps the tree once, high up; a component test has to supply it. Same class as the
// `<form>` wrapper `dom-harness.mjs` documents, and as `recording-controls.test.mjs` already needed.
const { TooltipProvider } = loadTsx('src/components/ui/tooltip.tsx');

/** Every bare package the load reached, filled by `loadTsx`. See the assertion at the end. */
const barePackages = new Set();

async function render(opts = {}) {
  const h = harness(opts);
  const Sidebar = loadTsx('src/components/Sidebar/index.tsx', h.overrides, barePackages).default;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(TooltipProvider, null, React.createElement(Sidebar)));
  });
  return { ...h, container, root };
}

const byLabel = (scope, name) =>
  [...scope.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label') === name);
const byText = (scope, text) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
// Arguments come back from the component, which runs inside a `node:vm` context, so their objects
// have that realm's `Object` as a prototype and `deepStrictEqual` fails on two values that print
// identically. Normalised through JSON before comparing. Worth stating: an assertion that looked
// right and failed anyway is exactly the shape that gets "fixed" by weakening it to `deepEqual`.
const callsTo = (stubs, cmd) =>
  stubs.calls.filter((c) => c.cmd === cmd).map((c) => JSON.parse(JSON.stringify(c.args)));

const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); };

// --- 1: one row per meeting, and the current one is marked --------------------------------
{
  const { container } = await render({ currentId: 'm-2' });
  const titles = [...container.querySelectorAll('button[aria-current], button')]
    .map((b) => b.textContent.trim())
    .filter((t) => MEETINGS.some((m) => m.title === t));
  for (const m of MEETINGS) {
    assert.ok(titles.includes(m.title), `the meetings list must show ${m.title}`);
  }
  const current = [...container.querySelectorAll('[aria-current="page"]')]
    .map((el) => el.textContent.trim())
    .filter((t) => MEETINGS.some((m) => m.title === t));
  assert.deepEqual(
    current,
    ['Design review'],
    'exactly the current meeting carries aria-current="page" — every other screen reads this'
  );
}

// --- 2 and 3: delete, and what deleting the *current* meeting must also do ------------------
{
  // Deleting a meeting that is NOT the current one.
  const notCurrent = await render({ currentId: 'm-2' });
  await click(byLabel(notCurrent.container, 'Delete Weekly planning'));
  await click(byText(document.body, 'Delete'));
  assert.deepEqual(
    callsTo(notCurrent.stubs, 'api_delete_meeting'),
    [{ meetingId: 'm-1' }],
    'delete must call the command with the id of the meeting whose control was pressed'
  );
  assert.deepEqual(
    notCurrent.seen.meetings.map((m) => m.id),
    ['m-2'],
    'the deleted meeting must leave the list'
  );
  assert.equal(
    notCurrent.seen.currentMeeting,
    null,
    'deleting some other meeting must not move the current one'
  );
  assert.deepEqual(notCurrent.seen.pushed, [], 'and must not navigate');

  // Deleting the meeting the user is looking at.
  const current = await render({ currentId: 'm-1' });
  await click(byLabel(current.container, 'Delete Weekly planning'));
  await click(byText(document.body, 'Delete'));
  assert.equal(
    current.seen.currentMeeting?.id,
    'intro-call',
    'deleting the current meeting must reset it — otherwise the user is left on a page for a ' +
      'meeting that no longer exists'
  );
  assert.deepEqual(current.seen.pushed, ['/'], 'and must route home');
}

// --- 4: rename keeps the list and the current meeting agreeing ------------------------------
{
  const { container, seen, stubs } = await render({ currentId: 'm-1' });
  await click(byLabel(container, 'Rename Weekly planning'));
  const input = document.body.querySelector('#meeting-title');
  assert.ok(input, 'the rename dialog must offer a title field');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Weekly planning v2');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click(byText(document.body, 'Save'));
  assert.deepEqual(
    callsTo(stubs, 'api_save_meeting_title'),
    [{ meetingId: 'm-1', title: 'Weekly planning v2' }],
    'rename must persist the trimmed title against that meeting'
  );
  assert.equal(
    seen.meetings.find((m) => m.id === 'm-1').title,
    'Weekly planning v2',
    'the list must show the new title'
  );
  assert.equal(
    seen.currentMeeting?.title,
    'Weekly planning v2',
    'and the current meeting must agree with it — a sidebar and an open meeting disagreeing ' +
      'about the title is the bug this guards'
  );
}

// --- 5: a blank title never reaches the database --------------------------------------------
{
  const { container, stubs } = await render({ currentId: 'm-1' });
  await click(byLabel(container, 'Rename Weekly planning'));
  const input = document.body.querySelector('#meeting-title');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '   ');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click(byText(document.body, 'Save'));
  assert.deepEqual(
    callsTo(stubs, 'api_save_meeting_title'),
    [],
    'a whitespace-only title must be refused before the command runs, not written and undone'
  );
}

// --- 6: recording status reaches the rail ----------------------------------------------------
{
  const statuses = (c) => [...c.querySelectorAll('[role="status"]')].map((el) => el.textContent);

  const idle = await render({ isRecording: false });
  assert.ok(
    statuses(idle.container).some((t) => t.includes('Not recording')),
    'not recording, the rail must say so'
  );

  const live = await render({ isRecording: true });
  assert.ok(
    !statuses(live.container).some((t) => t.includes('Not recording')),
    'while recording, the rail must not still claim it is idle'
  );
  assert.ok(
    live.container.querySelector('[role="status"][aria-live="polite"]'),
    'while recording, the rail must carry the live readout — the status every other screen reads'
  );
}

// --- condition 2: an unaccounted dependency moves a set someone holds ------------------------
// #66 condition 2 asks that a component growing a dependency the test has not stubbed "fails
// loudly". `render-tsx.mjs` claimed to do that and did not: a bare specifier resolving in
// `node_modules` was loaded silently, and that is every dependency the application has. Measured
// while writing this test — adding a used `import { getVersion } from '@tauri-apps/api/app'` to
// the component changed nothing at all.
//
// So the loudness is here, as set equality, which is what this repository already uses for the
// same job elsewhere. A new dependency moves the set and someone reads the diff.
//
// `@tauri-apps/plugin-updater` in this list is not incidental: the sidebar's About surface reaches
// the updater, which is the runtime path #79 is about.
// **What the boundary layer serves is invisible to `barePackages`, so it is asserted beside it.**
// `render-tsx.mjs:67` consults `overrides` before `nodeRequire`, so a module the layer covers never
// reaches the recorder — the layer's coverage is exactly this check's blind spot, and #96 created
// it by moving `lucide-react` and `sonner` into the layer. Holding both lists means a component that
// starts importing a covered module still moves something a person reads.
assert.deepEqual(
  boundaryStubs().covered.sort(),
  ['lucide-react', 'sonner'],
  'the boundary layer changed what it covers. Whatever it serves is invisible to `barePackages` ' +
    'below, so the two lists together are the whole of what this component reached.'
);

assert.deepEqual(
  [...barePackages].sort(),
  [
    '@radix-ui/react-dialog',
    '@radix-ui/react-label',
    '@radix-ui/react-slot',
    '@radix-ui/react-switch',
    '@radix-ui/react-tooltip',
    '@tauri-apps/api/app',
    '@tauri-apps/plugin-process',
    '@tauri-apps/plugin-updater',
    'class-variance-authority',
    'clsx',
    'react',
    'react/jsx-runtime',
    'tailwind-merge',
  ],
  'the sidebar reached a package this test does not account for. Read what it pulled in before ' +
    'adding it here: a component test that quietly grows dependencies is testing half the ' +
    'application by accident.'
);

console.log('ok - sidebar: list and current meeting, delete (incl. the current one), rename, the blank-title guard, recording status, and 13 accounted dependencies');

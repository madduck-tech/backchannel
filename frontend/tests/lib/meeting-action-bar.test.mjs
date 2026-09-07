// The saved meeting's controls survive leaving the toolbar, and their labels stop following the window.
//
// #114. Four buttons sat in the transcript pane's header sharing nothing but a row — Copy and
// Retranscribe act on the transcript, Speakers ran a pass over the recording, and one titled "Open
// Recording Folder" opened a file manager, the fourth appearance of a word that already meant the
// live capture state elsewhere.
//
// The defect that made it visible: the labels carried `hidden lg:inline`, a **viewport** query at
// 1024px, while the buttons lived in a pane whose width is unrelated. At the 1100px default window
// the labels showed and the row overflowed its container — the configuration the product owner
// screenshotted, not an edge case.
//
// What these hold: every action survived the move, none of them can be reached in a state where it
// would fail, and the responsive rule is a **container** query so it measures the box the buttons
// are actually in. jsdom evaluates no container queries and computes no layout, so the last one is
// asserted through the class that carries the rule — stated here rather than implied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 900, height: 700 });
const { loadTsx } = await import('./render-tsx.mjs');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');  // frontend/

const { MeetingActionBar } = loadTsx('src/components/MeetingDetails/MeetingActionBar.tsx', {
  ...boundaryStubs().modules,
  './RetranscribeDialog': { RetranscribeDialog: () => null },
  '@/hooks/useSpeakerLabelling': {
    useSpeakerLabelling: () => ({ labelSpeakers: () => {}, isLabelling: false }),
  },
});

async function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(React.createElement(MeetingActionBar, props));
  });
  return container;
}

const base = {
  transcriptCount: 12,
  onCopyTranscript: () => {},
  onOpenMeetingFolder: async () => {},
  meetingId: 'm1',
  meetingFolderPath: '/meetings/m1',
  onRefetchTranscripts: async () => {},
};

/** Enabled, visible button labels, in order. */
const buttons = (c) =>
  Array.from(c.querySelectorAll('button')).map((b) => ({
    name: (b.getAttribute('aria-label') || b.textContent || '').trim(),
    disabled: b.disabled,
  }));

// --- 1: every action survived the move ------------------------------------------------------------
{
  const shown = buttons(await render(base));
  const names = shown.map((b) => b.name);
  for (const action of ['Copy', 'Retranscribe', 'Speakers', 'Open folder', 'More actions']) {
    assert.ok(
      names.some((n) => n.includes(action)),
      `"${action}" must survive the toolbar's removal; the bar has ${JSON.stringify(names)}`
    );
  }
}

// --- 2: nothing is offered in a state where it would fail -----------------------------------------
{
  // An empty transcript: copying and rewriting it are meaningless.
  const empty = buttons(await render({ ...base, transcriptCount: 0 }));
  for (const action of ['Copy', 'Retranscribe', 'Speakers']) {
    const b = empty.find((x) => x.name.includes(action));
    assert.ok(b, `${action} must still be on screen`);
    assert.equal(b.disabled, true, `${action} must be disabled with no transcript to act on`);
  }
  assert.equal(
    empty.find((x) => x.name.includes('Open folder'))?.disabled,
    false,
    'but the folder still opens — it exists whether or not anything was transcribed'
  );

  // No folder on disk: the two actions that need one are not offered at all.
  const noFolder = buttons(await render({ ...base, meetingFolderPath: null }));
  const names = noFolder.map((b) => b.name);
  assert.ok(!names.some((n) => n.includes('Retranscribe')), 'Retranscribe needs a folder');
  assert.ok(!names.some((n) => n.includes('Speakers')), 'so does Speakers');
  assert.ok(names.some((n) => n.includes('Copy')), 'Copy does not');
}

// --- 3: the recorded length shows only when it is known -------------------------------------------
{
  const known = await render({ ...base, recordedSeconds: 2512 });
  assert.match(
    known.textContent,
    /recorded\s*41:52/,
    'the saved length is labelled, so it cannot be read as the live clock the recording screen shows'
  );

  // Derived from the last loaded row, so a partial page would understate it. The page passes null
  // rather than a number it cannot stand behind.
  const unknown = await render({ ...base, recordedSeconds: null });
  assert.ok(
    !/recorded/.test(unknown.textContent),
    'with the length unknown the figure is absent, not zero — a wrong number is worse than none'
  );
}

// --- 4: the responsive rule measures the bar, not the window --------------------------------------
{
  const c = await render(base);
  const bar = c.querySelector('[role="toolbar"]');
  assert.ok(bar, 'the bar is a toolbar and says so');
  assert.equal(bar.getAttribute('aria-label'), 'Meeting actions');

  // jsdom evaluates no container queries, so this holds the rule as declared. The defect being
  // fixed is that the old rule was `hidden lg:inline` — a *viewport* query at 1024px on buttons
  // living in a pane whose width is unrelated.
  assert.match(
    bar.className,
    /@container\/bar/,
    'the bar must declare itself a container, or the queries below it measure nothing'
  );
  const source = fs.readFileSync(
    path.join(root, 'src/components/MeetingDetails/MeetingActionBar.tsx'),
    'utf8'
  );
  assert.match(
    source,
    /@\[560px\]\/bar:/,
    'the labels must respond to the bar’s own width at a stated breakpoint'
  );
  assert.ok(
    !/\bhidden (sm|md|lg|xl|2xl):inline\b/.test(source),
    'and must not use a viewport breakpoint, which is the defect this replaces'
  );
}

console.log(
  'ok - meeting action bar: all five actions survive the toolbar, each is disabled or absent where ' +
    'it would fail, the recorded length appears only when known, and the responsive rule is a ' +
    'container query on the bar rather than a viewport query on the window'
);

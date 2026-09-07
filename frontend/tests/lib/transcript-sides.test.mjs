// The transcript renders from the capture channel, and every layer that carries it is driven.
//
// #112. `database/models.rs:39` keeps `channel` in a column of its own — the physical stream that
// carried the words — precisely so a diarization pass, which rewrites `speaker` on every row, cannot
// erase it. Nothing displayed it, and three mapping layers dropped it on the way to the screen.
//
// Five conditions, **eight controls** — condition 5 owes three, one per mapping layer, because the
// layers are independent code and a single control would leave two of them unheld.
//
//   1. The transcript renders from `channel`: `others` on one side, `you` on the other, and swapping
//      the column in a fixture moves every bubble.
//   2. Consecutive rows from one side are one turn. **Operation:** group over the array as held,
//      splitting when the side changes or after `TURN_PAUSE_SECONDS` of silence, ordered by
//      `audio_start_time`. The app fetches pages of 100 (`usePaginatedTranscripts.ts`,
//      `meeting.rs:156-160`) and appends them, so grouping is recomputed over the concatenation —
//      asserted here, because page-by-page grouping of the reference recording gives 32 turns where
//      whole-meeting grouping gives 31.
//   3. Three states, and the third is the current product. Both sides -> two columns. No channel on
//      any row -> one column that says so (`streaming.rs:168` sets `channel: None` unconditionally,
//      so this is a recording made today, not only an imported one). One side only -> one column
//      with a *different* message, not a dialogue with a silent participant.
//   4. The side is announced to a screen reader. Position is not a label for someone who cannot see
//      it — the reasoning `LiveIndicator.tsx` already carries as "never colour alone".
//   5. The three mapping layers carry the channel: `usePaginatedTranscripts.ts`,
//      `app/_components/TranscriptPanel.tsx`, `MeetingDetails/TranscriptPanel.tsx`. Each is driven,
//      not grepped — `transcript-channel.test.mjs` greps `diarization.rs`'s source text and passes
//      while the file that actually gets written has no `channel` key at all.
//
// Scaffolding divergences, written where the next person reads them:
//   * `giveJsdomALayout()` — jsdom performs no layout and has no `ResizeObserver`, so a virtualised
//     list renders nothing without it (measured in `transcript-view.test.mjs`: 25 segments -> 0 rows).
//   * **jsdom resolves no CSS**, so "left" and "right" cannot be read off the box. The side is
//     asserted through the two things that do exist in the DOM: the accessible name, and the
//     alignment class that produces the position. Neither is the pixel; both go red when the side
//     is computed wrongly, which is what these assertions are for.
//   * Contexts are stubbed rather than wrapped: `useRecordingState` and `useTranscripts` throw
//     outside their providers.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 900, height: 700 });
const { loadTsx } = await import('./render-tsx.mjs');

const { groupIntoTurns, channelCoverage, TURN_PAUSE_SECONDS } = loadTsx('src/lib/transcript-turns.ts');
const { TooltipProvider } = loadTsx('src/components/ui/tooltip.tsx');

const stubs = boundaryStubs().modules;
const recordingCtx = { '@/contexts/RecordingStateContext': { useRecordingState: () => ({ captureArmed: true }) } };

const { VirtualizedTranscriptView } = loadTsx('src/components/VirtualizedTranscriptView.tsx', {
  ...stubs,
  ...recordingCtx,
});

/** A row as the engine delivers it. `gap` is silence before this row. */
let clock = 0;
const row = (i, channel, { text, gap = 0, len = 2 } = {}) => {
  clock += gap;
  const r = {
    id: `r${i}`,
    timestamp: clock,
    endTime: clock + len,
    audio_start_time: clock,
    audio_end_time: clock + len,
    text: text ?? `line${i}end`,
    channel,
  };
  clock += len;
  return r;
};
const fixture = (spec) => {
  clock = 0;
  return spec.map(([channel, opts], i) => row(i, channel, opts));
};

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(React.createElement(TooltipProvider, null, element));
  });
  return container;
}

const view = (props) => render(React.createElement(VirtualizedTranscriptView, props));

/** Every bubble on screen, as `{ side, text }`, read from the DOM the way a user's reader would. */
const bubbles = (container) =>
  Array.from(container.querySelectorAll('article[aria-label]')).map((el) => ({
    name: el.getAttribute('aria-label'),
    // The alignment class is what produces the position; jsdom resolves no CSS, so this stands in
    // for the box. `ml-auto` pushes the turn to the right edge, `mr-auto` to the left.
    aligned: el.className.includes('ml-auto') ? 'right' : el.className.includes('mr-auto') ? 'left' : null,
    text: el.textContent,
  }));

// --- 1: the transcript renders from `channel` --------------------------------------------------
{
  const spec = [['you'], ['others', { gap: 9 }], ['you', { gap: 9 }], ['others', { gap: 9 }]];
  const shown = bubbles(await view({ segments: fixture(spec) }));

  assert.equal(shown.length, 4, `four rows nine seconds apart are four turns; got ${shown.length}`);
  assert.deepEqual(
    shown.map((b) => b.aligned),
    ['right', 'left', 'right', 'left'],
    'the microphone channel renders on one side and system audio on the other'
  );
  // A row is on one side and never on both: `ml-auto` and `mr-auto` are mutually exclusive.
  for (const el of Array.from(document.querySelectorAll('article[aria-label]'))) {
    assert.ok(
      !(el.className.includes('ml-auto') && el.className.includes('mr-auto')),
      'a turn cannot be aligned to both edges'
    );
  }

  // Swap the column and every bubble moves. This is the assertion that separates rendering *from*
  // the channel from rendering something that merely happens to alternate.
  const swapped = fixture(spec).map((r) => ({ ...r, channel: r.channel === 'you' ? 'others' : 'you' }));
  const after = bubbles(await view({ segments: swapped }));
  assert.deepEqual(
    after.map((b) => b.aligned),
    ['left', 'right', 'left', 'right'],
    'swapping `channel` on every row must move every bubble to the other side'
  );
  assert.deepEqual(
    after.map((b) => b.text),
    shown.map((b) => b.text),
    'and must move only the side — the text of each turn is unchanged'
  );
}

// --- 2: consecutive rows from one side are one turn --------------------------------------------
{
  // Three rows from one side with no silence between them, then the other side.
  const segments = fixture([['you'], ['you'], ['you'], ['others'], ['you']]);
  const turns = groupIntoTurns(segments);
  assert.equal(
    turns.length,
    3,
    `grouping consecutive rows that share a channel: 5 rows -> 3 turns, got ${turns.length}`
  );
  assert.equal(
    turns.map((t) => t.segments.length).join(','),
    '3,1,1',
    'the three-row turn keeps its three rows; joined because the module runs in a vm realm and its ' +
      "arrays fail deepStrictEqual's prototype check"
  );

  // The pause splits a turn even when the side does not change — the case that carries a
  // one-sided stretch, where nothing else separates anything. Each fixture carries an `others`
  // row, because grouping is conditional on both sides being present (asserted below).
  const tail = ['others', { gap: 99 }];
  const paused = fixture([['you'], ['you', { gap: TURN_PAUSE_SECONDS + 1 }], tail]);
  assert.equal(
    groupIntoTurns(paused).length,
    3,
    `${TURN_PAUSE_SECONDS + 1}s of silence starts a new turn on the same side`
  );
  const held = fixture([['you'], ['you', { gap: TURN_PAUSE_SECONDS - 1 }], tail]);
  assert.equal(
    groupIntoTurns(held).length,
    2,
    `${TURN_PAUSE_SECONDS - 1}s of silence does not — the threshold is ${TURN_PAUSE_SECONDS}s`
  );

  // Changing one row's channel changes the count. The issue's own control.
  const mutated = segments.map((r, i) => (i === 1 ? { ...r, channel: 'others' } : r));
  assert.equal(
    groupIntoTurns(mutated).length,
    5,
    'flipping the middle row of a three-row turn splits it into three, so 3 turns become 5'
  );

  // Grouping is conditional on coverage, and that is a measurement rather than a preference.
  // With no side to change, the pause rule alone collapsed the reference recording's 137 rows into
  // 8 turns of up to 53 rows — it destroys the per-row timestamp, which is the only navigation a
  // single-column transcript has, and coarsens the virtualiser's unit past a screen. So a
  // single-column transcript stays one turn per row, exactly as it renders today.
  const sideless = fixture([['you'], ['you'], ['you']]).map((r) => ({ ...r, channel: undefined }));
  assert.equal(
    groupIntoTurns(sideless).length,
    3,
    'a channel-less transcript is not grouped: one turn per row, which is what it renders today'
  );
  assert.equal(
    groupIntoTurns(fixture([['you'], ['you'], ['you']])).length,
    3,
    'and neither is a one-sided one — there is no second side for a turn to be a turn against'
  );

  // Pages are appended and regrouped over the concatenation, not grouped per page: a turn that
  // spans a page boundary is one turn once both pages are held.
  const whole = fixture([['you'], ['you'], ['you'], tail]);
  const [pageA, pageB] = [whole.slice(0, 2), whole.slice(2)];
  assert.equal(
    groupIntoTurns(pageA).length + groupIntoTurns(pageB).length,
    4,
    'grouped page by page: the `you` turn is split at the boundary, and page A has one side only'
  );
  assert.equal(
    groupIntoTurns([...pageA, ...pageB]).length,
    2,
    'grouped over the concatenation: the split heals. The view groups what it holds, so appending ' +
      'a page merges the turn that spanned the boundary'
  );
}

// --- 3: three states, and the third is the current product -------------------------------------
{
  const both = await view({ segments: fixture([['you'], ['others', { gap: 9 }]]) });
  assert.equal(bubbles(both).length, 2, 'both channels present renders a two-sided conversation');
  assert.equal(both.querySelectorAll('[role="status"]').length, 0, 'and says nothing about missing sides');

  // No channel on any row — every recording made on the streaming path.
  const none = await view({ segments: fixture([['you'], ['others']]).map((r) => ({ ...r, channel: undefined })) });
  assert.equal(bubbles(none).length, 0, 'with no channel there are no sides to render');
  const noneNotice = none.querySelector('[role="status"]');
  assert.ok(noneNotice, 'a channel-less transcript must say why it has no sides');
  assert.match(noneNotice.textContent, /no channel data/i);
  assert.ok(none.textContent.includes('line0end'), 'and must still render every line');

  // One side only — a mic-only recording.
  const one = await view({ segments: fixture([['you'], ['you', { gap: 9 }]]) });
  assert.equal(bubbles(one).length, 0, 'one side is a column, not a dialogue with a silent participant');
  const oneNotice = one.querySelector('[role="status"]');
  assert.ok(oneNotice, 'a one-sided transcript must say why');
  assert.notEqual(
    oneNotice.textContent,
    noneNotice.textContent,
    'the two single-column states are different states and must not share one message: one ' +
      'recording never carried a channel, the other carried exactly one'
  );
  assert.equal(channelCoverage(fixture([['you'], ['you']])), 'one-side');
  assert.equal(channelCoverage(fixture([['you'], ['others']])), 'both');
}

// --- 4: the side is announced to a screen reader -----------------------------------------------
{
  const shown = bubbles(await view({ segments: fixture([['you'], ['others', { gap: 9 }]]) }));
  assert.deepEqual(
    shown.map((b) => b.name),
    ['You', 'Others'],
    "each bubble's accessible name must carry the side. Position is not available to a screen " +
      'reader, and the side is the only label this design has'
  );
}

// --- 5: the three mapping layers carry the channel ---------------------------------------------
//
// Driven, not grepped. Each layer builds `TranscriptSegmentData` from a `Transcript` row, and each
// one used to map `speaker` and not `channel`, so a saved meeting arrived on screen sideless.
{
  const saved = fixture([['you'], ['others', { gap: 9 }]]);

  // (a) MeetingDetails/TranscriptPanel — the saved-meeting panel, mapping inline.
  const { TranscriptPanel: DetailsPanel } = loadTsx('src/components/MeetingDetails/TranscriptPanel.tsx', {
    ...stubs,
    ...recordingCtx,
    './TranscriptButtonGroup': { TranscriptButtonGroup: () => null },
    '@/components/PaneDivider': { PaneDivider: () => null },
    '@/hooks/useSpeakerNames': { useSpeakerNames: () => ({ speakerNames: {}, renameSpeaker: () => {} }) },
  });
  const details = await render(
    React.createElement(DetailsPanel, {
      transcripts: saved,
      customPrompt: '',
      onPromptChange: () => {},
      onCopyTranscript: () => {},
      onOpenMeetingFolder: async () => {},
      isRecording: false,
    })
  );
  assert.deepEqual(
    bubbles(details).map((b) => b.aligned),
    ['right', 'left'],
    'MeetingDetails/TranscriptPanel maps a saved meeting for display; dropping `channel` there ' +
      'costs every saved meeting its sides'
  );

  // (b) app/_components/TranscriptPanel — the live capture surface.
  const { TranscriptPanel: LivePanel } = loadTsx('src/app/_components/TranscriptPanel.tsx', {
    ...stubs,
    ...recordingCtx,
    '@/contexts/TranscriptContext': {
      useTranscripts: () => ({
        transcripts: saved,
        partialText: '',
        transcriptContainerRef: { current: null },
        copyTranscript: () => {},
      }),
    },
    '@/contexts/ConfigContext': { useConfig: () => ({ transcriptModelConfig: { provider: 'local', model: 'm' } }) },
    '@/hooks/usePermissionCheck': {
      usePermissionCheck: () => ({
        checkPermissions: () => {},
        isChecking: false,
        hasSystemAudio: true,
        hasMicrophone: true,
      }),
    },
    '@/hooks/usePlatform': { useIsLinux: () => true },
    '@/components/PermissionWarning': { PermissionWarning: () => null },
  });
  const live = await render(
    React.createElement(LivePanel, { isProcessingStop: false, isStopping: false, showModal: () => {} })
  );
  assert.deepEqual(
    bubbles(live).map((b) => b.aligned),
    ['right', 'left'],
    'app/_components/TranscriptPanel maps the live transcript for display'
  );

  // (c) usePaginatedTranscripts — the paginated path, a hook, driven through a host component.
  const { usePaginatedTranscripts } = loadTsx('src/hooks/usePaginatedTranscripts.ts', {
    '@tauri-apps/api/core': {
      invoke: async (cmd) => {
        if (cmd === 'api_get_meeting_metadata') return { id: 'm1', title: 't', total_transcripts: saved.length };
        return { transcripts: saved, total_count: saved.length, has_more: false };
      },
    },
  });
  function Host() {
    const { segments } = usePaginatedTranscripts({ meetingId: 'm1' });
    return React.createElement(VirtualizedTranscriptView, { segments, disableAutoScroll: true });
  }
  const paginated = await render(React.createElement(Host, null));
  assert.deepEqual(
    bubbles(paginated).map((b) => b.aligned),
    ['right', 'left'],
    'usePaginatedTranscripts converts rows to segments for the virtualised view; dropping ' +
      '`channel` in `convertTranscriptsToSegments` costs every paginated meeting its sides'
  );
}

console.log(
  'ok - transcript sides: bubbles follow `channel` and all move when it is swapped, consecutive ' +
    'rows group into turns (5 -> 3, and 5 again when one row flips), the three coverage states ' +
    'render as two columns / one column with two different reasons, the side is the accessible ' +
    'name, and all three mapping layers carry the channel to the screen'
);

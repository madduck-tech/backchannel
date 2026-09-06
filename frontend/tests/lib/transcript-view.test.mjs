// What the transcript view puts on screen, driven rather than read — including the virtualised path.
//
// #66, component 3 of 8. The issue's row: *"renders the product's primary output, and virtualisation
// is where an off-by-one silently hides rows"*. 492 lines, nothing had ever rendered it.
//
// The component has two rendering paths and switches between them at
// `useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD` (10). Both are exercised here,
// and the boundary itself is an assertion: a row lost at the switch is invisible to a user who
// never counts, and invisible to any check that reads source.
//
//   1. Below the threshold, every segment is on screen, in order, with no gap.
//   2. **At exactly the threshold** — the first count that takes the other path — every segment is
//      still on screen. `>=` versus `>` is one character and one lost row.
//   3. Above it, the window is a *contiguous* run starting at the first segment, and is genuinely
//      smaller than the transcript. A gap inside the window is the off-by-one the row names; a
//      window equal to the whole list would mean this assertion is not testing virtualisation.
//   4. The text is rendered verbatim. A filler-word stripper used to live here and deleted
//      uh/um/er/ah from the *displayed* text only, so the screen disagreed with what was saved and
//      exported — the component's own comment records it. This is that defect's regression guard.
//   5. Speaker labels come from `speakerNames`, not from the raw id.
//   6. Empty state when there is neither a segment nor a partial.
//
// Six behaviours, **seven** controls: assertion 4 owes two, because `segment.text` is rendered at
// two sites, one per path, and a stripper on either must go red.
//
// Scaffolding divergences, written down where the next person reads them (#66 condition 4):
//   * `giveJsdomALayout()` is called. jsdom performs no layout and has no `ResizeObserver`, so a
//     virtualised list renders **nothing** — measured: 25 segments produced 0 rows before this. A
//     test written against that state would have asserted an empty screen and passed.
//   * Segment texts are `seg<N>end`, not `segment <N>`. `textContent` concatenates adjacent nodes,
//     so `segment 0` was followed by the *next row's* timestamp `00:01` and a word-boundary match
//     on `segment 0` failed while `segment 8` passed — a token that cannot collide is the fix.
//     Recorded because that failure looked exactly like virtualisation dropping rows.
//   * `useRecordingState` is stubbed rather than wrapped; it throws outside its provider.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 800, height: 600 });
const { loadTsx } = await import('./render-tsx.mjs');

const THRESHOLD = 10; // VirtualizedTranscriptView.tsx:44, VIRTUALIZATION_THRESHOLD

const segment = (i, over = {}) => ({
  id: `g${i}`,
  timestamp: i,
  endTime: i + 1,
  text: `seg${i}end`,
  speaker: 'SPEAKER_00',
  ...over,
});

const overrides = {
  '@/contexts/RecordingStateContext': {
    // The component reads only `captureArmed` from the context: until the microphone has
    // delivered a frame the pane must not claim to be listening. `isRecording` is a prop.
    useRecordingState: () => ({ captureArmed: true }),
  },
  'lucide-react': new Proxy({}, { get: () => () => null }),
};

const { VirtualizedTranscriptView } = loadTsx(
  'src/components/VirtualizedTranscriptView.tsx',
  overrides
);
const { TooltipProvider } = loadTsx('src/components/ui/tooltip.tsx');

async function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(TooltipProvider, null, React.createElement(VirtualizedTranscriptView, props))
    );
  });
  return container;
}

/** Which segment indices reached the screen, by a token that cannot collide with a timestamp. */
const shownIndices = (container, n) =>
  Array.from({ length: n }, (_, i) => i).filter((i) => container.textContent.includes(`seg${i}end`));

const isContiguous = (idx) => idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);

// --- 1: below the threshold, nothing is dropped ---------------------------------------------
{
  const n = THRESHOLD - 1;
  const idx = shownIndices(await render({ segments: Array.from({ length: n }, (_, i) => segment(i)) }), n);
  assert.deepEqual(
    idx,
    [...Array(n).keys()],
    `below the virtualisation threshold every segment must render; got ${idx.length} of ${n}`
  );
}

// --- 2: at the threshold, the path changes and still nothing is dropped ----------------------
{
  const n = THRESHOLD;
  const idx = shownIndices(await render({ segments: Array.from({ length: n }, (_, i) => segment(i)) }), n);
  assert.deepEqual(
    idx,
    [...Array(n).keys()],
    `at exactly ${THRESHOLD} segments the component switches to the virtualised path. Every ` +
      `segment must survive the switch — this is the count where >= and > differ, and where a ` +
      `lost row would be one character of source`
  );
}

// --- 3: above it, the window is contiguous, starts at the top, and is really a window ---------
{
  const n = 25;
  const container = await render({ segments: Array.from({ length: n }, (_, i) => segment(i)) });
  const idx = shownIndices(container, n);
  assert.ok(idx.length > 0, 'the virtualised path must render something');
  assert.equal(idx[0], 0, 'the window must start at the first segment when nothing has scrolled');
  assert.ok(
    isContiguous(idx),
    `the rendered window must have no holes; got ${JSON.stringify(idx)} — a gap inside the ` +
      `window is exactly the off-by-one this component is on the list for`
  );
  assert.ok(
    idx.length < n,
    'with 25 segments in a 600px viewport the window must be smaller than the transcript, or ' +
      'this assertion is not testing virtualisation at all'
  );
}

// --- 4: the transcript renders what the model heard --------------------------------------------
{
  // The stripper that used to live here deleted these from the *displayed* text only, so the screen
  // disagreed with what was saved, exported and summarised.
  const said = 'um so er we should oh probably ship it';

  // BOTH paths. `segment.text` is rendered at two sites — one per path — and the first version of
  // this assertion used a single segment, so it only ever reached the non-virtualised one. A
  // stripper added to the other site passed the control silently, which is how the control caught
  // the test rather than the code.
  const short = await render({ segments: [segment(0, { text: said })] });
  assert.ok(
    short.textContent.includes(said),
    'below the threshold the transcript must render the text verbatim. A filler-word stripper ' +
      'used to run here and rewrote only what was shown, so the screen and the stored transcript ' +
      'disagreed'
  );

  const long = await render({
    segments: [
      segment(0, { text: said }),
      ...Array.from({ length: THRESHOLD }, (_, i) => segment(i + 1)),
    ],
  });
  assert.ok(
    long.textContent.includes(said),
    'and above the threshold too — the virtualised path renders `segment.text` at its own site, ' +
      'and a stripper on only one of the two would be invisible to a single-segment test'
  );
}

// --- 5: speaker labels come from the mapping ---------------------------------------------------
{
  const container = await render({
    segments: [segment(0, { speaker: 'SPEAKER_00' })],
    speakerNames: { SPEAKER_00: 'Marina' },
  });
  assert.ok(container.textContent.includes('Marina'), 'a named speaker must show their name');
  assert.ok(
    !container.textContent.includes('SPEAKER_00'),
    'and must not also show the raw diarizer id — two labels for one speaker is the bug'
  );
}

// --- 6: the empty state ------------------------------------------------------------------------
{
  const container = await render({ segments: [] });
  assert.ok(
    container.textContent.trim().length > 0,
    'an empty transcript must teach the next action rather than render nothing at all'
  );
  // The live tail only exists while recording — `isRecording` is a prop, not the context.
  const withPartial = await render({
    segments: [],
    partialText: 'half a sentence',
    isRecording: true,
  });
  assert.ok(
    withPartial.textContent.includes('half a sentence'),
    'a partial with no committed segments yet is still text on screen and must be shown — the ' +
      "component's own comment says showing \"Listening\" underneath it would contradict itself"
  );
}

console.log(
  `ok - transcript view: ${THRESHOLD - 1} below the threshold and ${THRESHOLD} at it all render, ` +
    'the window above it is contiguous and smaller than the list, text is verbatim, speaker names ' +
    'replace ids, and both empty states show'
);

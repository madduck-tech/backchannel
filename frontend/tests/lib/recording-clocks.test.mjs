// The pause-excluded duration survives the deletion of the thing that used to render it.
//
// #114. The meeting screen made the same claim in five places at once: `LiveIndicator` in the rail
// and in the transport, `RecordingStatusBar` sticky above the transcript, a folder button titled
// "Open Recording Folder", and a "Listening" pulse. The banner goes — but **it was the only thing in
// the application that rendered `activeDuration`**, and that number is not decoration: it is
// pause-excluded, and `recording_manager.rs:329` hands it to `recording_saver.stop_and_save`, so it
// is the length the saved file is written with. The transport's own timer is `recordingDuration`, a
// wall clock that runs through a pause.
//
// A control asserting only "the screen still reports recording state" passes while that number
// disappears, which is what v1 of the issue asked for. These assert the number.
//
// Scaffolding divergence, written where the next person reads it: `useRecordingState` is stubbed
// rather than wrapped — it throws outside its provider, and every case here is a different context
// value, which is exactly what the component reads.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

/** Render the clocks against one recording state. */
async function clocks(state) {
  const { RecordingClocks } = loadTsx('src/components/RecordingClocks.tsx', {
    '@/contexts/RecordingStateContext': { useRecordingState: () => state },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(React.createElement(RecordingClocks, null));
  });
  return container;
}

/** The labelled figures on screen, as `{ label: value }`. */
const figures = (container) =>
  Object.fromEntries(
    Array.from(container.querySelectorAll('span'))
      // One clock is `<span><span>label</span><b>value</b></span>` -- two element children,
      // the last a `b`. Filtering on "contains a b" also matches the wrapper.
      .filter((el) => el.children.length === 2 && el.lastElementChild?.tagName === 'B')
      .map((el) => [
        el.firstElementChild.textContent.trim(),
        el.lastElementChild.textContent.trim(),
      ])
  );

const recording = (over = {}) => ({
  isRecording: true,
  isPaused: false,
  recordingDuration: 0,
  activeDuration: 0,
  ...over,
});

// --- 1: both clocks are on screen, and each says which it is -------------------------------------
{
  const f = figures(await clocks(recording({ recordingDuration: 2537, activeDuration: 2512 })));
  assert.equal(
    f.recorded,
    '41:52',
    `the pause-excluded duration must be rendered; got ${JSON.stringify(f)}`
  );
  assert.equal(f.elapsed, '42:17', 'and the wall clock beside it');
  assert.notEqual(
    f.recorded,
    f.elapsed,
    'they are different numbers and this fixture is chosen so that they differ — a test where they ' +
      'agree cannot tell one from the other'
  );
  assert.deepEqual(
    Object.keys(f).sort(),
    ['elapsed', 'paused', 'recorded'],
    'each figure carries its own label. Two bare timers a few pixels apart, differing by seconds, ' +
      'read as one number rendered twice'
  );
}

// --- 2: the pause-excluded number is the one that stops while paused ------------------------------
{
  // Twenty-five seconds of pause: the wall clock has moved on, the recorded length has not.
  const f = figures(await clocks(recording({ isPaused: true, recordingDuration: 2537, activeDuration: 2512 })));
  assert.equal(f.recorded, '41:52');
  assert.equal(f.elapsed, '42:17');
  assert.equal(
    f.paused,
    '0:25',
    'and the gap between them is shown, so the difference reads as a fact rather than as a bug'
  );
}

// --- 3: the third figure is absent until there is something to explain ----------------------------
{
  const f = figures(await clocks(recording({ recordingDuration: 600, activeDuration: 600 })));
  assert.deepEqual(
    Object.keys(f).sort(),
    ['elapsed', 'recorded'],
    'with no pause the two clocks agree, and a third figure reading 0:00 is noise'
  );

  // One second of drift is the two values being sampled a moment apart, not a pause.
  const drift = figures(await clocks(recording({ recordingDuration: 601, activeDuration: 600 })));
  assert.deepEqual(Object.keys(drift).sort(), ['elapsed', 'recorded'], 'one second of drift is not a pause');
}

// --- 4: nothing is rendered when nothing is recording ---------------------------------------------
{
  const container = await clocks(recording({ isRecording: false, recordingDuration: 99, activeDuration: 99 }));
  assert.equal(
    container.textContent.trim(),
    '',
    'the clocks belong to a recording in progress; with none they render nothing at all'
  );
}

// --- 5: a null duration is zero, not NaN ----------------------------------------------------------
{
  // `activeDuration` is `number | null` in the context and starts null (`RecordingStateContext:92`).
  const f = figures(await clocks(recording({ recordingDuration: null, activeDuration: null })));
  assert.equal(f.recorded, '0:00', 'a null duration renders as zero');
  assert.equal(f.elapsed, '0:00');
}

console.log(
  'ok - recording clocks: both durations render with their own labels and differ where the fixture ' +
    'differs, the pause gap appears only once there is a pause to explain, one second of sampling ' +
    'drift is not one, nothing renders outside a recording, and a null duration is zero'
);

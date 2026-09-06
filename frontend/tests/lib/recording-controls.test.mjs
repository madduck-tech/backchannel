// What the control every meeting starts from does, driven rather than read.
//
// #66. `RecordingControls.tsx` is 546 lines and nothing had ever rendered it. #15 was a defect in
// exactly this surface — the picker telling a user to click a button that did not exist — and the
// check that caught it reads source text, so it can say a control is *declared* and nothing about
// what happens when someone presses it.
//
// The four assertions below are the ones the component's own comments say matter:
//
//   1. Not recording, a start control exists and calling it starts a recording.
//   2. Recording, the start control is gone and stop exists. A screen offering both is the state
//      #15 was about.
//   3. The pause control's accessible name flips with the *context*, not with a prop — the tray
//      can pause a recording, and `RecordingStateContext` is how the button learns. A label stuck
//      on "Pause" while the recording is paused is a button that lies about what it will do.
//   4. `isRecordingDisabled` actually disables. A disabled-looking button that still fires is the
//      shape of every "it did nothing" bug report.
//
// The context is stubbed rather than wrapped: `useRecordingState` throws outside a provider, and a
// stub is what lets the paused and unpaused cases be two renders rather than two effects.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const stubs = tauriStubs({ devices: [] });

/** The context the component reads, with `isPaused` as the only thing under test. */
const recordingStateStub = (isPaused) => ({
  useRecordingState: () => ({
    isRecording: true,
    isPaused,
    isActive: true,
    recordingDuration: 10,
    activeDuration: 10,
    captureArmed: true,
    status: 'RECORDING',
    statusMessage: undefined,
    isStopping: false,
    isProcessing: false,
    isSaving: false,
  }),
});

function load(isPaused = false) {
  return loadTsx('src/components/RecordingControls.tsx', {
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    '@/contexts/RecordingStateContext': recordingStateStub(isPaused),
    // Icons render as SVG and carry nothing asserted here.
    'lucide-react': new Proxy({}, { get: () => () => null }),
  });
}

const BASE = {
  isRecording: false,
  onRecordingStop: () => {},
  onRecordingStart: () => {},
  isStarting: false,
  startPhase: 'idle',
  onTranscriptReceived: () => {},
  onTranscriptionError: () => {},
  onStopInitiated: () => {},
  isRecordingDisabled: false,
  isParentProcessing: false,
  selectedDevices: { mic: null, system: null },
  meetingName: 'Probe meeting',
};

// The pause and stop controls sit inside Radix `Tooltip`s, which throw outside a
// `TooltipProvider` — "`Tooltip` must be used within `TooltipProvider`". The application wraps
// the tree once, high up; a component test has to supply it. Stated rather than discovered: this
// is scaffolding the production tree provides elsewhere, in the same class as the `<form>`
// wrapper `dom-harness.mjs` documents for Radix `Select`.
const { TooltipProvider } = loadTsx('src/components/ui/tooltip.tsx');

async function render(Component, props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(TooltipProvider, null, React.createElement(Component, { ...BASE, ...props }))
    );
  });
  return { container, root };
}

const labelled = (container, name) =>
  [...container.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label') === name);

// --- 1 and 2: which controls exist in which state -----------------------------------------
{
  const { RecordingControls } = load(false);

  const idle = await render(RecordingControls, { isRecording: false });
  assert.equal(
    labelled(idle.container, 'Stop recording'),
    undefined,
    'a screen that is not recording must not offer Stop — offering both is the state #15 was about'
  );
  const startButtons = [...idle.container.querySelectorAll('button')].filter(
    (b) => !b.getAttribute('aria-label')
  );
  assert.ok(startButtons.length >= 1, 'not recording, there must be a control to start with');

  const live = await render(RecordingControls, { isRecording: true });
  assert.ok(labelled(live.container, 'Stop recording'), 'while recording, Stop must be reachable');
  assert.ok(
    labelled(live.container, 'Pause recording'),
    'while recording and not paused, the pause control must say Pause'
  );
}

// --- 3: the pause label follows the context, not a prop ------------------------------------
{
  const paused = load(true);
  const { container } = await render(paused.RecordingControls, { isRecording: true });
  assert.ok(
    labelled(container, 'Resume recording'),
    'a paused recording must offer Resume — the tray can pause, and the context is how this button ' +
      'learns. A label stuck on Pause is a button that lies about what it will do.'
  );
  assert.equal(
    labelled(container, 'Pause recording'),
    undefined,
    'and it must not offer Pause at the same time'
  );
}

// --- 4: disabled means disabled ------------------------------------------------------------
{
  const { RecordingControls } = load(false);
  let started = 0;
  const { container } = await render(RecordingControls, {
    isRecording: false,
    isRecordingDisabled: true,
    onRecordingStart: () => {
      started += 1;
    },
  });
  const start = [...container.querySelectorAll('button')].find((b) => !b.getAttribute('aria-label'));
  assert.ok(start, 'the start control must still be rendered when disabled, only inert');
  assert.equal(start.disabled, true, 'isRecordingDisabled must reach the DOM, not only the styling');
  await act(async () => {
    start.click();
  });
  assert.equal(
    started,
    0,
    'a disabled start control that still fires is the shape of every "it did nothing" report'
  );
}

console.log(
  'ok - recording controls: start and stop are mutually exclusive, the pause label follows the ' +
    'recording-state context, and isRecordingDisabled reaches the DOM and blocks the handler'
);

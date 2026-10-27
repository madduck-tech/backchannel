// Before a recording starts, the pre-check asks about the model *this* recording would use. (#182)
//
// `useRecordingStart` used to ask `transcribe_has_available_models` (is any catalogue model on disk?)
// and, on a no, whether any model was downloading. So with the chosen model deleted and another on
// disk, every start path went on into the backend's refusal, under "Recording Failed — check your
// audio device settings"; and with `builtin-ai` and no catalogue model it refused a start the
// backend would have taken. It now asks `transcribe_recording_model_state`, which answers from the
// resolver recording's pre-flight refuses with.
//
// The hook runs in a host component. Each condition gives the catalogue's statuses, which the legacy
// commands answer from (so this file runs red on `main`'s hook too), and the new command's answer,
// written by hand: this file holds how the hook routes on the backend's answer. How that answer is
// derived from the catalogue, the downloads in flight and Gemma's files is held in Rust, by
// `recording_model_tests` in `transcribe_engine/commands.rs`. Three start paths:
//   - the button: `handleRecordingStart`;
//   - auto-start, the tray's way: `sessionStorage.autoStartRecording` set before mount;
//   - the sidebar: a `start-recording-from-sidebar` window event after mount.
// "Start" is an invoke of `start_recording_with_devices_and_meeting`. The positives for the
// not-ready rows are their toasts: a drive that never fired would never start either.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const X = 'whisper-tiny-q8';
const OTHER = 'moonshine-tiny-q8';
const GEMMA = 'gemma4:e2b';

/** Each condition: the catalogue, the provider, and what the new command answers for X. */
const CONDITIONS = [
  { id: 1, what: 'X missing, another available', provider: 'transcribe-cpp', catalogue: { [X]: 'Missing', [OTHER]: 'Available' }, answer: 'missing', expect: 'not-ready' },
  { id: 2, what: 'X downloading, another available', provider: 'transcribe-cpp', catalogue: { [X]: { Downloading: { progress: 40 } }, [OTHER]: 'Available' }, answer: 'downloading', expect: 'downloading' },
  { id: 3, what: 'X missing, Y downloading, Z available', provider: 'transcribe-cpp', catalogue: { [X]: 'Missing', 'y-model': { Downloading: { progress: 10 } }, [OTHER]: 'Available' }, answer: 'missing', expect: 'not-ready' },
  { id: 4, what: 'builtin-ai, Gemma present, no catalogue model', provider: 'builtin-ai', catalogue: { [X]: 'Missing', [OTHER]: 'Missing' }, answer: 'ready', model: GEMMA, expect: 'start' },
  { id: '5a', what: 'X corrupted, another available', provider: 'transcribe-cpp', catalogue: { [X]: { Corrupted: { file_size: 10, expected_min_size: 100 } }, [OTHER]: 'Available' }, answer: 'corrupted', expect: 'not-ready' },
  { id: '5b', what: 'the command answering error, another available', provider: 'transcribe-cpp', catalogue: { [X]: { Error: 'bad' }, [OTHER]: 'Available' }, answer: 'error', expect: 'not-ready' },
  { id: 6, what: 'X available', provider: 'transcribe-cpp', catalogue: { [X]: 'Available', [OTHER]: 'Missing' }, answer: 'ready', expect: 'start' },
  // The backend could not answer: not ready. `main` asks another command, so this one says nothing there.
  { id: 7, what: 'the command failing', provider: 'transcribe-cpp', catalogue: { [X]: 'Missing', [OTHER]: 'Missing' }, answer: 'throws', expect: 'not-ready' },
];

const PATHS = ['button', 'auto-start', 'sidebar'];

const RecordingStatus = { IDLE: 'idle', STARTING: 'starting', RECORDING: 'recording', STOPPING: 'stopping', PROCESSING_TRANSCRIPTS: 'processing', SAVING: 'saving', COMPLETED: 'completed', ERROR: 'error' };

async function drive(condition, path) {
  const calls = [];
  const modals = [];
  const status = (s) => (typeof s === 'string' ? s : Object.keys(s)[0]);
  const invoke = async (cmd) => {
    calls.push(cmd);
    switch (cmd) {
      case 'transcribe_recording_model_state':
        if (condition.answer === 'throws') throw new Error('the backend could not answer');
        return { provider: condition.provider, model: condition.model ?? X, state: condition.answer };
      // `main`'s pre-check, answering from the same fixture.
      case 'transcribe_init':
        return null;
      case 'transcribe_has_available_models':
        return Object.values(condition.catalogue).some((s) => status(s) === 'Available');
      case 'transcribe_get_available_models':
        return Object.entries(condition.catalogue).map(([name, s]) => ({ name, status: s }));
      case 'start_recording_with_devices_and_meeting':
        return null;
      default:
        return null;
    }
  };
  const boundary = boundaryStubs();
  const { useRecordingStart } = loadTsx('src/hooks/useRecordingStart.ts', {
    ...boundary.modules,
    '@tauri-apps/api/core': { invoke },
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '@/contexts/TranscriptContext': { useTranscripts: () => ({ clearTranscripts: () => {}, setMeetingTitle: () => {} }) },
    '@/components/Sidebar/SidebarProvider': { useSidebar: () => ({ setIsMeetingActive: () => {} }) },
    '@/contexts/ConfigContext': { useConfig: () => ({ selectedDevices: { micDevice: null, systemDevice: null } }) },
    '@/contexts/RecordingStateContext': { useRecordingState: () => ({ setStatus: () => {}, status: 'idle' }), RecordingStatus },
    '@/services/recordingService': {
      recordingService: { startRecordingWithDevices: (mic, sys, title) => invoke('start_recording_with_devices_and_meeting', { mic, sys, title }) },
    },
    '@/lib/recordingNotification': { showRecordingNotification: () => {} },
  });

  let api = null;
  function Host() {
    api = useRecordingStart(false, () => {}, (name, message) => modals.push({ name, message }));
    return null;
  }
  if (path === 'auto-start') sessionStorage.setItem('autoStartRecording', 'true');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Host, null)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  if (path === 'button') await act(async () => { await api.handleRecordingStart(); });
  if (path === 'sidebar') {
    await act(async () => { window.dispatchEvent(new Event('start-recording-from-sidebar')); });
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await act(async () => { root.unmount(); });
  container.remove();
  sessionStorage.removeItem('autoStartRecording');

  const started = calls.includes('start_recording_with_devices_and_meeting');
  const asked = calls.filter((c) => c === 'transcribe_recording_model_state' || c === 'transcribe_has_available_models').length;
  const toasts = boundary.toasts.map((t) => ({ member: t.member, title: String(t.args[0]) }));
  const downloading = toasts.some((t) => t.member === 'info' && t.title === 'Model download in progress');
  const notReady = toasts.some((t) => t.member === 'error' && t.title === 'Transcription model not ready') && modals.some((m) => m.name === 'modelSelector');
  const outcome = started ? 'start' : downloading ? 'downloading' : notReady ? 'not-ready' : 'nothing';
  return { outcome, asked, started };
}

const failures = [];
for (const condition of CONDITIONS) {
  for (const path of PATHS) {
    const { outcome, asked } = await drive(condition, path);
    // A path that never ran asks nothing; that is not a pass for anything.
    if (asked !== 1) failures.push(`${condition.id} (${condition.what}) via ${path}: the pre-check ran ${asked} times`);
    if (outcome !== condition.expect) failures.push(`${condition.id} (${condition.what}) via ${path}: ${outcome}, expected ${condition.expect}`);
  }
}

assert.deepEqual(failures, [], `the recording pre-check answered for the wrong model:\n  ${failures.join('\n  ')}`);
console.log('ok - on all three start paths, the pre-check routes on the state of the model the recording would use: missing, downloading, corrupted and failed refuse with their own message, a command that cannot answer refuses, builtin-ai with Gemma starts, and a ready model starts');

// One stop state, one save, from every route and after a reload. (#328)
//
// The real `RecordingStateProvider`, `TranscriptProvider` and `RecordingPostProcessingProvider`, with Home, the
// transport and the sidebar mounted inside them, driven by events alone. What is stubbed is the boundary: Tauri's
// `invoke` and `listen`, the router, the sidebar's provider, and the summary-language helpers the save calls.
// IndexedDB is `fake-indexeddb`, shared by the two module graphs of a reload as a real reload shares it.
//
// **The event bus is the instrument.** Tauri dispatches one emission to the listeners registered when it was emitted,
// in `HashSet` order, in one task. The bus snapshots the table at emit, calls each listener synchronously, and lets a
// cell pick the order: `first` delivers in registration order, which puts the trigger's module-scope listener first,
// and `reverse` puts it last. A listener registers when `listen` is called, before its promise resolves.
//
// **A reload is a second `loadTsx` with a fresh listener table,** after the first root is unmounted and the window's
// trigger singleton deleted, as a reload discards it. sessionStorage and the IndexedDB factory survive, as they do.
//
// Each cell starts from a reset: the singleton deleted, sessionStorage cleared, a fresh `IDBFactory`. One
// `setupDom()` serves the file, so nothing else may carry between cells.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');
const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (ms = 40) => act(async () => { await sleep(ms); });
const deferred = () => { let resolve; let reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const TRIGGER = '__backchannelRecordingStopTrigger';
const { TooltipProvider } = loadTsx('src/components/ui/tooltip.tsx');

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ''}`); };

/** Tauri's event bus, as the webview sees it. */
function eventBus() {
  let next = 1;
  const table = new Map();
  const onRegister = new Map();
  const listen = async (event, cb) => {
    const id = next++;
    table.set(id, { event, cb });
    onRegister.get(event)?.(cb);
    return () => { table.delete(id); };
  };
  const count = (event) => [...table.values()].filter((l) => l.event === event).length;
  const emit = (event, payload, order = 'first') => {
    const ids = [...table.entries()].filter(([, l]) => l.event === event).map(([id]) => id);
    if (order === 'reverse') ids.reverse();
    for (const l of ids.map((id) => table.get(id))) l.cb({ event, id: 0, payload });
  };
  return { listen, emit, count, onRegister };
}

/** The backend: what each command answers, with any answer replaceable by a deferred. */
function backend() {
  const calls = [];
  const st = { recording: false, stopping: false, history: [], saved: 0 };
  const handlers = {
    get_recording_state: () => ({
      is_recording: st.recording, is_stopping: st.stopping, is_paused: false, is_active: st.recording,
      recording_duration: st.recording ? 12 : null, active_duration: st.recording ? 12 : null, mic_frames: st.recording ? 4800 : 0,
    }),
    get_transcript_history: () => st.history,
    get_recording_meeting_name: () => 'Standup',
    get_meeting_folder_path: () => null,
    get_transcription_status: () => ({ chunks_in_queue: 0, is_processing: false, last_activity_ms: 0 }),
    api_save_transcript: () => ({ meeting_id: `saved-${++st.saved}` }),
    api_get_meeting: ({ meetingId }) => ({ id: meetingId, title: 'Standup' }),
    is_recording: () => st.recording,
    has_audio_checkpoints: () => false,
    stop_recording: () => null,
  };
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    const f = handlers[cmd];
    if (!f) throw new Error(`invoked an unstubbed command: ${cmd}`);
    return f(args ?? {});
  };
  return { st, handlers, calls, invoke, saves: () => calls.filter((c) => c.cmd === 'api_save_transcript') };
}

/** The router: pushes are recorded, and a URL commits only when a cell commits it. */
function urlStore(initial) {
  let url = new URL(initial, 'http://localhost');
  const subs = new Set();
  const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
  const pushes = [];
  const router = { push: (to) => { pushes.push(to); }, replace: () => {}, back: () => {}, prefetch: () => {}, refresh: () => {} };
  const mod = {
    useRouter: () => router,
    usePathname: () => React.useSyncExternalStore(subscribe, () => url.pathname, () => url.pathname),
    useSearchParams: () => {
      const search = React.useSyncExternalStore(subscribe, () => url.search, () => url.search);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
  return { mod, pushes, commit: (to) => act(async () => { url = new URL(to, 'http://localhost'); subs.forEach((f) => f()); }) };
}

const SIDEBAR = {
  currentMeeting: null, setCurrentMeeting: () => {}, sidebarItems: [], isCollapsed: false, toggleCollapse: () => {},
  handleRecordingToggle: () => {}, searchTranscripts: async () => {}, searchResults: [], isSearching: false,
  meetings: [], setMeetings: () => {}, refetchMeetings: async () => {}, setIsMeetingActive: () => {}, isMeetingActive: false,
};

function resetWindow() {
  delete window[TRIGGER];
  window.sessionStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
}

/**
 * One page load: its own listener table and module graph over the shared backend, URL and storage. Mounts Home with
 * the transport, the sidebar and the transcript view, unless `bare`.
 */
function pageLoad(be, url, { bare = false, bus = eventBus() } = {}) {
  const stubs = boundaryStubs();
  const base = {
    ...stubs.modules,
    '@tauri-apps/api/core': { invoke: be.invoke },
    '@tauri-apps/api/event': { listen: bus.listen },
    '@tauri-apps/api/path': { appDataDir: async () => '/data' },
    'next/navigation': url.mod,
    '@/components/Sidebar/SidebarProvider': { useSidebar: () => SIDEBAR },
    './SidebarProvider': { useSidebar: () => SIDEBAR },
    '@/lib/summary-language-preferences': { applyPinnedSummaryLanguageToMeeting: async () => true, detectAndCacheSummaryLanguage: async () => {} },
    '@/contexts/ImportDialogContext': { useImportDialog: () => ({ openImportDialog: () => {} }) },
    '@/hooks/useAppVersion': { useAppVersion: () => '0.0.0-test' },
  };
  const trigger = loadTsx('src/lib/recording-stop-trigger.ts', base);
  const withTrigger = { ...base, '@/lib/recording-stop-trigger': trigger };
  const rs = loadTsx('src/contexts/RecordingStateContext.tsx', withTrigger);
  const withRs = { ...withTrigger, '@/contexts/RecordingStateContext': rs, './RecordingStateContext': rs };
  const tc = loadTsx('src/contexts/TranscriptContext.tsx', withRs);
  const withTc = { ...withRs, '@/contexts/TranscriptContext': tc, './TranscriptContext': tc };
  const post = loadTsx('src/contexts/RecordingPostProcessingProvider.tsx', withTc);
  const registered = { stopped: bus.count('recording-stopped'), started: bus.count('recording-started') };
  const home = bare ? null : loadTsx('src/app/page.tsx', {
    ...withTc,
    '@/contexts/ConfigContext': { useConfig: () => ({ transcriptModelConfig: {}, selectedDevices: {} }) },
    '@/hooks/usePermissionCheck': { usePermissionCheck: () => ({ hasMicrophone: true }) },
    '@/hooks/useModalState': { useModalState: () => ({ modals: {}, messages: {}, showModal: () => {}, hideModal: () => {} }) },
    './_components/SettingsModal': { SettingsModals: () => null },
    './_components/TranscriptPanel': { TranscriptPanel: () => null },
    '@/app/_components/StatusOverlays': { StatusOverlays: () => null },
    '@/components/TranscriptRecovery': { TranscriptRecovery: (p) => (p.isOpen ? h('div', { 'data-recovery': String(p.recoverableMeetings.length) }) : null) },
    '@/hooks/useRecordingStart': { useRecordingStart: () => ({ handleRecordingStart: async () => {}, isStarting: false, startPhase: 'idle' }) },
  }).default;
  const sidebar = bare ? null : loadTsx('src/components/Sidebar/index.tsx', withTc).default;
  const view = bare ? null : loadTsx('src/components/VirtualizedTranscriptView.tsx', withTc).VirtualizedTranscriptView;

  const renders = [];
  const Probe = () => {
    const s = rs.useRecordingState();
    React.useLayoutEffect(() => {
      const text = document.body.textContent ?? '';
      renders.push({ status: s.status, message: s.statusMessage, isRecording: s.isRecording, start: text.includes('Start recording'), listening: /Listening|Waiting for audio/.test(text), live: !!document.querySelector('[aria-label="Stop recording"], [aria-label="Pause recording"]') });
    });
    return null;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(h(TooltipProvider, null, h(rs.RecordingStateProvider, null, h(tc.TranscriptProvider, null, h(post.RecordingPostProcessingProvider, null,
      home && h(home), sidebar && h(sidebar), view && h(ViewHost, { View: view, useRs: rs.useRecordingState }), h(Probe))))));
  });
  const unmount = () => act(async () => { root.unmount(); container.remove(); });
  return { bus, toasts: stubs.toasts, registered, render, unmount, renders, rs, tc };
}

/** The transcript view with the recording flag the context gives, as TranscriptPanel passes it. */
function ViewHost({ View, useRs }) {
  const s = useRs();
  return h(View, { segments: [], isRecording: s.isRecording, isPaused: s.isPaused, isStopping: false, isProcessing: false });
}

const row = (n, text = `row ${n}`) => ({
  text, timestamp: `00:0${n}`, sequence_id: n, chunk_start_time: n, is_partial: false, confidence: 0.9,
  audio_start_time: n, audio_end_time: n + 0.5, duration: 0.5, speaker: null, channel: 'you',
});
const hist = (n, text = `row ${n}`) => ({
  id: `h${n}`, text, display_time: `00:0${n}`, sequence_id: n, audio_start_time: n, audio_end_time: n + 0.5,
  duration: 0.5, confidence: 0.9, speaker: null, channel: 'you',
});
const PROGRESS = [
  ['stopping_audio', 'Stopping audio capture...', 20],
  ['processing_transcripts', 'Processing remaining transcript chunks...', 40],
  ['processing_transcripts', 'Processing transcripts... (2s elapsed)', 40],
  ['finalizing', 'Finalizing transcription...', 70],
  ['finalizing', 'Finalizing recording and cleaning up resources...', 90],
  ['complete', 'Recording stopped successfully', 100],
];
const STOPPED = { message: 'Recording stopped', folder_path: '/data/m', meeting_name: 'Standup' };

/** A recording this page saw start, with `rows` delivered. */
async function recordHere(p, be, rows) {
  be.st.recording = true;
  await act(async () => { p.bus.emit('recording-started', {}); });
  await settle();
  for (const r of rows) await act(async () => { p.bus.emit('transcript-update', r); });
  await settle();
}

/** The backend's stop: progress, a re-render after the last progress event, then `recording-stopped`. */
async function backendStops(p, be, order = 'first', { afterComplete } = {}) {
  be.st.stopping = true;
  for (const [stage, message, progress] of PROGRESS) {
    await act(async () => { p.bus.emit('recording-shutdown-progress', { stage, message, progress }); });
  }
  await settle(10); // the provider re-renders between `:634` and `:644`
  afterComplete?.();
  be.st.recording = false;
  be.st.stopping = false;
  await act(async () => { p.bus.emit('recording-stopped', STOPPED, order); });
  await settle(80);
}

const savedTexts = (call) => call.args.transcripts.map((t) => t.text);
const meetingId = () => window.sessionStorage.getItem('indexeddb_current_meeting_id');

// --- item 3: one save per emission, from every route, in both orders ------------------------------------------------

const ROUTES = ['in-app, invoke first', 'in-app, event first', 'tray', 'window then tray', 'second stop'];
for (const route of ROUTES) {
  for (const order of ['first', 'reverse']) {
    const cell = `3 ${route}, trigger ${order === 'first' ? 'first' : 'last'}`;
    resetWindow();
    const be = backend();
    const url = urlStore('/');
    const p = pageLoad(be, url);
    check(`${cell}: the trigger module registers one recording-stopped and one recording-started listener`, p.registered.stopped === 1 && p.registered.started === 1, JSON.stringify(p.registered));
    await p.render();
    await settle();
    const stops = route === 'second stop' ? 2 : 1;
    for (let s = 0; s < stops; s++) {
      await recordHere(p, be, [row(1, `s${s} one`), row(2, `s${s} two`)]);
      const inApp = route.startsWith('in-app') || route === 'window then tray';
      let invoke = null;
      if (inApp) {
        invoke = deferred();
        be.handlers.stop_recording = () => invoke.p;
        const stop = document.querySelector('[aria-label="Stop recording"]');
        check(`${cell}: the transport offers Stop before the press`, !!stop);
        await act(async () => { stop?.click(); });
        await settle(10);
      }
      await backendStops(p, be, order, {
        afterComplete: () => { if (route === 'in-app, invoke first') invoke.resolve(null); },
      });
      if (route === 'window then tray') await act(async () => { p.bus.emit('recording-stop-complete', true); });
      if (invoke && route !== 'in-app, invoke first') invoke.resolve(null);
      await settle(80);
      const saves = be.saves();
      check(`${cell}: stop ${s + 1} saves once`, saves.length === s + 1, `${saves.length} saves`);
      check(`${cell}: stop ${s + 1} saves its own rows`, saves[s] && savedTexts(saves[s]).join() === `s${s} one,s${s} two`, saves[s] && savedTexts(saves[s]).join());
      await url.commit(url.pushes.at(-1) ?? '/');
      await settle();
      await url.commit('/');
    }
    check(`${cell}: no toast says the meeting was not saved`, !p.toasts.some((t) => t.member === 'warning' && String(t.args[0]).includes('not saved')));
    await p.unmount();
  }
}

{
  // Fast Refresh evaluates the modules again in the same window: the singleton stays, so no second trigger registers,
  // and the save goes through the provider that is mounted now.
  const cell = '3 Fast Refresh: a second evaluation in the same window';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const p1 = pageLoad(be, url);
  await p1.render();
  await settle();
  await recordHere(p1, be, [row(1)]);
  await p1.unmount();
  const p2 = pageLoad(be, url, { bus: p1.bus });
  check(`${cell}: one trigger registration of each event`, p1.bus.count('recording-stopped') === 1 && p1.bus.count('recording-started') === 1, `${p1.bus.count('recording-stopped')} / ${p1.bus.count('recording-started')}`);
  await p2.render();
  await settle();
  await backendStops(p2, be);
  check(`${cell}: one emission saves once`, be.saves().length === 1, `${be.saves().length}`);
  await p2.unmount();
}

// --- item 3: after a reload ------------------------------------------------------------------------------------------

/** Page 1 sees the recording start and its rows; the reload follows, leaving storage and the backend as they are. */
async function reloadAfter(be, url, rows, { pressStop = false } = {}) {
  const p1 = pageLoad(be, url);
  await p1.render();
  await settle();
  await recordHere(p1, be, rows);
  const id = meetingId();
  if (pressStop) {
    be.handlers.stop_recording = () => new Promise(() => {});
    await act(async () => { document.querySelector('[aria-label="Stop recording"]')?.click(); });
    be.st.stopping = true;
  }
  await p1.unmount();
  delete window[TRIGGER];
  return id;
}

async function copyOf(p, id) {
  // Read through the page's own service, over the shared factory.
  const svc = loadTsx('src/services/indexedDBService.ts', {}).indexedDBService;
  return { meta: await svc.getMeetingMetadata(id), unsaved: (await svc.getAllMeetings()).map((m) => m.meetingId), rows: (await svc.getTranscripts(id)).map((t) => t.text) };
}

{
  const cell = '3(i) recording-stopped before the reloaded page first renders';
  resetWindow();
  const be = backend();
  const url = urlStore('/settings');
  const id = await reloadAfter(be, url, [row(1), row(2)]);
  check(`${cell}: page 1 wrote the copy`, !!id);
  const p2 = pageLoad(be, url);
  be.st.recording = false;
  await act(async () => { p2.bus.emit('recording-stopped', STOPPED); });
  await p2.render();
  await settle(120);
  const c = await act(async () => copyOf(p2, id));
  check(`${cell}: no save`, be.saves().length === 0, `${be.saves().length}`);
  check(`${cell}: the copy is left unmarked`, c.meta && c.meta.savedToSQLite === false && c.unsaved.includes(id), JSON.stringify(c.meta));
  check(`${cell}: a toast says so, with Recover`, p2.toasts.some((t) => t.member === 'warning' && String(t.args[0]).includes('not saved automatically') && t.args[1]?.action?.label === 'Recover' && t.args[1]?.duration === Infinity), JSON.stringify(p2.toasts.map((t) => [t.member, t.args[0]])));
  check(`${cell}: the state ends at IDLE`, p2.renders.at(-1)?.status === 'idle', p2.renders.at(-1)?.status);
  await p2.unmount();
}

{
  const cell = '3(ii) recording-stopped after the first render, before the mount sync answers';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const id = await reloadAfter(be, url, [row(1), row(2)]);
  const mount = deferred();
  be.handlers.get_recording_state = () => mount.p;
  const p2 = pageLoad(be, url);
  await p2.render();
  be.st.recording = false;
  await act(async () => { p2.bus.emit('recording-stopped', STOPPED); });
  mount.resolve({ is_recording: true, is_stopping: true, is_paused: false, is_active: false, recording_duration: 12, active_duration: 12, mic_frames: 1 });
  await settle(120);
  const c = await act(async () => copyOf(p2, id));
  check(`${cell}: no save`, be.saves().length === 0, `${be.saves().length}`);
  check(`${cell}: the copy is left unmarked`, c.meta?.savedToSQLite === false, JSON.stringify(c.meta));
  check(`${cell}: the state ends at IDLE, and Start renders on Home`, p2.renders.at(-1)?.status === 'idle' && p2.renders.at(-1)?.start, JSON.stringify(p2.renders.at(-1)));
  await p2.unmount();
}

{
  const cell = '3(iii) recording-stopped while the history is pending, which then answers H';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  await reloadAfter(be, url, [row(1), row(2)]);
  const history = deferred();
  be.handlers.get_transcript_history = () => history.p;
  be.st.recording = true;
  be.st.stopping = true;
  const p2 = pageLoad(be, url);
  await p2.render();
  await settle();
  be.st.recording = false;
  be.st.stopping = false;
  await act(async () => { p2.bus.emit('recording-stopped', STOPPED); });
  history.resolve([hist(1), hist(2)]);
  await settle(150);
  const saves = be.saves();
  check(`${cell}: one save, holding H`, saves.length === 1 && savedTexts(saves[0]).join() === 'row 1,row 2', saves.map(savedTexts).join(' | '));
  await p2.unmount();
}

{
  const cell = '3(iv) a reload during a live recording, then rows, then a tray Stop';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const id = await reloadAfter(be, url, [row(1), row(2)]);
  const before = await act(async () => copyOf(null, id));
  check(`${cell}: before the reload the copy exists, unsaved`, before.meta?.savedToSQLite === false, JSON.stringify(before.meta));
  be.st.recording = true;
  be.st.history = [hist(1), hist(2)];
  const p2 = pageLoad(be, url);
  await p2.render();
  await settle(80);
  for (const r of [row(3), row(4)]) await act(async () => { p2.bus.emit('transcript-update', r); });
  await settle();
  await backendStops(p2, be);
  const saves = be.saves();
  check(`${cell}: one save holding H and T`, saves.length === 1 && savedTexts(saves[0]).join() === 'row 1,row 2,row 3,row 4', saves.map(savedTexts).join(' | '));
  const after = await act(async () => copyOf(null, id));
  check(`${cell}: the same copy now reads saved`, after.meta?.savedToSQLite === true, JSON.stringify(after.meta));
  await p2.unmount();
}

{
  const cell = '3 a row merged before the recording-flag render still gets the history';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  await reloadAfter(be, url, [row(1), row(2)]);
  const mount = deferred();
  be.handlers.get_recording_state = () => mount.p;
  be.st.history = [hist(1), hist(2), hist(3)];
  const p2 = pageLoad(be, url);
  await p2.render();
  await act(async () => { p2.bus.emit('transcript-update', row(4)); });
  await settle();
  mount.resolve({ is_recording: true, is_stopping: false, is_paused: false, is_active: true, recording_duration: 12, active_duration: 12, mic_frames: 1 });
  be.handlers.get_recording_state = backend().handlers.get_recording_state.bind(null);
  be.st.recording = true;
  await settle(80);
  await backendStops(p2, be);
  const saves = be.saves();
  check(`${cell}: one save holding the history and the early row`, saves.length === 1 && savedTexts(saves[0]).join() === 'row 1,row 2,row 3,row 4', saves.map(savedTexts).join(' | '));
  await p2.unmount();
}

// --- item 4: a remount during a stop ---------------------------------------------------------------------------------

for (const [name, history, before, after, saved] of [
  ['H, T1 while it is pending, T2 after', [hist(1), hist(2)], [row(3)], [row(4)], 'row 1,row 2,row 3,row 4'],
  ['[] and no later rows', [], [], [], null],
  ['[] then T', [], [], [row(3)], null],
]) {
  const cell = `4 remount during a stop: ${name}`;
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const id = await reloadAfter(be, url, [row(1), row(2)], { pressStop: true });
  const pending = deferred();
  be.handlers.get_transcript_history = () => pending.p;
  be.st.recording = true;
  be.st.stopping = true;
  const p2 = pageLoad(be, url);
  await p2.render();
  await settle(20);
  check(`${cell}: the remount enters the stop state`, p2.renders.at(-1)?.status === 'stopping', p2.renders.at(-1)?.status);
  for (const r of before) await act(async () => { p2.bus.emit('transcript-update', r); });
  await settle();
  pending.resolve(history);
  await settle();
  for (const r of after) await act(async () => { p2.bus.emit('transcript-update', r); });
  await settle();
  be.st.recording = false;
  be.st.stopping = false;
  await act(async () => { p2.bus.emit('recording-stopped', STOPPED); });
  await settle(150);
  const saves = be.saves();
  const c = await act(async () => copyOf(null, id));
  if (saved) {
    check(`${cell}: one save, each row once, in order`, saves.length === 1 && savedTexts(saves[0]).join() === saved, saves.map(savedTexts).join(' | '));
  } else {
    check(`${cell}: no save`, saves.length === 0, `${saves.length}`);
    check(`${cell}: the copy is listed for recovery`, c.unsaved.includes(id), JSON.stringify(c.unsaved));
    check(`${cell}: a toast says so`, p2.toasts.some((t) => t.member === 'warning' && String(t.args[0]).includes('not saved automatically')));
    if (after.length) check(`${cell}: the copy holds the earlier rows and T`, c.rows.join() === 'row 1,row 2,row 3', c.rows.join());
  }
  await p2.unmount();
}

{
  const cell = '4 T0, delivered as the reloaded page registers its row listener, reaches the copy';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const id = await reloadAfter(be, url, [row(1), row(2)]);
  be.st.recording = true;
  const p2 = pageLoad(be, url);
  let sent = false;
  p2.bus.onRegister.set('transcript-update', (cb) => { if (!sent) { sent = true; cb({ event: 'transcript-update', id: 0, payload: row(3, 'T0') }); } });
  await p2.render();
  await settle(80);
  const c = await act(async () => copyOf(null, id));
  check(`${cell}`, sent && c.rows.includes('T0'), `sent ${sent}, copy ${c.rows.join()}`);
  await p2.unmount();
}

// --- item 4: leaving the state ---------------------------------------------------------------------------------------

for (const [name, start, commitTo] of [
  ['the push committed later', '/', null],
  ['a stop made from an older meeting', '/meeting-details?id=older', null],
  ['another navigation discards the save\'s push', '/', '/meeting-details?id=other'],
]) {
  const cell = `4 leave: ${name}`;
  resetWindow();
  const be = backend();
  const url = urlStore(start);
  const p = pageLoad(be, url);
  await p.render();
  await settle();
  await recordHere(p, be, [row(1)]);
  const from = p.renders.length;
  await backendStops(p, be);
  check(`${cell}: the save pushed the meeting`, url.pushes.length === 1, JSON.stringify(url.pushes));
  const before = p.renders.slice(from);
  check(`${cell}: until the commit, no Start and a stop status`, before.every((r) => !r.start && ['stopping', 'processing', 'saving', 'completed'].includes(r.status)), JSON.stringify(before.map((r) => [r.status, r.start])));
  await url.commit(commitTo ?? url.pushes[0]);
  await settle();
  check(`${cell}: the commit leaves to IDLE`, p.renders.at(-1)?.status === 'idle', p.renders.at(-1)?.status);
  await p.unmount();
}

{
  const cell = '4 leave: no commit at all leaves at the deadline';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const p = pageLoad(be, url);
  await p.render();
  await settle();
  await recordHere(p, be, [row(1)]);
  await backendStops(p, be);
  check(`${cell}: COMPLETED before the deadline`, p.renders.at(-1)?.status === 'completed', p.renders.at(-1)?.status);
  // Real time: the providers' module graph takes `setTimeout` when it is loaded, so `mock.timers` enabled now
  // would not reach it.
  await settle(10_100);
  check(`${cell}: IDLE after it`, p.renders.at(-1)?.status === 'idle', p.renders.at(-1)?.status);
  await p.unmount();
}

{
  const cell = '4 leave: a save that fails leaves at once';
  resetWindow();
  const be = backend();
  be.handlers.api_save_transcript = () => { throw new Error('disk full'); };
  const url = urlStore('/');
  const p = pageLoad(be, url);
  await p.render();
  await settle();
  await recordHere(p, be, [row(1)]);
  await backendStops(p, be);
  check(`${cell}: the error status, with Start back`, p.renders.at(-1)?.status === 'error' && p.renders.at(-1)?.start, JSON.stringify(p.renders.at(-1)));
  await p.unmount();
}

{
  const cell = '1 a poll answered after recording-stopped is discarded whole';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const p = pageLoad(be, url);
  await p.render();
  await settle();
  await recordHere(p, be, [row(1)]);
  const late = deferred();
  be.handlers.get_recording_state = () => late.p;
  await settle(600); // a poll is now in flight
  await backendStops(p, be);
  const at = p.renders.at(-1);
  late.resolve({ is_recording: true, is_stopping: false, is_paused: false, is_active: true, recording_duration: 99, active_duration: 99, mic_frames: 1 });
  await settle();
  const after = p.renders.at(-1);
  check(`${cell}`, after.isRecording === false && after.status === at.status, JSON.stringify({ at, after }));
  await p.unmount();
}

// --- item 1: the stop's progress, in the transport's spinner ---------------------------------------------------------

{
  const cell = '1 each progress message shows in the spinner, in turn';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const p = pageLoad(be, url);
  await p.render();
  await settle();
  await recordHere(p, be, [row(1)]);
  be.st.stopping = true;
  for (const [stage, message, progress] of PROGRESS) {
    await act(async () => { p.bus.emit('recording-shutdown-progress', { stage, message, progress }); });
    check(`${cell}: "${message}"`, (document.body.textContent ?? '').includes(message), document.body.textContent?.slice(0, 200));
  }

  check(`${cell}: and the transport offers neither Stop nor Pause`, !document.querySelector('[aria-label="Stop recording"], [aria-label="Pause recording"]'));
  await p.unmount();
}

{
  const cell = '1 a remount during a stop enters it, and polls';
  resetWindow();
  const be = backend();
  be.st.recording = true;
  be.st.stopping = true;
  const url = urlStore('/');
  const p = pageLoad(be, url);
  await p.render();
  await settle(700);
  check(`${cell}: STOPPING`, p.renders.at(-1)?.status === 'stopping', p.renders.at(-1)?.status);
  check(`${cell}: the poll runs`, be.calls.filter((c) => c.cmd === 'get_recording_state').length >= 2, `${be.calls.filter((c) => c.cmd === 'get_recording_state').length} reads`);
  await p.unmount();
}

// --- item 2: no surface claims a live recording during a stop, and none offers Start --------------------------------

for (const [where, start] of [['Home', '/'], ['settings', '/settings'], ['an older meeting', '/meeting-details?id=older']]) {
  for (const [answer, manager] of [['the manager in its slot', true], ['the manager out', false]]) {
    const cell = `2 during a tray stop, on ${where}, ${answer}`;
    resetWindow();
    const be = backend();
    if (!manager) be.handlers.get_recording_state = () => ({ is_recording: true, is_stopping: true, is_paused: false, is_active: false, recording_duration: null, active_duration: null, mic_frames: 0 });
    const url = urlStore(start);
    const p = pageLoad(be, url);
    await p.render();
    await settle();
    await recordHere(p, be, []);
    const from = p.renders.length;
    be.st.stopping = true;
    await act(async () => { p.bus.emit('recording-shutdown-progress', { stage: 'stopping_audio', message: 'Stopping audio capture...', progress: 20 }); });
    await settle(700); // polls answer while the stop runs
    const during = p.renders.slice(from);
    check(`${cell}: the status is STOPPING`, during.length > 0 && during.every((r) => r.status === 'stopping'), JSON.stringify(during.map((r) => r.status)));
    check(`${cell}: no Start`, during.every((r) => !r.start), JSON.stringify(during.map((r) => r.start)));
    check(`${cell}: no Pause or Stop`, during.every((r) => !r.live));
    check(`${cell}: no Listening state`, during.every((r) => !r.listening));
    check(`${cell}: no live badge`, !document.querySelector('button')?.textContent?.includes('Open') || !(document.body.textContent ?? '').includes('Open'));
    await p.unmount();
  }
}

// --- the not-saved toast's action -------------------------------------------------------------------------------------

{
  const cell = 'the toast\'s Recover opens the dialog on Home, though it was shown this session';
  resetWindow();
  const be = backend();
  const url = urlStore('/');
  const id = await reloadAfter(be, url, [row(1)]);
  const p2 = pageLoad(be, url);
  be.st.recording = false;
  await act(async () => { p2.bus.emit('recording-stopped', STOPPED); });
  await p2.render();
  await settle(120);
  window.sessionStorage.setItem('recovery_dialog_shown', 'true');
  const toast = p2.toasts.find((t) => t.member === 'warning' && String(t.args[0]).includes('not saved automatically'));
  check(`${cell}: the toast exists`, !!toast);
  await act(async () => { toast?.args[1]?.action?.onClick(); });
  await settle(2600); // recovery hides a meeting written in the last two seconds
  await act(async () => { toast?.args[1]?.action?.onClick(); });
  await settle(200);
  check(`${cell}: the dialog is open, listing the meeting`, document.querySelector('[data-recovery]')?.getAttribute('data-recovery') === '1', `${document.querySelector('[data-recovery]')?.outerHTML} (${id})`);
  await p2.unmount();
}

// The stop's folder update and the save's mark run in the same moments now, both after `recording-stopped`. A read in
// one transaction and a write in another lost the mark; found by cell 3(iv), red once in three runs before the fix.
// Deterministic here: the folder update is issued first, so a two-step update reads before the mark and writes after.
{
  const cell = '3 the folder update and the saved mark, concurrent, keep both';
  resetWindow();
  const svc = loadTsx('src/services/indexedDBService.ts', {}).indexedDBService;
  const r = await act(async () => {
    await svc.saveMeetingMetadata({ meetingId: 'm-race', title: 'Standup', startTime: 1, lastUpdated: 1, transcriptCount: 0, savedToSQLite: false });
    await Promise.all([svc.updateMeetingFolderPath('m-race', '/data/m'), svc.markMeetingSaved('m-race')]);
    return svc.getMeetingMetadata('m-race');
  });
  check(cell, r?.savedToSQLite === true && r?.folderPath === '/data/m', JSON.stringify(r));
}

// Item 5: the "Stopping…" label is gone from the source. It never rendered, because the spinner branch wins whenever
// the button's own `isStopping` is set, so no render could show it present: only the source can.
{
  const src = (await import('node:fs')).readFileSync(new URL('../../src/components/RecordingControls.tsx', import.meta.url), 'utf8');
  check('5 the dead "Stopping…" branch is gone from RecordingControls', !src.includes('Stopping…'));
}

assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log('ok - one stop state, one save: every route in both orders, after a reload, through a remount, and the state leaves');

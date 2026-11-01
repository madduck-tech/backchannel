'use client';

import { listen } from '@tauri-apps/api/event';

/**
 * The one trigger for a meeting's save: `recording-stopped`, heard once per page load (#328).
 *
 * Stop emits `recording-stopped` once per recording, whichever route stopped it: the window, the tray, or
 * a second Stop that found nothing left to stop and returned without it. So one listener at module scope,
 * registered when this module is first evaluated and never re-subscribed, sees every recording's end
 * exactly once. A listener inside a React effect would not: Tauri dispatches one emission to the set of
 * listeners fixed when it was emitted, in `HashSet` order, and an effect keyed on a handler that changes
 * each render unsubscribes and resubscribes between two emissions of one stop.
 *
 * Everything the page load knows about the recording's end lives here, on `window`, so a real reload
 * discards it with the page and Fast Refresh keeps it:
 * - whether this page load saw the recording's `recording-started`. A page that did not was reloaded
 *   during the recording or the stop, and holds only what its reload sync fetched;
 * - the emissions counted, which a poll or a sync answer started before the latest one is judged by;
 * - the syncs with the backend in flight, which a decision waits for;
 * - whether a reload sync answered a non-empty history;
 * - the provider's handler, and the emissions that arrived before it was set.
 */

/** What `recording-stopped` carries. */
export interface RecordingStoppedPayload {
  message?: string;
  folder_path?: string | null;
  meeting_name?: string | null;
}

/** One emission of `recording-stopped`, numbered within the page load. */
export interface StopEmission {
  n: number;
  /** Whether this page load saw the recording's `recording-started`. */
  sawStart: boolean;
  payload: RecordingStoppedPayload;
}

interface Trigger {
  listening: boolean;
  count: number;
  sawStart: boolean;
  historyRows: boolean;
  syncs: Set<Promise<unknown>>;
  handler: ((e: StopEmission) => void) | null;
  resolveQueued: ((e: StopEmission) => void) | null;
  queue: StopEmission[];
  reloadSync: (() => Promise<number>) | null;
}

const KEY = '__backchannelRecordingStopTrigger';

function state(): Trigger | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, Trigger | undefined>;
  return (w[KEY] ??= {
    listening: false,
    count: 0,
    sawStart: false,
    historyRows: false,
    syncs: new Set(),
    handler: null,
    resolveQueued: null,
    queue: [],
    reloadSync: null,
  });
}

// Registered on first evaluation, outside React. `typeof window` keeps the static prerender out, where
// `listen` reaches for `window.__TAURI_INTERNALS__`; the `.catch` keeps the nudge window quiet, which
// evaluates this module through the layout but holds no capability to listen.
{
  const t = state();
  if (t && !t.listening) {
    t.listening = true;
    listen('recording-started', () => {
      t.sawStart = true;
      t.historyRows = false;
    }).catch((error) => console.warn('[RecordingStopTrigger] Could not listen for recording-started:', error));
    listen<RecordingStoppedPayload>('recording-stopped', (event) => {
      // Read before it is cleared, by this listener and no other: a second listener clearing it could run
      // first, in `HashSet` order.
      const emission: StopEmission = { n: ++t.count, sawStart: t.sawStart, payload: event.payload ?? {} };
      t.sawStart = false;
      if (t.handler) t.handler(emission);
      else t.queue.push(emission);
    }).catch((error) => console.warn('[RecordingStopTrigger] Could not listen for recording-stopped:', error));
  }
}

/**
 * The provider's handler, kept current, and what to do with an emission that arrived before it was set.
 * Such an emission can only follow a reload, and the page's mount sync has not answered yet, so the page
 * holds none of the meeting's rows: it is resolved without a save.
 */
export function setStopHandler(
  handler: ((e: StopEmission) => void) | null,
  resolveQueued: ((e: StopEmission) => void) | null = null,
): void {
  const t = state();
  if (!t) return;
  t.handler = handler;
  t.resolveQueued = resolveQueued;
  if (handler && resolveQueued) for (const e of t.queue.splice(0)) resolveQueued(e);
}

/** Emissions counted in this page load. A sync started at one count and answered at another is late. */
export function stopCount(): number {
  return state()?.count ?? 0;
}

/** Register a sync with the backend in flight: a decision waits for it. */
export function trackSync<T>(p: Promise<T>): Promise<T> {
  const t = state();
  if (!t) return p;
  t.syncs.add(p);
  const done = () => { t.syncs.delete(p); };
  p.then(done, done);
  return p;
}

/** Resolves once no sync is in flight. A sync an answer starts is waited for too. */
export async function syncsSettled(): Promise<void> {
  const t = state();
  if (!t) return;
  while (t.syncs.size > 0) await Promise.allSettled([...t.syncs]);
}

/** The transcript provider's reload sync, which the recording state runs on each false→true transition. */
export function setReloadSync(fn: (() => Promise<number>) | null): void {
  const t = state();
  if (t) t.reloadSync = fn;
}

/** Run the reload sync now, in the same task as the transition that calls for it, and track it. */
export function startReloadSync(): void {
  const t = state();
  if (!t?.reloadSync) return;
  trackSync(
    t.reloadSync().then((rows) => {
      if (rows > 0) t.historyRows = true;
      return rows;
    }),
  );
}

/** Whether a reload sync answered a non-empty history since the recording last started. Read once per stop. */
export function takeHistoryAnswered(): boolean {
  const t = state();
  if (!t) return false;
  const answered = t.historyRows;
  t.historyRows = false;
  return answered;
}

'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePathname, useSearchParams } from 'next/navigation';
import { recordingService } from '@/services/recordingService';
import { startReloadSync, stopCount, trackSync } from '@/lib/recording-stop-trigger';

/**
 * Recording state synchronized with backend
 * This context provides a single source of truth for recording state
 * that automatically syncs with the Rust backend, solving:
 * 1. Page refresh desync (backend recording but UI shows stopped)
 * 2. Pause state visibility across components
 * 3. Comprehensive state for future features (reconnection, etc.)
 */

// The lifecycle statuses live in a module of their own, so a component that only compares them does not need this
// provider's module (a test that stubs the provider still gets the real values).
import { RecordingStatus, STOP_FLOW } from '@/lib/recording-status';
export { RecordingStatus, STOP_FLOW };

interface RecordingState {
  isRecording: boolean;           // Is a recording session active
  isPaused: boolean;              // Is the recording paused
  isActive: boolean;              // Is actively recording (recording && !paused)
  recordingDuration: number | null;  // Total duration including pauses
  activeDuration: number | null;     // Active recording time (excluding pauses)

  /**
   * Has the microphone delivered a single frame this recording?
   *
   * An elapsed timer keeps ticking whether or not the headset disconnected, the
   * OS switched inputs, or another app took the device — this is the one bit
   * that does not. Narrow on purpose: it catches "opened but delivering
   * nothing", not a muted-but-live mic (the level meter covers that) and not a
   * system-audio-only capture.
   */
  captureArmed: boolean;

  // NEW: Lifecycle status
  status: RecordingStatus;
  statusMessage?: string;  // Optional message for current status
}

/**
 * `get_recording_state` gained `mic_frames`; the shared `RecordingState` type in
 * services/recordingService.ts has not been widened for it yet, so it is read
 * off the response here rather than papered over with `any`.
 */
type BackendRecordingState = Awaited<ReturnType<typeof recordingService.getRecordingState>> & {
  mic_frames?: number;
  /** A Stop between its check and `recording-stopped` (#328). */
  is_stopping?: boolean;
};



/** The statuses a stop passes through after `recording-stopped`, in which a progress event changes nothing. */
const AFTER_STOPPED: RecordingStatus[] = [
  RecordingStatus.PROCESSING_TRANSCRIPTS,
  RecordingStatus.SAVING,
  RecordingStatus.COMPLETED,
];

/** How long COMPLETED waits for a commit before it leaves anyway (#328 v11). */
const LEAVE_DEADLINE_MS = 10_000;
/** How long a poll that reports no stop waits for `recording-stopped` before it ends the state (#328). */
const FAILED_STOP_WAIT_MS = 1_000;

/** Payload of `recording-shutdown-progress`. */
interface ShutdownProgress {
  stage?: string;
  message?: string;
  progress?: number;
}

/** Payload of the backend's 100ms `mic-level` event. */
interface MicLevelPayload {
  rms: number;
  armed: boolean;
}

interface RecordingStateContextType extends RecordingState {
  // NEW: Setters for status management
  setStatus: (status: RecordingStatus, message?: string) => void;
  /**
   * Called with COMPLETED, before the save's navigation: the state leaves to IDLE on the first commit of a URL other
   * than the one shown now, or after a deadline. Until then nothing offers Start (#328 item 4).
   */
  leaveOnNextUrl: () => void;

  // Computed helpers (derived from status)
  isStopping: boolean;
  isProcessing: boolean;
  isSaving: boolean;
}

const RecordingStateContext = createContext<RecordingStateContextType | null>(null);

export const useRecordingState = () => {
  const context = useContext(RecordingStateContext);
  if (!context) {
    throw new Error('useRecordingState must be used within a RecordingStateProvider');
  }
  return context;
};

export function RecordingStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    isPaused: false,
    isActive: false,
    recordingDuration: null,
    activeDuration: null,
    captureArmed: false,
    status: RecordingStatus.IDLE,  // NEW: Initialize with IDLE status
    statusMessage: undefined,       // NEW: No message initially
  });

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  // Whether the backend has confirmed the stop in progress: a progress event, or an answer with `is_stopping`. Only then
  // may a poll that reports no stop end the state. A poll answered between an in-app press and the backend taking its
  // guard reports none, and must not send the window back to RECORDING (#328).
  const backendStopSeen = useRef(false);
  const failedStopTimer = useRef<NodeJS.Timeout | null>(null);
  // The recording flag as last observed, to run the transcript provider's reload sync on each false→true transition,
  // in the same task as the observation (#328 v9: whatever the transcripts' length).
  const isRecordingRef = useRef(false);
  const observeRecording = (recording: boolean) => {
    const was = isRecordingRef.current;
    isRecordingRef.current = recording;
    if (recording && !was) startReloadSync();
  };

  // NEW: Status setter with logging
  const setStatus = useCallback((status: RecordingStatus, message?: string) => {
    console.log(`[RecordingState] Status: ${state.status} → ${status}`, message || '');

    setState(prev => ({
      ...prev,
      status,
      statusMessage: message,
    }));
  }, [state.status, state.isRecording, state.isPaused]);

  /**
   * Sync recording state with backend
   * Called on mount (fixes refresh desync) and periodically while recording
   *
   * An answer started before a `recording-stopped` and delivered after it is discarded whole: it carries
   * `is_recording: true` and durations the event has already cleared, and polling has stopped (#328).
   */
  const syncWithBackend = async (kind: 'mount' | 'poll') => {
    const counted = stopCount();
    try {
      const backendState: BackendRecordingState = await recordingService.getRecordingState();
      if (stopCount() !== counted) {
        console.log('[RecordingStateContext] Discarded an answer that recording-stopped overtook:', backendState);
        return;
      }
      const stopping = backendState.is_stopping === true;
      observeRecording(backendState.is_recording);

      setState(prev => ({
        ...prev,
        isRecording: backendState.is_recording,
        isPaused: backendState.is_paused,
        isActive: backendState.is_active,
        recordingDuration: backendState.recording_duration,
        activeDuration: backendState.active_duration,
        // A reload mid-meeting has to land on the truth too, not on "Waiting
        // for audio" for a recording that has been capturing for forty minutes.
        captureArmed: (backendState.mic_frames ?? 0) > 0,
        ...(stopping && prev.status !== RecordingStatus.STOPPING ? { status: RecordingStatus.STOPPING, statusMessage: undefined } : {}),
      }));

      if (stopping) {
        backendStopSeen.current = true;
        // Polling otherwise starts only on `recording-started`, so after a reload the state could never leave a failed stop.
        if (kind === 'mount') startPolling();
      } else if (backendStopSeen.current && statusRef.current === RecordingStatus.STOPPING) {
        leaveFailedStop(backendState.is_recording);
      }

      console.log('[RecordingStateContext] Synced with backend:', backendState);
    } catch (error) {
      console.error('[RecordingStateContext] Failed to sync with backend:', error);
      // Don't update state on error - keep current state
    }
  };

  /**
   * The backend reported no stop after it had reported one. Between the guard's drop and `recording-stopped` that is
   * true of a stop that succeeded too, so the state ends only if no `recording-stopped` arrives within a second: to
   * RECORDING when the recording is still running, as after a failed tray stop, and to IDLE otherwise.
   */
  const leaveFailedStop = (stillRecording: boolean) => {
    if (failedStopTimer.current) return;
    const counted = stopCount();
    failedStopTimer.current = setTimeout(() => {
      failedStopTimer.current = null;
      if (stopCount() !== counted) return;
      backendStopSeen.current = false;
      setState(prev => (prev.status === RecordingStatus.STOPPING
        ? { ...prev, status: stillRecording ? RecordingStatus.RECORDING : RecordingStatus.IDLE, statusMessage: undefined }
        : prev));
      if (!stillRecording) stopPolling();
    }, FAILED_STOP_WAIT_MS);
  };

  /**
   * Start polling backend state (called when recording starts)
   */
  const startPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    console.log('[RecordingStateContext] Starting state polling (500ms interval)');
    pollingIntervalRef.current = setInterval(() => { void syncWithBackend('poll'); }, 500);
  };

  /**
   * Stop polling backend state (called when recording stops)
   */
  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      console.log('[RecordingStateContext] Stopping state polling');
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

  /**
   * Set up event listeners for backend state changes
   */
  useEffect(() => {
    console.log('[RecordingStateContext] Setting up event listeners');
    const unsubscribers: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        // Recording started
        const unlistenStarted = await recordingService.onRecordingStarted(() => {
          console.log('[RecordingStateContext] Recording started event');
          observeRecording(true);
          setState(prev => ({
            ...prev,
            isRecording: true,
            isPaused: false,
            isActive: true,
            status: RecordingStatus.RECORDING,  // NEW: Set status to RECORDING
          }));
          startPolling();
        });
        unsubscribers.push(unlistenStarted);

        // The arming gate's fast channel. The 500ms poll below also carries
        // `mic_frames`, but it only starts once `recording-started` fires —
        // which is after the model load — and capture is live throughout that
        // load. This listener is what makes the gate honest during it.
        //
        // Latches on and is cleared only by `recording-stopped`. Within one
        // recording the underlying fact is monotone — the mic either has
        // delivered a frame or has not — and the event stream is not: teardown
        // emits a final zeroed payload to park the meter, and lowering the flag
        // on that would drop the transcript pane back to "Waiting for audio"
        // for the length of the decoder's drain.
        //
        // Fires ten times a second, so it must not re-render the whole tree on
        // every tick: returning `prev` unchanged makes React bail out, leaving
        // exactly one render, at the moment the mic first delivers.
        const unlistenMicLevel = await listen<MicLevelPayload>('mic-level', (event) => {
          if (!event.payload.armed) return;
          setState(prev => (prev.captureArmed ? prev : { ...prev, captureArmed: true }));
        });
        unsubscribers.push(unlistenMicLevel);

        // The stop's progress, rendered in the transport's spinner (#328 item 1). It also enters the stop state for a
        // stop this window did not start: a tray Stop arrives here first.
        const unlistenProgress = await listen<ShutdownProgress>('recording-shutdown-progress', (event) => {
          backendStopSeen.current = true;
          setState(prev => (AFTER_STOPPED.includes(prev.status)
            ? prev
            : { ...prev, status: RecordingStatus.STOPPING, statusMessage: event.payload?.message }));
        });
        unsubscribers.push(unlistenProgress);

        // Recording stopped
        const unlistenStopped = await recordingService.onRecordingStopped((payload) => {
          console.log('[RecordingStateContext] Recording stopped event:', payload);
          observeRecording(false);
          backendStopSeen.current = false;
          if (failedStopTimer.current) { clearTimeout(failedStopTimer.current); failedStopTimer.current = null; }
          setState(prev => {
            // Set status to STOPPING if not already in stop flow
            // This ensures smooth UI transition for tray/keyboard stops
            const newStatus = [
              RecordingStatus.STOPPING,
              RecordingStatus.PROCESSING_TRANSCRIPTS,
              RecordingStatus.SAVING
            ].includes(prev.status)
              ? prev.status  // Already in stop flow
              : RecordingStatus.STOPPING;  // New stop, transition smoothly

            return {
              ...prev,
              status: newStatus,
              statusMessage: newStatus === RecordingStatus.STOPPING ? 'Stopping recording...' : prev.statusMessage,
              isRecording: false,
              isPaused: false,
              isActive: false,
              recordingDuration: null,
              activeDuration: null,
              captureArmed: false,
            };
          });
          stopPolling();
        });
        unsubscribers.push(unlistenStopped);

        // Recording paused
        const unlistenPaused = await recordingService.onRecordingPaused(() => {
          console.log('[RecordingStateContext] Recording paused event');
          setState(prev => ({
            ...prev,
            isPaused: true,
            isActive: false,
          }));
        });
        unsubscribers.push(unlistenPaused);

        // Recording resumed
        const unlistenResumed = await recordingService.onRecordingResumed(() => {
          console.log('[RecordingStateContext] Recording resumed event');
          setState(prev => ({
            ...prev,
            isPaused: false,
            isActive: true,
          }));
        });
        unsubscribers.push(unlistenResumed);

        console.log('[RecordingStateContext] Event listeners set up successfully');
      } catch (error) {
        console.error('[RecordingStateContext] Failed to set up event listeners:', error);
      }
    };

    setupListeners();

    return () => {
      console.log('[RecordingStateContext] Cleaning up event listeners');
      unsubscribers.forEach(unsub => unsub());
      stopPolling();
      if (failedStopTimer.current) clearTimeout(failedStopTimer.current);
    };
  }, []);

  /**
   * Initial sync on mount - CRITICAL for fixing refresh desync bug
   * If backend is recording but UI state is false, this will correct it
   *
   * Tracked, so a save decided after a reload waits for it (#328 item 3).
   */
  useEffect(() => {
    console.log('[RecordingStateContext] Initial mount - syncing with backend');
    void trackSync(syncWithBackend('mount'));
  }, []);

  // Leaving COMPLETED (#328 item 4): on the first commit of a URL other than the one shown when it was set, or at a
  // deadline. Next discards a pending push when another navigation arrives, so the save's own URL may never commit.
  const urlRef = useRef<string | null>(null);
  const leaveFrom = useRef<string | null>(null);
  const leaveDeadline = useRef<NodeJS.Timeout | null>(null);
  const finishLeave = useCallback(() => {
    leaveFrom.current = null;
    if (leaveDeadline.current) { clearTimeout(leaveDeadline.current); leaveDeadline.current = null; }
    setState(prev => (prev.status === RecordingStatus.COMPLETED ? { ...prev, status: RecordingStatus.IDLE, statusMessage: undefined } : prev));
  }, []);
  const reportUrl = useCallback((url: string) => {
    urlRef.current = url;
    if (leaveFrom.current !== null && url !== leaveFrom.current) finishLeave();
  }, [finishLeave]);
  const leaveOnNextUrl = useCallback(() => {
    leaveFrom.current = urlRef.current ?? '';
    if (leaveDeadline.current) clearTimeout(leaveDeadline.current);
    leaveDeadline.current = setTimeout(finishLeave, LEAVE_DEADLINE_MS);
  }, [finishLeave]);
  useEffect(() => () => { if (leaveDeadline.current) clearTimeout(leaveDeadline.current); }, []);

  // NEW: Computed helpers from status
  const contextValue = useMemo(() => ({
    ...state,
    setStatus,
    leaveOnNextUrl,
    isStopping: state.status === RecordingStatus.STOPPING,
    isProcessing: state.status === RecordingStatus.PROCESSING_TRANSCRIPTS,
    isSaving: state.status === RecordingStatus.SAVING,
  }), [state, setStatus, leaveOnNextUrl]);

  return (
    <RecordingStateContext.Provider value={contextValue}>
      {children}
      {/* Its own boundary: in the static prerender `useSearchParams` throws without one above it, and this provider sits
          under none (#328). */}
      <Suspense fallback={null}>
        <CommittedUrl onUrl={reportUrl} />
      </Suspense>
    </RecordingStateContext.Provider>
  );
}

/** Reports the committed pathname and `id`, after each commit that changes either. Renders nothing. */
function CommittedUrl({ onUrl }: { onUrl: (url: string) => void }) {
  const pathname = usePathname();
  const id = useSearchParams()?.get('id') ?? '';
  useEffect(() => {
    onUrl(`${pathname ?? ''}?id=${id}`);
  }, [pathname, id, onUrl]);
  return null;
}

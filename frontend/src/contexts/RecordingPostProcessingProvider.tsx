'use client';

import React, { useEffect, useRef } from 'react';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import {
  setStopHandler,
  syncsSettled,
  takeHistoryAnswered,
  type StopEmission,
} from '@/lib/recording-stop-trigger';

/**
 * RecordingPostProcessingProvider
 *
 * The one place a meeting is saved, whichever route stopped it: the window's Stop, the tray, a reload during the
 * stop (#328). The trigger is `recording-stopped`, heard by the module-scope listener in
 * `lib/recording-stop-trigger.ts`; this provider keeps the handler it calls current, so a re-render between two
 * emissions of one stop cannot drop or double it.
 *
 * A page that saw this recording's `recording-started` saves from its own buffer. A page that did not was reloaded
 * during the recording or the stop: it waits for its mount sync and any reload sync in flight, and saves only if a
 * reload sync answered a non-empty history. Otherwise it holds none of the meeting's rows, and the copy is left for
 * recovery, with a toast that says so.
 */
export function RecordingPostProcessingProvider({ children }: { children: React.ReactNode }) {
  // No-op functions since the global RecordingStateContext already handles state updates
  // These are only needed for the hook's local component state management
  const setIsRecording = () => { };
  const setIsRecordingDisabled = () => { };

  const { handleRecordingStop, resolveWithoutSave } = useRecordingStop(setIsRecording, setIsRecordingDisabled);

  const decide = async (emission: StopEmission) => {
    if (!emission.sawStart) {
      await syncsSettled();
      if (!takeHistoryAnswered()) {
        console.log('[RecordingPostProcessing] This page holds none of the meeting\'s rows; left for recovery', emission.n);
        resolveWithoutSave();
        return;
      }
    }
    const { folder_path, meeting_name } = emission.payload;
    if (folder_path) sessionStorage.setItem('last_recording_folder_path', folder_path);
    if (meeting_name) sessionStorage.setItem('last_recording_meeting_name', meeting_name);
    await handleRecordingStop(emission.n);
  };
  // Current on every render; the trigger calls through it.
  const latest = useRef({ decide, resolveWithoutSave });
  latest.current = { decide, resolveWithoutSave };

  useEffect(() => {
    setStopHandler(
      (emission) => { void latest.current.decide(emission); },
      // An emission before this provider's first commit follows a reload whose mount sync has not answered: none of
      // the meeting's rows are here.
      () => latest.current.resolveWithoutSave(),
    );
    return () => setStopHandler(null);
  }, []);

  return <>{children}</>;
}

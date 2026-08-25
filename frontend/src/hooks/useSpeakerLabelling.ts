import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';

interface DiarizationResult {
  meeting_id: string;
  labelled_count: number;
  unlabelled_count: number;
  speaker_count: number;
}

interface DiarizationError {
  meeting_id: string;
  error: string;
}

interface Options {
  meetingId?: string;
  meetingFolderPath?: string | null;
  onComplete?: () => void | Promise<void>;
}

/**
 * Runs the post-hoc speaker-labelling pass over one meeting.
 *
 * Both callers share this: the Speakers button and the automatic run when a
 * meeting is opened straight from a recording. They differ only in whether a
 * missing model is worth interrupting the user over, which is what
 * `downloadIfMissing` decides — an automatic run stays quiet, a click the user
 * made gets an answer.
 */
export function useSpeakerLabelling({ meetingId, meetingFolderPath, onComplete }: Options) {
  const [isLabelling, setIsLabelling] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!meetingId) return;

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    const setup = async () => {
      const done = await listen<DiarizationResult>('diarization-complete', async (event) => {
        if (event.payload.meeting_id !== meetingId) return;
        setIsLabelling(false);

        const { speaker_count, unlabelled_count } = event.payload;
        // "0 speakers" is a real outcome, not a failure: a recording with no
        // detected speech reaches here, and saying "complete" would be a lie.
        if (speaker_count === 0) {
          toast.info('No speakers were detected in this recording.');
        } else {
          const missed =
            unlabelled_count > 0 ? ` ${unlabelled_count} line(s) could not be attributed.` : '';
          toast.success(
            `Labelled ${speaker_count} speaker${speaker_count === 1 ? '' : 's'}.${missed}`
          );
        }
        await onCompleteRef.current?.();
      });
      if (cancelled) return done();
      unlisteners.push(done);

      const failed = await listen<DiarizationError>('diarization-error', (event) => {
        if (event.payload.meeting_id !== meetingId) return;
        setIsLabelling(false);
        toast.error(event.payload.error);
      });
      if (cancelled) {
        failed();
        unlisteners.forEach((u) => u());
        return;
      }
      unlisteners.push(failed);
    };

    setup();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [meetingId]);

  const labelSpeakers = useCallback(
    async ({ downloadIfMissing = false } = {}) => {
      if (!meetingId || !meetingFolderPath || isLabelling) return;

      try {
        const downloaded = await invoke<boolean>('is_diarizer_downloaded_command');
        if (!downloaded) {
          if (!downloadIfMissing) return;

          const sizeMb = await invoke<number>('diarizer_size_mb');
          setIsLabelling(true);
          toast.info(`Downloading the speaker model (${sizeMb} MB)…`);
          await invoke('download_diarizer_command');
        }

        setIsLabelling(true);
        await invoke('label_speakers_command', { meetingId, meetingFolderPath });
      } catch (error) {
        setIsLabelling(false);
        toast.error(String(error));
      }
    },
    [meetingId, meetingFolderPath, isLabelling]
  );

  return { labelSpeakers, isLabelling };
}

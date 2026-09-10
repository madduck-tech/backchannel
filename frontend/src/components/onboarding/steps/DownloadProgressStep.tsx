import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { toast } from 'sonner';
import { getSummaryModelSizeMb } from '@/lib/onboarding-summary-model';

import { transcribeModelSizeMb } from '@/lib/onboarding-transcribe-models';

type DownloadStatus = 'waiting' | 'downloading' | 'completed' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  /**
   * Did this run fetch anything for this row? A file already on disk and a file just downloaded
   * both end at `status: 'completed'`, and the screen used to render them identically — a full bar
   * over `0.0 MB / 705.3 MB`, which is what the product owner photographed. Set the moment a
   * progress event arrives, so it reports the wire rather than an intention.
   */
  fetched: boolean;
  error?: string;
}

export function DownloadProgressStep() {
  const {
    goNext,
    selectedSummaryModel,
    recommendedSummaryModel,
    parakeetDownloaded,
    setParakeetDownloaded,
    summaryModelDownloaded,
    setSummaryModelDownloaded,
    summaryProvider,
    selectedTranscribeModel,
    startBackgroundDownloads,
  } = useOnboarding();

  // The listeners below are subscribed once and must not close over the first render's choice.
  // `OnboardingContext` keeps the same ref for the same reason (`:112`); the screen has its own
  // because it has its own listeners -- a duplication #146 condition 3 asks to remove.
  const chosenRef = useRef(selectedTranscribeModel);
  useEffect(() => { chosenRef.current = selectedTranscribeModel; }, [selectedTranscribeModel]);

  const [isMac, setIsMac] = useState(false);

  const [parakeetState, setParakeetState] = useState<DownloadState>({
    status: parakeetDownloaded ? 'completed' : 'waiting',
    progress: parakeetDownloaded ? 100 : 0,
    downloadedMb: 0,
    totalMb: transcribeModelSizeMb(selectedTranscribeModel) ?? 0,
    speedMbps: 0,
    fetched: false,
  });

  const [summaryState, setSummaryState] = useState<DownloadState>({
    status: summaryModelDownloaded ? 'completed' : 'waiting',
    progress: summaryModelDownloaded ? 100 : 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
    fetched: false,
  });

  // The size shown beside the name. `null` for a model outside the recommended four -- there is no

  const parakeetDownloadStartedRef = useRef(false);
  const summaryDownloadStartedRef = useRef(false);
  const retryingRef = useRef(false);
  const retryingSummaryRef = useRef(false);

  // Retry download handler
  const handleRetryDownload = async () => {
    // Prevent multiple simultaneous retries
    if (retryingRef.current) {
      console.log('[DownloadProgressStep] Retry already in progress, ignoring');
      return;
    }

    console.log('[DownloadProgressStep] Retrying Parakeet download');
    retryingRef.current = true;

    // Reset error state
    setParakeetState((prev) => ({
      ...prev,
      status: 'waiting',
      error: undefined,
      progress: 0,
      downloadedMb: 0,
      speedMbps: 0,
    }));

    try {
      await invoke('transcribe_download_model', { modelName: chosenRef.current });
      // Progress events will update state
    } catch (error) {
      console.error('[DownloadProgressStep] Retry failed:', error);
      setParakeetState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Retry failed',
      }));

      toast.error('Download retry failed', {
        description: 'Please check your connection and try again.',
      });
    } finally {
      // Allow retry again after 2 seconds
      setTimeout(() => {
        retryingRef.current = false;
      }, 2000);
    }
  };

  // Retry summary download handler
  const handleRetrySummaryDownload = async () => {
    // Prevent multiple simultaneous retries
    if (retryingSummaryRef.current) {
      console.log('[DownloadProgressStep] Summary retry already in progress, ignoring');
      return;
    }

    console.log('[DownloadProgressStep] Retrying summary model download');
    retryingSummaryRef.current = true;

    // Reset error state
    setSummaryState((prev) => ({
      ...prev,
      status: 'downloading',
      error: undefined,
      progress: 0,
      downloadedMb: 0,
      totalMb: getSummaryModelSizeMb(selectedSummaryModel || recommendedSummaryModel),
      speedMbps: 0,
      fetched: false,
    }));

    try {
      // Call download command directly (no retry command exists for built-in AI)
      const modelName = selectedSummaryModel;
      if (!modelName) {
        throw new Error('Summary model recommendation is not ready yet');
      }
      await invoke('builtin_ai_download_model', { modelName });
    } catch (error) {
      console.error('[DownloadProgressStep] Summary retry failed:', error);
      setSummaryState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Retry failed',
      }));

      toast.error('Summary model download retry failed', {
        description: 'Please check your connection and try again.',
      });
    } finally {
      // Allow retry again after 2 seconds
      setTimeout(() => {
        retryingSummaryRef.current = false;
      }, 2000);
    }
  };

  // Detect platform on mount
  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };

    checkPlatform();
  }, []);

  // Start the required transcription model immediately; summary readiness must not block it.
  useEffect(() => {
    if (parakeetDownloadStartedRef.current) return;
    parakeetDownloadStartedRef.current = true;

    if (!parakeetDownloaded) {
      setParakeetState((prev) => ({ ...prev, status: 'downloading' }));
    }

    startBackgroundDownloads({
      includeParakeet: true,
      includeSummary: false,
    }).catch((error) => {
      console.error('Failed to start Parakeet download:', error);
      if (!parakeetDownloaded) {
        setParakeetState((prev) => ({ ...prev, status: 'error', error: String(error) }));
      }
    });
  }, []);

  // Start the selected summary model only after the backend recommendation is known.
  useEffect(() => {
    if (summaryDownloadStartedRef.current) return;
    if (!selectedSummaryModel) return;
    summaryDownloadStartedRef.current = true;

    startSummaryDownload();
  }, [selectedSummaryModel]);

  // Listen to Parakeet download progress
  useEffect(() => {
    const unlistenProgress = listen<{
      modelName: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status?: string;
    }>('model-download-progress', (event) => {
      const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
      if (modelName === chosenRef.current) {
        setParakeetState((prev) => ({
          ...prev,
          status: status === 'completed' ? 'completed' : 'downloading',
          progress,
          fetched: true,
          downloadedMb: downloaded_mb ?? prev.downloadedMb,
          totalMb: total_mb ?? prev.totalMb,
          speedMbps: speed_mbps ?? prev.speedMbps,
        }));

        if (status === 'completed' || progress >= 100) {
          setParakeetDownloaded(true);
        }
      }
    });

    const unlistenComplete = listen<{ modelName: string }>(
      'model-download-complete',
      (event) => {
        if (event.payload.modelName === chosenRef.current) {
          // `fetched` because this event follows a real download: `download_inner` fetches
          // unconditionally, so reaching here means bytes crossed the wire. Without it a
          // download whose progress events were missed ends on "already here from an earlier
          // install" -- a lie about something the person just watched happen.
          setParakeetState((prev) => ({ ...prev, status: 'completed', progress: 100, fetched: true }));
          setParakeetDownloaded(true);
        }
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'model-download-error',
      (event) => {
        if (event.payload.modelName === chosenRef.current) {
          setParakeetState((prev) => ({
            ...prev,
            status: 'error',
            error: event.payload.error,
          }));
        }
      }
    );

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, []);

  // Listen to Summary Model download progress (always downloading for builtin-ai)
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status: string;
      error?: string;
    }>('builtin-ai-download-progress', (event) => {
      const { model, progress, downloaded_mb, total_mb, speed_mbps, status, error } = event.payload;
      if (selectedSummaryModel && model === selectedSummaryModel) {
        setSummaryState((prev) => ({
          ...prev,
          status: status === 'completed'
            ? 'completed'
            : status === 'error'
            ? 'error'
            : 'downloading',
          progress,
          fetched: true,
          downloadedMb: downloaded_mb ?? prev.downloadedMb,
          totalMb: (total_mb ?? prev.totalMb) || getSummaryModelSizeMb(model),
          speedMbps: speed_mbps ?? prev.speedMbps,
          error: status === 'error' ? error : undefined,
        }));

        if (status === 'completed' || progress >= 100) {
          setSummaryModelDownloaded(true);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [selectedSummaryModel]);

  useEffect(() => {
    const modelForSize = selectedSummaryModel || recommendedSummaryModel;
    if (!modelForSize) return;

    setSummaryState((prev) => ({
      ...prev,
      status: summaryModelDownloaded
        ? 'completed'
        : prev.status === 'completed'
        ? 'waiting'
        : prev.status,
      progress: summaryModelDownloaded
        ? 100
        : prev.status === 'completed'
        ? 0
        : prev.progress,
      totalMb: prev.totalMb || getSummaryModelSizeMb(modelForSize),
    }));
  }, [selectedSummaryModel, recommendedSummaryModel, summaryModelDownloaded]);

  const startSummaryDownload = async () => {
    if (!summaryModelDownloaded && selectedSummaryModel) {
      try {
        setSummaryState((prev) => ({
          ...prev,
          status: 'downloading',
          totalMb: getSummaryModelSizeMb(selectedSummaryModel),
        }));
        await startBackgroundDownloads({
          includeParakeet: false,
          includeSummary: true,
          summaryModel: selectedSummaryModel,
        });
      } catch (error) {
        console.error('Failed to start summary model download:', error);
        setSummaryState((prev) => ({ ...prev, status: 'error', error: String(error) }));
      }
    }
  };

  /**
   * Ask the backend whether the transcription model is really on disk, and repair the flag if it
   * disagrees.
   *
   * This used to live only inside `handleContinue`, which is reached only through a button
   * `disabled={!parakeetDownloaded}` -- the very flag the repair exists to correct. A user whose
   * model was present while the flag said otherwise (a reinstall over an existing model directory,
   * a completed download whose state write failed, an interrupted first run) met a permanent
   * spinner on the first screen of the application, and the code written to rescue them ran only
   * after they pressed the button they could not press. #92.
   *
   * It runs on mount now, gated by nothing. Continue still calls it too, so drift the other way --
   * flag true, model gone -- is caught as before.
   */
  const verifyModelPresence = React.useCallback(async () => {
    await invoke('transcribe_init');
    const actuallyAvailable = await invoke<boolean>('transcribe_has_available_models');
    if (actuallyAvailable && !parakeetDownloaded) {
      setParakeetDownloaded(true);
      setParakeetState((prev) => ({ ...prev, status: 'completed', progress: 100 }));
    }
    return actuallyAvailable;
  }, [parakeetDownloaded, setParakeetDownloaded]);

  // On mount, before the user reaches for anything.
  useEffect(() => {
    void verifyModelPresence().catch((error) => {
      console.error('[DownloadProgressStep] Could not verify model presence:', error);
    });
    // Once. Re-running on every change of the flag it sets would loop.
  }, []);

  // **This overrides #111 cycle B, deliberately, and the reason is written here rather than lost.**
  //
  // That cycle made Continue wait for the summary model too, so nobody walked into an application
  // whose summariser had not arrived. The concern is real. What it produced on screen was a
  // contradiction the product owner photographed on 2026-09-09: "You can continue while this
  // finishes" over a button disabled with "Waiting for the summary model", and the toast that
  // explains the first sentence -- "You can start using the app. Recording will be available once
  // speech recognition is ready" -- sitting in a branch the disabled button could never reach.
  //
  // Three sites, two answers. The approved prototype settles it: `finished = () => T.done >= T.mb`
  // over the **transcription** file, and a footer reading "Continue is available when it has
  // arrived". Recording needs speech recognition; the summariser is wanted when a meeting ends, and
  // its download continues in the background, which is what the toast already promised. After #155 a
  // remote summariser fetches nothing at all, so this only ever concerned `builtin-ai`.

  const handleContinue = async () => {
    // Verify actual model availability (catches state drift)
    try {
      await invoke('transcribe_init');
      const actuallyAvailable = await invoke<boolean>('transcribe_has_available_models');

      if (actuallyAvailable && !parakeetDownloaded) {
        console.log('[DownloadProgressStep] Model available but state not updated');
        setParakeetDownloaded(true);
        setParakeetState((prev) => ({
          ...prev,
          status: 'completed',
          progress: 100,
        }));
      } else if (!actuallyAvailable && parakeetState.status === 'error') {
        toast.error('Transcription engine required', {
          description: 'Please retry the download before continuing.',
        });
        return;
      }
    } catch (error) {
      console.warn('[DownloadProgressStep] Failed to verify model:', error);
    }

    // Check if downloads are complete for toast notification
    const downloadsComplete = parakeetState.status === 'completed' &&
      summaryState.status === 'completed';

    // Show toast if downloads still in progress
    if (!downloadsComplete) {
      toast.info('Downloads will continue in the background', {
        description: 'You can start using the app. Recording will be available once speech recognition is ready.',
        duration: 5000,
      });
    }

    // Every platform goes to the audio check next: it is step 4 of the four the strip names, and
    // until now only macOS reached it. Off macOS this screen called `completeOnboarding()` and
    // reloaded, so the microphone-and-speaker check the strip promises was rendered by
    // `OnboardingFlow.tsx:64` and reached by nobody. The product owner asked where it was.
    goNext();
  };

  /**
   * One row per file, which is what `a-two-rows` is. (#154)
   *
   * `design/prototypes/onboarding-download.html`, approved 2026-09-08. What it decides, read out of
   * it rather than remembered:
   *
   *   - a row is a name, a state, a line saying why the file is wanted, and either a bar or a
   *     sentence -- never both;
   *   - a file already here reads `on this device · N MB` and gets
   *     "Already here from an earlier install. Nothing to fetch." in place of the bar;
   *   - one being fetched reads `N of M MB`;
   *   - the footer says how much is left and that Continue waits for it.
   */
  const row = (
    name: string,
    why: string,
    state: DownloadState,
    unit: string,
    key: string
  ) => {
    const alreadyHere = state.status === 'completed' && !state.fetched;
    const arrived = state.status === 'completed';
    return (
      <section
        key={key}
        aria-label={name}
        className="border-b border-line py-4 last:border-b-0"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-mono text-sm text-ink">{name}</span>
          <span className="text-sm text-ink-faint">
            {arrived ? (
              <>
                <b className="font-medium text-ink">on this device</b> ·{' '}
                {state.totalMb.toFixed(0)} {unit}
              </>
            ) : state.status === 'error' ? (
              <span className="text-danger-ink">Failed</span>
            ) : (
              `${state.downloadedMb.toFixed(0)} of ${state.totalMb.toFixed(0)} ${unit}`
            )}
          </span>
        </div>
        <p className="mt-1 text-sm leading-[19px] text-ink-faint">{why}</p>

        {alreadyHere ? (
          <p className="mt-2.5 flex items-center gap-2 text-sm text-ink">
            <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden />
            Already here from an earlier install. Nothing to fetch.
          </p>
        ) : (
          <div
            role="progressbar"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={Math.round(state.totalMb)}
            aria-valuenow={Math.round(state.downloadedMb)}
            className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-ink/10"
          >
            <div
              className="h-full rounded-full bg-brand transition-all duration-300"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        )}

        {state.status === 'error' && state.error && (
          <div className="mt-2.5 rounded-md border border-danger/40 bg-danger-soft p-3">
            <p className="text-xs text-danger-ink">{state.error}</p>
            <button
              onClick={key === 'transcription' ? handleRetryDownload : handleRetrySummaryDownload}
              className="mt-2 h-8 rounded-md bg-ink px-3 text-sm font-medium text-canvas"
            >
              Try again
            </button>
          </div>
        )}
      </section>
    );
  };

  // A remote summariser fetches nothing, so it gets no row. Until #155 the screen showed one and the
  // application downloaded 2.7 GB behind it for a person who had chosen Claude.
  const summaryIsFetched = summaryProvider === 'builtin-ai';
  const rows = [
    row(
      selectedTranscribeModel,
      'Turns speech into text on this device. Chosen on the previous step.',
      parakeetState,
      'MB',
      'transcription'
    ),
    summaryIsFetched
      ? row(
          selectedSummaryModel || recommendedSummaryModel,
          'Writes the summary when a meeting ends, on this device.',
          summaryState,
          'MiB',
          'summary'
        )
      : null,
  ].filter(Boolean);

  /**
   * Continue waits for the **transcription** model, and only for it.
   *
   * The prototype's gate is `finished = () => T.done >= T.mb` over the transcription file, and its
   * readout says "Continue is available when it has arrived". Recording needs speech recognition;
   * the summariser is wanted when a meeting ends. Before this the screen said "You can continue
   * while this finishes" over a button disabled with "Waiting for the summary model", and the toast
   * that explains the first sentence sat in a branch the disabled button could never reach. #155
   */
  const transcriptionLeftMb = Math.max(0, parakeetState.totalMb - parakeetState.downloadedMb);
  // Either the context says the model is on disk, or this run fetched it. **Not** the row's status
  // alone: `verifyModelPresence` sets that to `completed` the moment the backend reports a model,
  // and the repair it performs is `setParakeetDownloaded(true)` -- so the context is what carries the
  // answer, and reading past it would let a person through on a status nothing had confirmed.
  const finished = parakeetDownloaded || (parakeetState.status === 'completed' && parakeetState.fetched);

  return (
    <OnboardingContainer
      title={rows.length > 1 ? 'Getting the two files you chose' : 'Getting the file you chose'}
      description={
        finished
          ? 'Everything you chose is on this device.'
          : 'Continue when the transcription model is on this device.'
      }
      step={3}
      totalSteps={isMac ? 4 : 3}
      footer={
        <>
          <span className="min-w-0 flex-1 text-xs leading-[17px] text-ink-faint">
            {finished ? (
              'Everything you chose is on this device.'
            ) : (
              <>
                <b className="font-medium text-ink">{transcriptionLeftMb.toFixed(0)} MB</b> left to
                fetch. Continue is available when the transcription model has arrived.
              </>
            )}
          </span>
          {/* The visible word stays "Continue" and the footer's readout carries the reason, which is
              what `a-two-rows` does. The accessible name says what it is waiting *for*: a disabled
              control that reads only "Continue" tells a screen reader nothing about why, and this is
              the state the button is in for most of the first run. #92. */}
          <Button
            onClick={handleContinue}
            disabled={!finished}
            aria-label={finished ? 'Continue' : 'Waiting for the transcription model…'}
            className="h-8 shrink-0 px-4"
          >
            Continue
          </Button>
        </>
      }
    >
      <div className="mt-5">{rows}</div>
    </OnboardingContainer>
  );
}

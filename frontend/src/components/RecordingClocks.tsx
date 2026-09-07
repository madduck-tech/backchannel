'use client';

import { useRecordingState } from '@/contexts/RecordingStateContext';
import { formatElapsed } from './LiveIndicator';
import { cn } from '@/lib/utils';

/**
 * The two clocks a recording actually has, and the gap between them.
 *
 * `elapsed` is the wall clock — it runs through a pause. `recorded` excludes
 * pauses, and it is not a nicety: `recording_manager.rs:329` hands that number
 * to `recording_saver.stop_and_save`, so it is the length the saved file is
 * written with. Until #114 the only thing in the application that rendered it
 * was `RecordingStatusBar`, a sticky banner above the transcript that repeated
 * the live state a third time. Deleting the banner without moving this number
 * would have lost it, and the control guarding that deletion would have passed,
 * because the *state* was still on screen.
 *
 * `paused` appears only once a pause has happened. Before that the two clocks
 * agree and a third figure reading `00:00` is noise.
 *
 * Each carries its own label. Two bare timers a few pixels apart, differing by
 * seconds, read as one number rendered twice.
 */
export function RecordingClocks({ className }: { className?: string }) {
    const { isRecording, isPaused, recordingDuration, activeDuration } = useRecordingState();

    if (!isRecording) return null;

    const elapsed = Math.max(0, Math.floor(recordingDuration ?? 0));
    const recorded = Math.max(0, Math.floor(activeDuration ?? 0));
    const paused = Math.max(0, elapsed - recorded);

    // One second of drift is the two clocks being sampled a moment apart, not a
    // pause. The figure appears when there is something to explain.
    const showPaused = isPaused || paused > 1;

    return (
        <span className={cn('flex items-baseline gap-3', className)}>
            <Clock label="recorded" value={recorded} />
            <Clock label="elapsed" value={elapsed} />
            {showPaused && <Clock label="paused" value={paused} />}
        </span>
    );
}

function Clock({ label, value }: { label: string; value: number }) {
    return (
        <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs text-ink-faint">
            <span>{label}</span>
            <b className="readout font-normal tabular-nums text-ink">{formatElapsed(value)}</b>
        </span>
    );
}

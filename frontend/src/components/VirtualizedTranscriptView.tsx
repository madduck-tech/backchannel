'use client';

import { useRef, useReducer, startTransition, useEffect, useMemo, useState, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { useRecordingState } from "@/contexts/RecordingStateContext";
import { TranscriptSegmentData } from "@/types";
import { speakerLabel, SpeakerNames } from "@/lib/speaker";
import {
    channelCoverage,
    groupIntoTurns,
    TranscriptTurn,
} from "@/lib/transcript-turns";
import { Loader2, Mic } from "lucide-react";
import { cn } from "@/lib/utils";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Uncommitted live text from a streaming model; shown dimmed below the segments */
    partialText?: string;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;
    speakerNames?: SpeakerNames;
    onRenameSpeaker?: (speaker: string, name: string) => void;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '--:--';

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');

    // Brackets were doing the work of "this is a timestamp"; the mono gutter
    // does that now. Meetings run past an hour, so carry hours when needed.
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

// A filler-word stripper used to run here, deleting uh/um/er/ah/hmm/hm/eh/oh
// from every line before rendering. It was wrong in two ways at once: the words
// are real words in the languages this app transcribes ("er" = he, "oh", "eh",
// "um" are ordinary German), and it rewrote only the *displayed* text, so the
// transcript on screen silently disagreed with the one that got saved,
// exported and summarised. A transcript that edits what was said is not a
// transcript. Render what the model heard.

function SpeakerTag({
    speaker,
    speakerNames,
    onRename,
}: {
    speaker: string;
    speakerNames?: SpeakerNames;
    onRename?: (speaker: string, name: string) => void;
}) {
    const label = speakerLabel(speaker, speakerNames);
    const [editing, setEditing] = useState(false);

    if (!onRename) {
        return <span className="font-medium text-ink-muted">{label}: </span>;
    }

    const withColon = (node: React.ReactNode) => <>{node}: </>;

    if (editing) {
        return (
            <input
                autoFocus
                defaultValue={speakerNames?.[speaker] ?? ''}
                placeholder={label}
                aria-label={`Rename ${label}`}
                className="mr-1 w-32 rounded border border-line bg-canvas px-1 text-md font-medium text-ink"
                onBlur={(e) => {
                    onRename(speaker, e.currentTarget.value);
                    setEditing(false);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setEditing(false);
                }}
            />
        );
    }

    return withColon(
        <button
            type="button"
            onClick={() => setEditing(true)}
            title="Rename this speaker for the whole meeting"
            className="font-medium text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
        >
            {label}
        </button>
    );
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    showConfidence,
    speaker,
    speakerNames,
    onRenameSpeaker,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    showConfidence: boolean;
    speaker?: string;
    speakerNames?: SpeakerNames;
    onRenameSpeaker?: (speaker: string, name: string) => void;
}) {
    const isSilence = text.trim() === '';
    const displayText = isSilence ? 'Silence' : text;

    return (
        <div id={`segment-${id}`} className="group flex items-baseline gap-3 py-1.5">
            {/* Timestamp gutter — a machine fact, so it is set in mono. */}
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="readout w-[3.25rem] shrink-0 select-none text-2xs text-ink-faint transition-colors duration-fast group-hover:text-ink-muted">
                        {formatRecordingTime(timestamp)}
                    </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                    {confidence !== undefined && showConfidence ? (
                        <span className="flex items-center gap-1.5">
                            Decode confidence
                            <ConfidenceIndicator confidence={confidence} always />
                        </span>
                    ) : (
                        'Position in recording'
                    )}
                </TooltipContent>
            </Tooltip>

            <p
                className={cn(
                    'min-w-0 flex-1 text-md leading-relaxed',
                    isSilence ? 'italic text-ink-faint' : 'text-ink'
                )}
            >
                {speaker && (
                    <SpeakerTag
                        speaker={speaker}
                        speakerNames={speakerNames}
                        onRename={onRenameSpeaker}
                    />
                )}
                {displayText}
                {confidence !== undefined && showConfidence && (
                    <>
                        {' '}
                        <ConfidenceIndicator confidence={confidence} showIndicator />
                    </>
                )}
            </p>
        </div>
    );
});

/**
 * One segment inside a turn's bubble. Same content as a single-column row minus
 * the timestamp gutter: a turn is many rows and carries one time, so repeating it
 * per line would be the noise the grouping exists to remove.
 */
const TranscriptLine = memo(function TranscriptLine({
    id,
    text,
    confidence,
    showConfidence,
    speaker,
    speakerNames,
    onRenameSpeaker,
}: {
    id: string;
    text: string;
    confidence?: number;
    showConfidence: boolean;
    speaker?: string;
    speakerNames?: SpeakerNames;
    onRenameSpeaker?: (speaker: string, name: string) => void;
}) {
    const isSilence = text.trim() === '';

    return (
        <p
            id={`segment-${id}`}
            className={cn('min-w-0 text-md leading-relaxed', isSilence && 'italic opacity-70')}
        >
            {speaker && (
                <SpeakerTag speaker={speaker} speakerNames={speakerNames} onRename={onRenameSpeaker} />
            )}
            {isSilence ? 'Silence' : text}
            {confidence !== undefined && showConfidence && (
                <>
                    {' '}
                    <ConfidenceIndicator confidence={confidence} showIndicator />
                </>
            )}
        </p>
    );
});

// The side is the label — nothing on screen spells it out, which is the whole point
// of rendering a conversation this way. Position is not available to a screen reader,
// so the side becomes the bubble's accessible name. Same reasoning LiveIndicator
// carries as "never colour alone".
const SIDE_LABEL = { you: 'You', others: 'Others' } as const;

/** A turn: one side's consecutive lines, as a bubble on that side. */
const ConversationTurn = memo(function ConversationTurn({
    turn,
    showConfidence,
    speakerNames,
    onRenameSpeaker,
}: {
    turn: TranscriptTurn;
    showConfidence: boolean;
    speakerNames?: SpeakerNames;
    onRenameSpeaker?: (speaker: string, name: string) => void;
}) {
    const isYou = turn.side === 'you';

    return (
        <article
            aria-label={SIDE_LABEL[turn.side ?? 'others']}
            className={cn(
                'flex max-w-[78%] flex-col gap-1 pb-3.5',
                isYou ? 'ml-auto items-end' : 'mr-auto items-start'
            )}
        >
            <div
                className={cn(
                    // The bubble sits on --sunken, not on the design system's --surface.
                    // --surface maps to the app's --elevated, and in the light theme
                    // --elevated and --bg are both oklch(1 0 0): the other side's bubble
                    // would be white on white. Measured lightness distance from the
                    // canvas: elevated 0.000 light / 0.070 dark, sunken 0.032 / 0.030.
                    'min-w-0 rounded-lg px-3 py-2 [&>p+p]:mt-2',
                    isYou
                        ? 'rounded-br-sm bg-brand-soft text-brand-soft-ink'
                        : 'rounded-bl-sm bg-sunken text-ink'
                )}
            >
                {turn.segments.map((segment) => (
                    <TranscriptLine
                        key={segment.id}
                        id={segment.id}
                        text={segment.text}
                        confidence={segment.confidence}
                        showConfidence={showConfidence}
                        speaker={segment.speaker}
                        speakerNames={speakerNames}
                        onRenameSpeaker={onRenameSpeaker}
                    />
                ))}
            </div>

            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="readout select-none px-0.5 text-2xs text-ink-faint">
                        {formatRecordingTime(turn.timestamp)}
                    </span>
                </TooltipTrigger>
                <TooltipContent side={isYou ? 'right' : 'left'}>
                    {turn.segments.length > 1
                        ? `${turn.segments.length} segments from here`
                        : 'Position in recording'}
                </TooltipContent>
            </Tooltip>
        </article>
    );
});

/**
 * Why this transcript has no sides.
 *
 * Two of the three states render as one column, and they are not the same state:
 * one recording never carried a channel, the other carried exactly one. Saying so
 * is the difference between a transcript and a dialogue with a silent participant.
 */
function ChannelNotice({ coverage }: { coverage: 'one-side' | 'none' }) {
    return (
        <div
            role="status"
            className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-xs leading-relaxed text-warn-ink"
        >
            {coverage === 'none'
                ? 'This recording has no channel data, so lines cannot be placed by side. They are shown in order, in one column.'
                : 'Every line in this recording came from one capture channel, so there is no second side to show. They are shown in order, in one column.'}
        </div>
    );
}

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    partialText = '',
    showConfidence = true,
    disableAutoScroll = false,
    speakerNames,
    onRenameSpeaker,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
}) => {
    // Has the microphone actually delivered a frame yet? Until it has, this
    // pane must not claim to be listening.
    const { captureArmed } = useRecordingState();

    // What the recording's channel column can support, and the turns that follow
    // from it. Grouping is the unit of everything below — the virtualiser counts
    // turns, not rows — so a two-sided meeting of 137 rows measures as 33 turns
    // while a channel-less one stays 137. `groupIntoTurns` says why.
    const coverage = useMemo(() => channelCoverage(segments), [segments]);
    const turns = useMemo(() => groupIntoTurns(segments), [segments]);
    const twoSided = coverage === 'both';

    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        // `virtualizer.measureElement` is attached as a ref (below), so react-virtual's
        // internal re-render notify fires during React's commit phase. Its default
        // path wraps that in flushSync, which React rejects with "flushSync was
        // called from inside a lifecycle method". Same for `_willUpdate` notifying
        // while `isScrolling`. Batched re-render is fine here — heights settle on
        // the next paint.
        useFlushSync: false,
        count: turns.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        // Turns, not rows: this is what the virtualiser indexes, and the hook uses
        // the array only for its length and for an id lookup against that index.
        segments: turns,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
        liveText: partialText,
    });

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = turns.length >= VIRTUALIZATION_THRESHOLD;

    // One call site for both rendering paths, so a turn cannot render one way above
    // the virtualisation threshold and another below it.
    const renderTurn = (turn: TranscriptTurn) =>
        twoSided ? (
            <ConversationTurn
                turn={turn}
                showConfidence={showConfidence}
                speakerNames={speakerNames}
                onRenameSpeaker={onRenameSpeaker}
            />
        ) : (
            // One column. `groupIntoTurns` gives one turn per row here, so this is
            // the row the app has always rendered.
            <TranscriptSegment
                id={turn.segments[0].id}
                timestamp={turn.timestamp}
                text={turn.segments[0].text}
                confidence={turn.segments[0].confidence}
                showConfidence={showConfidence}
                speaker={turn.segments[0].speaker}
                speakerNames={speakerNames}
                onRenameSpeaker={onRenameSpeaker}
            />
        );

    // What sits below the last committed segment while recording: the streaming
    // decoder's uncommitted tail if it has one, otherwise the Listening pulse.
    // Outside the virtualizer — this text is rewritten several times a second
    // and re-measuring a virtual row on every keystroke-sized change thrashes.
    const liveTail =
        !isStopping && isRecording && !isPaused && !isProcessing ? (
            partialText ? (
                <div className={cn('mt-2 flex items-baseline gap-3 py-1.5 animate-fade-in', !twoSided && 'pl-[4.25rem]')}>
                    <p className="min-w-0 flex-1 text-md leading-relaxed text-ink-muted">
                        {partialText}
                    </p>
                </div>
            ) : segments.length > 0 ? (
                <div className={cn('mt-4 flex items-center gap-2 animate-fade-in', !twoSided && 'pl-[4.25rem]')}>
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger animate-live" />
                    <span className="text-sm text-ink-muted">Listening</span>
                </div>
            ) : null
        ) : null;

    return (
        <div ref={scrollRef} className="scrollbar-slim flex h-full flex-col overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            {isRecording && (
                <div className="sticky top-0 z-sticky bg-canvas pb-2">
                    <RecordingStatusBar isPaused={isPaused} />
                </div>
            )}

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {/* Two of the three states render as one column and must say which. */}
            {segments.length > 0 && !twoSided && <ChannelNotice coverage={coverage} />}
            {/* A partial with no committed segments yet is still text on screen —
                showing "Listening" underneath it would contradict itself. */}
            {segments.length === 0 && !partialText ? (
                // Empty states teach the next action rather than saying "nothing here".
                <div className="flex min-h-[55vh] flex-col items-center justify-center px-6 text-center animate-fade-in">
                    {isRecording ? (
                        <>
                            {/* Static until the microphone has actually handed
                                over a frame. The pulse means "live", and a
                                pulsing dot above the words "Waiting for audio"
                                would contradict them. */}
                            <span
                                aria-hidden
                                className={cn(
                                    'mb-3 h-2.5 w-2.5 rounded-full',
                                    isPaused
                                        ? 'bg-warn'
                                        : captureArmed
                                          ? 'bg-danger animate-live'
                                          : 'bg-ink-faint'
                                )}
                            />
                            <p className="text-md font-medium text-ink">
                                {isPaused
                                    ? 'Recording paused'
                                    : captureArmed
                                      ? 'Listening'
                                      : 'Waiting for audio'}
                            </p>
                            <p className="mt-1 max-w-[34ch] text-base leading-relaxed text-ink-muted">
                                {isPaused
                                    ? 'Resume from the transport below to keep capturing.'
                                    : captureArmed
                                      ? 'Speech appears here a few seconds after it is spoken.'
                                      : 'The microphone is open but has not sent any audio yet. Bluetooth headsets can take a second or two.'}
                            </p>
                        </>
                    ) : (
                        <>
                            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-sunken text-ink-faint">
                                <Mic className="h-4.5 w-4.5" aria-hidden />
                            </span>
                            <p className="text-md font-medium text-ink">No transcript yet</p>
                            <p className="mt-1 max-w-[38ch] text-base leading-relaxed text-ink-muted">
                                Start a recording and speech is transcribed here live — on this
                                machine, with no audio leaving it.
                            </p>
                        </>
                    )}
                </div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const turn = turns[virtualRow.index];

                            return (
                                <div
                                    key={turn.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    {renderTurn(turn)}
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="mt-2 flex items-center justify-center py-4">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-ink-muted">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                    <span className="text-sm">Loading more…</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="readout text-2xs text-ink-faint">
                                    {loadedCount} / {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {liveTail}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div>
                        {turns.map((turn) => (
                            // CSS keyframe rather than framer-motion: the reveal must
                            // survive a headless render and a hidden tab.
                            <div key={turn.id} className="animate-segment-in">
                                {renderTurn(turn)}
                            </div>
                        ))}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="mt-2 flex items-center justify-center py-4">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-ink-muted">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                    <span className="text-sm">Loading more…</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="readout text-2xs text-ink-faint">
                                    {loadedCount} / {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {liveTail}
                </>
            )}
            </div>
        </div>
    );
};

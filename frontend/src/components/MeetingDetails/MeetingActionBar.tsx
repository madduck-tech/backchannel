'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Copy, FolderOpen, Loader2, MoreHorizontal, RefreshCw, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RetranscribeDialog } from './RetranscribeDialog';
import { useSpeakerLabelling } from '@/hooks/useSpeakerLabelling';
import { formatElapsed } from '@/components/LiveIndicator';

/**
 * The saved meeting's own control bar.
 *
 * It replaces a four-button row that sat in the transcript pane's header and shared
 * nothing but a row: Copy and Retranscribe act on the transcript, Speakers ran a pass
 * over the recording, and one titled "Open Recording Folder" opened a file manager --
 * the fourth appearance of a word that already meant the live capture state elsewhere.
 *
 * The labels used to hide at `lg`, a **viewport** query at 1024px, while the buttons
 * lived in a pane whose width is unrelated. At the 1100px default the labels showed and
 * the row overflowed its container. The rule here is a **container** query on the bar's
 * own box, so it responds to the space it is actually in.
 *
 * The recording screen has the matching bar (`RecordingControls`); this route never
 * records -- `page-content.tsx` holds `isRecording` as a constant `false` -- so the two
 * are separate components sharing one visual language, not one component in two modes.
 */
export function MeetingActionBar({
    recordedSeconds,
    transcriptCount,
    onCopyTranscript,
    onOpenMeetingFolder,
    meetingId,
    meetingFolderPath,
    onRefetchTranscripts,
}: {
    /** Length of the saved recording, or undefined when it is not known. */
    recordedSeconds?: number | null;
    transcriptCount: number;
    onCopyTranscript: () => void;
    onOpenMeetingFolder: () => Promise<void>;
    meetingId?: string;
    meetingFolderPath?: string | null;
    onRefetchTranscripts?: () => Promise<void>;
}) {
    const [showRetranscribe, setShowRetranscribe] = useState(false);

    const handleComplete = useCallback(async () => {
        if (onRefetchTranscripts) await onRefetchTranscripts();
    }, [onRefetchTranscripts]);

    // Separate from Retranscribe on purpose: labelling never rewrites the text, so
    // folding it into that dialog would mean you cannot get speakers without also
    // re-running the transcript.
    const { labelSpeakers, isLabelling } = useSpeakerLabelling({
        meetingId,
        meetingFolderPath,
        onComplete: handleComplete,
    });

    const empty = transcriptCount === 0;
    const canRetranscribe = Boolean(meetingId && meetingFolderPath);

    // A menu left open when the bar turns wide would sit against a trigger that is now `display:
    // none`, listing actions the bar already shows; Radix closes it on window blur only. So the
    // menu closes when its trigger's box goes to 0 × 0, which is exactly what the container query
    // does at the breakpoint. The trigger is watched rather than the wrapper's width so the number
    // lives in one place, the class (#165).
    const [menuOpen, setMenuOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const el = trigger.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === 0 && entry.contentRect.height === 0) setMenuOpen(false);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return (
        <>
            {/* Two boxes on purpose (#165). The container is the wrapper, which spans the room
                the bar has; the bar inside it stays content-sized. On one box, inline-size
                containment sized it as if empty and `w-fit` resolved to that: 26 × 115 at every
                width, the bar's own padding and border with nothing between them. */}
            <div className="@container/bar w-full">
            <div
                role="toolbar"
                aria-label="Meeting actions"
                className="pointer-events-auto mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center justify-center gap-x-3.5 gap-y-2 rounded-lg border border-line bg-sunken px-3 py-2 shadow-float"
            >
                {recordedSeconds != null && (
                    <span className="flex items-baseline gap-1.5 whitespace-nowrap text-xs text-ink-faint">
                        <span>recorded</span>
                        <b className="readout font-normal tabular-nums text-ink">
                            {formatElapsed(recordedSeconds)}
                        </b>
                    </span>
                )}

                <Button size="sm" variant="ghost" onClick={onCopyTranscript} disabled={empty}>
                    <Copy className="mr-2 h-4 w-4" aria-hidden />
                    Copy
                </Button>

                {/* Wide: on the bar, where they fit on one row with the longest recorded time
                    (`99:59:59`). Narrow: in the menu, keeping their words; an icon a user cannot
                    name is a control they will not press. The number is the product owner's rule of
                    2026-10-24 measured, and `the-action-bar-is-one-row.test.mjs` derives it again. */}
                <span className="hidden @[665px]/bar:contents">
                    {canRetranscribe && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowRetranscribe(true)}
                            disabled={empty}
                        >
                            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
                            Retranscribe
                        </Button>
                    )}
                    {canRetranscribe && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => labelSpeakers({ downloadIfMissing: true })}
                            disabled={isLabelling || empty}
                        >
                            {isLabelling ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                            ) : (
                                <Users className="mr-2 h-4 w-4" aria-hidden />
                            )}
                            Speakers
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={onOpenMeetingFolder}>
                        <FolderOpen className="mr-2 h-4 w-4" aria-hidden />
                        Open folder
                    </Button>
                </span>

                {/* Narrow only: a wide bar has no menu (prototype 114, and the product owner's
                    decision of 2026-10-24). The menu's content is portalled, outside the container,
                    so nothing inside it could ever answer a container query; with no menu at wide it
                    does not need to. */}
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownMenuTrigger asChild ref={trigger}>
                        <Button size="sm" variant="ghost" aria-label="More actions" className="@[665px]/bar:hidden">
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {canRetranscribe && (
                            <DropdownMenuItem
                                onSelect={() => setShowRetranscribe(true)}
                                disabled={empty}
                            >
                                Retranscribe
                            </DropdownMenuItem>
                        )}
                        {canRetranscribe && (
                            <DropdownMenuItem
                                onSelect={() => labelSpeakers({ downloadIfMissing: true })}
                                disabled={isLabelling || empty}
                            >
                                Label speakers
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => void onOpenMeetingFolder()}>
                            Open meeting folder
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            </div>

            {meetingId && meetingFolderPath && (
                <RetranscribeDialog
                    open={showRetranscribe}
                    onOpenChange={setShowRetranscribe}
                    meetingId={meetingId}
                    meetingFolderPath={meetingFolderPath}
                    onComplete={handleComplete}
                />
            )}
        </>
    );
}

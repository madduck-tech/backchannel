'use client';

import { useState, useCallback } from 'react';
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

    return (
        <>
            <div
                role="toolbar"
                aria-label="Meeting actions"
                // `@container` so the wrap responds to this bar's own width. The bar is
                // named as a container by its host.
                className="@container/bar pointer-events-auto mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center justify-center gap-x-3.5 gap-y-2 rounded-lg border border-line bg-sunken px-3 py-2 shadow-float"
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

                {/* Below 560px of bar these move into the menu rather than losing their
                    words. An icon a user cannot name is a control they will not press. */}
                <span className="hidden @[560px]/bar:contents">
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

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" aria-label="More actions">
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <span className="@[560px]/bar:hidden">
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
                        </span>
                        <DropdownMenuItem onSelect={() => void onOpenMeetingFolder()}>
                            Open meeting folder
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
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

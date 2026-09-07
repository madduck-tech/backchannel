import { TranscriptSegmentData } from '@/types';

/**
 * Which side of the conversation a line came from.
 *
 * This is the *capture channel*, not a claim about who spoke: `you` is this
 * machine's microphone, `others` is system audio. `database/models.rs:39` keeps
 * it in a column of its own so a diarization pass, which rewrites `speaker` on
 * every row, cannot erase it.
 */
export type ConversationSide = 'you' | 'others';

/** One or more consecutive segments from the same side, rendered as one bubble. */
export interface TranscriptTurn {
    /** The first segment's id. Stable across re-groups because the order is stable. */
    id: string;
    /** Absent when the segments carried no channel — see `channelCoverage`. */
    side?: ConversationSide;
    /** Start of the first segment. A turn is many rows and shows one time. */
    timestamp: number;
    /** End of the last segment, when the rows carry one. */
    endTime?: number;
    segments: TranscriptSegmentData[];
}

/**
 * What the recording's `channel` column can support on screen.
 *
 * - `both`   — a two-sided conversation, the only state that can be rendered as one.
 * - `one-side` — every line came from the same channel. A mic-only recording, or a
 *   meeting whose remote audio was never captured. Rendering it as a dialogue would
 *   invent a silent participant.
 * - `none`   — no line carries a channel. Not only old and imported meetings:
 *   `streaming.rs:168` sets `channel: None` unconditionally because
 *   `transcription/mod.rs:120-126` feeds that path the summed mix, so a recording made
 *   today with a streaming model lands here. This is the current product.
 */
export type ChannelCoverage = 'both' | 'one-side' | 'none';

/**
 * Silence that starts a new turn even when the side has not changed.
 *
 * Measured on the first real recording made with this fork (137 rows, 2026-09-07):
 * the gap between consecutive rows is 0.00 s at the median and 96 of 136 gaps are
 * <= 0, because the two channels overlap in time and the rows are ordered by start.
 * Side changes do nearly all of the separating — 31 turns on side change alone
 * against 33 at this threshold. The rule earns its keep on the one-sided stretches,
 * which is the case the approved design calls out.
 */
export const TURN_PAUSE_SECONDS = 3;

const endOf = (s: TranscriptSegmentData) => s.endTime ?? s.timestamp;

export function channelCoverage(segments: TranscriptSegmentData[]): ChannelCoverage {
    const sides = new Set<ConversationSide>();
    for (const s of segments) {
        if (s.channel) sides.add(s.channel);
    }
    if (sides.size === 0) return 'none';
    return sides.size === 1 ? 'one-side' : 'both';
}

/**
 * Group segments into the turns the transcript renders.
 *
 * A new turn starts when the side changes or after `TURN_PAUSE_SECONDS` of silence.
 *
 * **Grouping only happens when both sides are present**, and that is a measurement,
 * not a preference: with no side to change, the pause rule alone collapsed the same
 * 137-row recording into 8 turns of up to 53 rows. That destroys the per-row
 * timestamp — the only navigation a channel-less transcript has — and coarsens the
 * virtualiser's unit to something that no longer fits on a screen. A single-column
 * transcript therefore stays one turn per row, which is what it renders as today.
 *
 * The input is expected in `audio_start_time` order, which is the order every caller
 * fetches it in (`meeting.rs:156-160`).
 */
export function groupIntoTurns(segments: TranscriptSegmentData[]): TranscriptTurn[] {
    const oneTurnPerSegment = channelCoverage(segments) !== 'both';

    const turns: TranscriptTurn[] = [];
    for (const segment of segments) {
        const previous = turns[turns.length - 1];
        const continues =
            !oneTurnPerSegment &&
            previous !== undefined &&
            previous.side === segment.channel &&
            segment.timestamp - (previous.endTime ?? previous.timestamp) <= TURN_PAUSE_SECONDS;

        if (continues) {
            previous.segments.push(segment);
            previous.endTime = endOf(segment);
        } else {
            turns.push({
                id: segment.id,
                side: segment.channel,
                timestamp: segment.timestamp,
                endTime: endOf(segment),
                segments: [segment],
            });
        }
    }
    return turns;
}

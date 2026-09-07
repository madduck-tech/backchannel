import { Transcript } from '@/types';
import { SpeakerNames, withSpeaker } from '@/lib/speaker';

/**
 * The transcript, as the summariser is handed it.
 *
 * Pure on purpose. #113's first control was *"generate twice with the channels swapped; the two
 * summaries must differ"*, and it could not fail: the built-in summariser is stochastic by
 * construction -- `models.rs:42-53` sets `temperature: 1.0`, `llama-helper/src/main.rs:565` seeds the
 * sampler from the wall clock, and `Request::Generate` has no `seed` field at all. Three runs on
 * identical input measured 8742 / 9836 / 7609 characters and three different extracted titles. So the
 * assertion moves to the input, and the input has to be reachable without React, a model, or a
 * meeting.
 */

export interface SummaryTranscriptPayload {
    /** One line per row, marked, in order. This is what reaches `generate_meeting_summary`. */
    transcriptText: string;
    /** The same rows unmarked, for consumers that chunk on raw text. */
    transcriptTexts: string[];
}

/** `[MM:SS]`, or the row's own wall-clock string when it carries no offset. */
function formatTime(seconds: number | undefined, fallbackTimestamp: string): string {
    if (seconds === undefined) return fallbackTimestamp;
    const totalSecs = Math.floor(seconds);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

/**
 * How a row is attributed, and it is one or the other, never both.
 *
 * `channel` is the capture stream: which physical device carried the words. `speaker` is a model's
 * guess. Handing the model both invites it to choose between a fact and a guess, so the fact wins
 * wherever it exists and the guess fills in where it does not -- which is every recording made on the
 * streaming path, since `streaming.rs:168` sets `channel: None` unconditionally.
 */
export const SIDE_MARK = { you: 'You', others: 'Others' } as const;

function attribute(t: Transcript, names?: SpeakerNames): string {
    if (t.channel) return `${SIDE_MARK[t.channel]}: ${t.text}`;
    return withSpeaker(t.text, t.speaker, names);
}

/**
 * Build the summariser's input.
 *
 * The marks are chosen not to collide with Gemma 4's own thinking marker: `client.rs:261-268` strips
 * `<|channel>…<channel|>` out of replies and `models.rs:471-472` rewrites those literals if they turn
 * up in a user prompt. A plain `You:` / `Others:` prefix cannot be mistaken for either.
 */
export function buildSummaryTranscriptPayload(
    allTranscripts: Transcript[],
    speakerNames?: SpeakerNames
): SummaryTranscriptPayload {
    return {
        transcriptText: allTranscripts
            .map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${attribute(t, speakerNames)}`)
            .join('\n'),
        transcriptTexts: allTranscripts.map(t => t.text),
    };
}

/** What the rows can support, so a caller can decide whether to ask for a side-derived section. */
export function payloadCarriesSides(allTranscripts: Transcript[]): boolean {
    const sides = new Set(allTranscripts.map(t => t.channel).filter(Boolean));
    return sides.size > 1;
}

/**
 * What the model is told the marks mean, added only when the rows carry both sides.
 *
 * It rides `customPrompt`, which `processor.rs:489-492` appends to the final user prompt inside
 * `<user_context>` -- additive, so the user's chosen template is untouched and whatever they typed
 * themselves is kept. That mechanism is what makes this *conditional*: the templates are static JSON
 * resolved in Rust, so a section added there would be requested on every recording, including the
 * ones that have no sides. "You promised 12 things, they promised 0" is a lie told by structure.
 */
export const SIDE_INSTRUCTION =
    'Each transcript line is prefixed with the capture channel that carried it: "You:" is the ' +
    "person running this application, speaking into their microphone; \"Others:\" is everyone else, " +
    'arriving through system audio. This is a recording of which device carried the words, not a ' +
    'guess about identity. Use it to separate what the user committed to from what was asked of ' +
    'them, and attribute every action item to the correct side. Do not invent a side for a line ' +
    'that has none.';

/**
 * The custom prompt actually sent: the user's own text, plus the side instruction when it applies.
 * Never replaces what the user typed.
 */
export function sideAwareCustomPrompt(userPrompt: string, carriesSides: boolean): string {
    if (!carriesSides) return userPrompt;
    return userPrompt.trim() ? `${userPrompt.trim()}\n\n${SIDE_INSTRUCTION}` : SIDE_INSTRUCTION;
}

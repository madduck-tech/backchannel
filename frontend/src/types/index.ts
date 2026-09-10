export interface Message {
  id: string;
  content: string;
  timestamp: string;
}

export interface Transcript {
  id: string;
  text: string;
  timestamp: string; // Wall-clock time (e.g., "14:30:05")
  sequence_id?: number;
  chunk_start_time?: number; // Legacy field
  is_partial?: boolean;
  /** `null` when the decoder scored nothing — see the note on `Transcript.confidence`. */
  confidence?: number | null;
  // NEW: Recording-relative timestamps for playback sync
  audio_start_time?: number; // Seconds from recording start (e.g., 125.3)
  audio_end_time?: number;   // Seconds from recording start (e.g., 128.6)
  duration?: number;          // Segment duration in seconds (e.g., 3.3)
  speaker?: string;
  /**
   * Which capture channel carried these words: 'you' is this machine's
   * microphone, 'others' is system audio. Absent when the decoder cannot say --
   * today the streaming path, which is fed the two channels summed.
   *
   * Separate from `speaker`, which is a model's guess and is rewritten in full
   * by a diarization pass.
   */
  channel?: 'you' | 'others';
}

export interface TranscriptUpdate {
  text: string;
  timestamp: string; // Wall-clock time for reference
  source: string;
  sequence_id: number;
  chunk_start_time: number; // Legacy field
  is_partial: boolean;
  /**
   * Absent when the decoder reports no token probabilities, which is most of them: only the
   * `parakeet` architecture assigns a real per-token value, and 61 of `TRANSCRIBE_MODEL_CATALOG`'s 86
   * rows come from one that does not.
   *
   * `null` is in the type because the payload is JSON and `serde_json` cannot write a non-finite
   * float. The renderer asks `isScored`, not `!== undefined` — that guard let `null` through, and
   * `Math.round(null * 100)` is `0` (#162).
   */
  confidence?: number | null;
  // NEW: Recording-relative timestamps for playback sync
  audio_start_time: number; // Seconds from recording start
  audio_end_time: number;   // Seconds from recording start
  duration: number;          // Segment duration in seconds
  speaker?: string;
  /**
   * Which capture channel carried these words: 'you' is this machine's
   * microphone, 'others' is system audio. Absent when the decoder cannot say --
   * today the streaming path, which is fed the two channels summed.
   *
   * Separate from `speaker`, which is a model's guess and is rewritten in full
   * by a diarization pass.
   */
  channel?: 'you' | 'others';
}

export interface Block {
  id: string;
  type: string;
  content: string;
  color: string;
}

export interface Section {
  title: string;
  blocks: Block[];
}

export interface Summary {
  [key: string]: Section;
}

export interface ApiResponse {
  message: string;
  num_chunks: number;
  data: any[];
}

export interface SummaryResponse {
  status: string;
  summary: Summary;
  raw_summary?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// BlockNote-specific types
export type SummaryFormat = 'legacy' | 'markdown' | 'blocknote';

export interface BlockNoteBlock {
  id: string;
  type: string;
  props?: Record<string, any>;
  content?: any[];
  children?: BlockNoteBlock[];
}

export interface SummaryDataResponse {
  markdown?: string;
  summary_json?: BlockNoteBlock[];
  // Legacy format fields
  MeetingName?: string;
  _section_order?: string[];
  [key: string]: any; // For legacy section data
}

// Pagination types for optimized transcript loading
export interface MeetingMetadata {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  folder_path?: string;
}

export interface PaginatedTranscriptsResponse {
  transcripts: Transcript[];
  total_count: number;
  has_more: boolean;
}

// Transcript segment data for virtualized display
export interface TranscriptSegmentData {
  id: string;
  timestamp: number; // audio_start_time in seconds
  endTime?: number; // audio_end_time in seconds
  text: string;
  /** `null` when the decoder scored nothing — see the note on `Transcript.confidence`. */
  confidence?: number | null;
  speaker?: string;
  /**
   * Which capture channel carried these words -- the fact the transcript is
   * rendered from. Carried here so a saved meeting has sides too: every mapping
   * layer that builds this type used to drop the column on the floor.
   *
   * Absent when the decoder cannot say, which includes every recording made on
   * the streaming path (`streaming.rs:168`). Kept separate from `speaker`, a
   * model's guess that a diarization pass rewrites in full.
   */
  channel?: 'you' | 'others';
}

// The recording lifecycle, read by the provider in `contexts/RecordingStateContext.tsx` and by every surface that
// compares a status.

// Recording lifecycle status enum
export enum RecordingStatus {
  IDLE = 'idle',                          // Not recording
  STARTING = 'starting',                  // Initiating recording
  RECORDING = 'recording',                // Active recording
  STOPPING = 'stopping',                  // Stop initiated, waiting for backend
  PROCESSING_TRANSCRIPTS = 'processing',  // Transcription completion wait
  SAVING = 'saving',                      // Saving to database
  COMPLETED = 'completed',                // Successfully saved
  ERROR = 'error'                         // Error occurred
}

/**
 * From a stop's start until the saved meeting's URL commits. No surface claims a live recording or offers Start in
 * any of these (#328 items 2 and 4).
 */
export const STOP_FLOW: RecordingStatus[] = [
  RecordingStatus.STOPPING,
  RecordingStatus.PROCESSING_TRANSCRIPTS,
  RecordingStatus.SAVING,
  RecordingStatus.COMPLETED,
];

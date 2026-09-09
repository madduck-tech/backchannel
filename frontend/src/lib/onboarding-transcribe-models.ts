/**
 * The four transcription models first run offers, and their sizes.
 *
 * **Shared because two screens state the same number and disagreed about it.** The list lived inside
 * `TranscriptionModelStep.tsx`; `DownloadProgressStep.tsx` could not reach it and carried a literal
 * instead — `716`, which is *nemotron's* size, shown while the default `parakeet-tdt-0.6b-v3-q8`
 * (740 MB) was being fetched. The product owner photographed the two screens of one flow giving one
 * file two sizes (#146).
 *
 * Sizes are `size_mb` from `src-tauri/src/config.rs`'s `TRANSCRIBE_MODEL_CATALOG`, which is generated
 * — see `scripts/gen_model_catalog.py`. A model outside these four has its size reported by the
 * download's own progress events; there is no frontend copy of all 85 rows and this file is not one.
 */
export type RecommendedTranscribeModel = {
  id: string;
  mb: number;
  decode: 'batch' | 'streaming';
  wer: number;
  languages: string;
  isDefault?: boolean;
};

/** The four, in the order the approved design put them: widest language coverage first. */
export const RECOMMENDED_TRANSCRIBE_MODELS: RecommendedTranscribeModel[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-q8',
    mb: 740,
    decode: 'batch',
    wer: 1.94,
    languages: '25 European languages',
    isDefault: true,
  },
  {
    id: 'nemotron-3.5-asr-streaming-0.6b-q8',
    mb: 716,
    decode: 'streaming',
    wer: 3.06,
    languages: '32 languages, including Chinese, Japanese, Korean, Arabic and Hindi',
  },
  {
    id: 'moonshine-streaming-small-q8',
    mb: 189,
    decode: 'streaming',
    wer: 2.54,
    languages: 'English only',
  },
  { id: 'moonshine-tiny-q8', mb: 34, decode: 'batch', wer: 4.6, languages: 'English only' },
];

/**
 * How big the chosen model is, or `null` when it is one of the 84 the frontend does not carry.
 * `null` is the honest answer: the download's first progress event supplies the real total, and a
 * guess in the meantime is what this module exists to stop.
 */
export function transcribeModelSizeMb(id: string): number | null {
  return RECOMMENDED_TRANSCRIBE_MODELS.find((m) => m.id === id)?.mb ?? null;
}

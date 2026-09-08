/**
 * The Tauri boundary, for stories. (#124 condition 4)
 *
 * `main.ts` aliases `@tauri-apps/api/core` here, so a component that reaches the backend from a story
 * **fails loudly instead of hanging**. That is the same contract `tests/lib/tauri-stubs.mjs` holds for
 * the jsdom tests — `invoked an unstubbed command: <cmd>` — and it is deliberately the same sentence,
 * because two boundaries that disagree are how a catalogue starts describing a different application.
 *
 * It is a separate file rather than an import of `tauri-stubs.mjs` because that module is Node
 * (`node:fs`, `node:path`, `node:url` at top level, consumed by a `node:vm` loader) and cannot be
 * bundled for a browser without forking it. Named here so the duplication is a decision rather than
 * an accident; `storybook-boundary-agrees.test.mjs` holds the two in step.
 */
const ANSWERS: Record<string, unknown> = {
  is_recording: false,
  get_audio_devices: [],
  get_audio_backend_info: [],
  get_current_audio_backend: null,
}

export async function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  if (Object.prototype.hasOwnProperty.call(ANSWERS, cmd)) return ANSWERS[cmd] as T
  throw new Error(`invoked an unstubbed command: ${cmd}`)
}

export const convertFileSrc = (p: string) => p
export const transformCallback = () => 0

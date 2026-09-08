/**
 * The Tauri boundary, for stories. (#124 condition 4)
 *
 * `main.ts` aliases `@tauri-apps/api/core` here, so a component that reaches the backend from a story
 * **fails loudly instead of hanging**, with the same sentence `tests/lib/tauri-stubs.mjs` uses for the
 * jsdom tests — `invoked an unstubbed command: <cmd>`. Two boundaries that disagree are how a
 * catalogue starts describing a different application.
 *
 * A separate file rather than an import of `tauri-stubs.mjs` because that module is Node (`node:fs`,
 * `node:path`, `node:url` at top level, consumed by a `node:vm` loader) and cannot be bundled for a
 * browser without forking it. `storybook-boundary-agrees.test.mjs` holds the two in step.
 *
 * **What a story answers is declared in the story**, through `withTauri` below — not added silently
 * here. A component that needs eight commands to render is coupled to eight commands, and #102 exists
 * to count that. Burying them in a global default would erase the census.
 */
type Answers = Record<string, unknown>

declare global {
  interface Window { __BC_STORY_ANSWERS__?: Answers }
}

/** True of every story: these are asked before anything renders and answering them says nothing. */
const ALWAYS: Answers = {
  is_recording: false,
  get_audio_devices: [],
  get_audio_backend_info: [],
  get_current_audio_backend: null,
}

export async function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  const declared = (typeof window !== 'undefined' && window.__BC_STORY_ANSWERS__) || {}
  if (Object.prototype.hasOwnProperty.call(declared, cmd)) return declared[cmd] as T
  if (Object.prototype.hasOwnProperty.call(ALWAYS, cmd)) return ALWAYS[cmd] as T
  throw new Error(`invoked an unstubbed command: ${cmd}`)
}

export const convertFileSrc = (p: string) => p
export const transformCallback = () => 0

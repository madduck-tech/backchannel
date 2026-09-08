import * as React from 'react'
import type { Decorator } from '@storybook/nextjs'

/**
 * Declare, in the story, which backend commands its component needs. Anything not listed throws
 * `invoked an unstubbed command: <cmd>` from `tauri-boundary.ts`, which is the point: the list is the
 * component's coupling, written down where a reader sees it (#102).
 */
export const withTauri =
  (answers: Record<string, unknown>): Decorator =>
  (Story) => {
    // The boundary reads this off `window`; the cast is here rather than a global .d.ts so the
    // declaration stays next to the file that owns the key.
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __BC_STORY_ANSWERS__?: Record<string, unknown> }).__BC_STORY_ANSWERS__ =
        answers
    }
    return <Story />
  }

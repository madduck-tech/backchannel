import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { invoke } from '@tauri-apps/api/core'

/**
 * Not a product component — the boundary's own proof.
 *
 * `main.ts` aliases `@tauri-apps/api/core` to `.storybook/tauri-boundary.ts`, so a story that reaches
 * the backend gets a thrown error rather than a promise that never settles. A hang is the worse
 * failure: it looks like a slow render, and a driver waiting on it reports a timeout rather than the
 * reason.
*
 * The command is a **real** one, registered in `lib.rs` and simply not declared by this story.
 * `command-reachability.test.mjs` holds -- with no allowlist, on purpose -- that an invoke naming an
 * unregistered command is always a defect. An invented name here would have weakened that rule rather
 * than tested this one, and a real command a story forgot to declare is the case that happens anyway.
 */
const Probe = () => {
  const [state, setState] = React.useState('pending')
  React.useEffect(() => {
    invoke('check_first_launch')
      .then(() => setState('resolved'))
      .catch((e: Error) => setState(e.message))
  }, [])
  return <div data-boundary={state}>{state}</div>
}

const meta: Meta<typeof Probe> = { title: 'Instrument/Boundary', component: Probe }
export default meta

export const UnstubbedCommand: StoryObj<typeof Probe> = {}

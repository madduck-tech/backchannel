import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { MeetingActionBar } from './MeetingActionBar'
import { ConfigProvider } from '@/contexts/ConfigContext'
import { withTauri } from '../../../.storybook/withTauri'

/**
 * The action bar, narrow enough that its container query has collapsed the buttons into the overflow
 * menu. `storybook-interaction.test.mjs` opens that menu and reads what is in it — a state jsdom
 * cannot reach at all: `dom-harness.mjs` records that Radix popovers are never opened there, and the
 * whole suite contains one `.click()`.
 */
const meta: Meta<typeof MeetingActionBar> = {
  title: 'MeetingDetails/ActionBar',
  component: MeetingActionBar,
  // What this component's provider actually asks the backend for. Eight commands to draw a row of
  // buttons is the coupling #102 counts; listing them here is what makes it visible.
  decorators: [
    withTauri({
      api_get_api_key: null,
      get_database_directory: '/tmp/story',
      get_default_recordings_folder_path: '/tmp/story/recordings',
      get_notification_settings: {},
      get_ollama_models: [],
      set_language_preference: null,
      set_notification_settings: null,
      transcribe_get_models_directory: '/tmp/story/models',
    }),
    (Story) => <ConfigProvider><Story /></ConfigProvider>,
  ],
  args: {
    recordedSeconds: 754,
    transcriptCount: 12,
    onCopyTranscript: () => {},
    onOpenMeetingFolder: async () => {},
    meetingId: 'story-meeting',
    meetingFolderPath: '/tmp/story-meeting',
    onRefetchTranscripts: async () => {},
  },
}
export default meta

/**
 * The host the meeting page draws the bar in, copied class for class from `page-content.tsx`.
 * `the-action-bar-is-one-row.test.mjs` reads that file and requires these classes to match, so the
 * room the bar measures here is the room it has in the application: the host's content box, inside
 * its `px-4` (#165).
 */
const BAR_HOST_CLASSES = 'pointer-events-none absolute inset-x-0 bottom-4 z-sticky px-4'

const inHost = (pane: number) => {
  const Decorated = (Story: React.ComponentType) => (
    <div data-bar-pane={pane} style={{ position: 'relative', width: `${pane}px`, height: '160px' }}>
      <div className={BAR_HOST_CLASSES}>
        <Story />
      </div>
    </div>
  )
  Decorated.displayName = `InHost${pane}`
  return Decorated
}

/**
 * Narrow: a 448 px room, below the breakpoint, so Retranscribe and Label speakers are in the menu.
 * `storybook-interaction.test.mjs` and `the-action-bar-is-one-row.test.mjs` open that menu.
 */
export const Narrow: StoryObj<typeof MeetingActionBar> = {
  decorators: [inHost(480)],
}

/** The same room with no meeting folder: the menu holds `Open meeting folder` alone. */
export const NarrowNoRetranscribe: StoryObj<typeof MeetingActionBar> = {
  args: { meetingFolderPath: '' },
  decorators: [inHost(480)],
}

/**
 * Panes the geometry test resizes itself, room by room, so one page load measures every room. One
 * story per data case the bar's width depends on: the recorded length (its format widens at an hour,
 * `formatElapsed`), whether Retranscribe and Speakers are offered, and an unknown length. Explicit
 * stories rather than URL args, which this Storybook ignores for numbers.
 */
export const Sized: StoryObj<typeof MeetingActionBar> = {
  decorators: [inHost(896)],
}

/** The widest case the breakpoint is derived from: every button, and `99:59:59`. */
export const SizedLongest: StoryObj<typeof MeetingActionBar> = {
  args: { recordedSeconds: 359999 },
  decorators: [inHost(896)],
}

/** Nine hours: the `h:mm:ss` format at one hour digit. */
export const SizedHours: StoryObj<typeof MeetingActionBar> = {
  args: { recordedSeconds: 35999 },
  decorators: [inHost(896)],
}

/** No meeting folder, so no Retranscribe or Speakers, with the longest length. */
export const SizedNoRetranscribe: StoryObj<typeof MeetingActionBar> = {
  args: { recordedSeconds: 359999, meetingFolderPath: '' },
  decorators: [inHost(896)],
}

/** A length nobody can state, so no `recorded` figure at all. */
export const SizedUnknownLength: StoryObj<typeof MeetingActionBar> = {
  args: { recordedSeconds: null },
  decorators: [inHost(896)],
}

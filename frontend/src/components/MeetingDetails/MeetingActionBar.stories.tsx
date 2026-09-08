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
 * Below the `@[560px]/bar` breakpoint, so Retranscribe and Label speakers live in the menu rather
 * than on the bar. That is the state worth asserting: the wide one hides nothing.
 */
export const Narrow: StoryObj<typeof MeetingActionBar> = {
  decorators: [
    (Story) => (
      <div data-bar-pane="420" style={{ width: '420px' }}>
        <Story />
      </div>
    ),
  ],
}

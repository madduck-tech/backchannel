import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { VirtualizedTranscriptView } from './VirtualizedTranscriptView'
import type { TranscriptSegmentData } from '@/types'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'

/**
 * The transcript at the two widths #118 argued about.
 *
 * These stories exist to be measured, not admired: `storybook-geometry.test.mjs` reads the bubble and
 * its offset out of them. The pane widths are the ones in #118's table, stated as **content boxes**
 * (a pane of 1096 or 432 less its 32px of padding), because that is what the CSS actually resolves
 * against.
 */
const seg = (id: string, text: string, channel: 'you' | 'others'): TranscriptSegmentData => ({
  id,
  timestamp: 0,
  text,
  channel,
})

/** Long enough that the bubble reaches its cap at both widths — the cap is what is under test. */
const LONG =
  'The width of this line has to exceed the cap at both pane widths, otherwise the measurement is of ' +
  'the sentence rather than of the rule that bounds it, and the story would pass while the rule was gone.'

const segments = [seg('a', LONG, 'others'), seg('b', LONG, 'you')]

const AtWidth = ({ pane }: { pane: number }) => (
  <div data-pane={pane} style={{ width: `${pane}px` }}>
    <VirtualizedTranscriptView segments={segments} />
  </div>
)

const meta: Meta<typeof AtWidth> = {
  title: 'Transcript/Width',
  component: AtWidth,
  // Declared per story rather than globally: a component that cannot render without a provider is
  // coupled, and #102 counts that. Hiding it in a global decorator would erase the census.
  decorators: [(Story) => <RecordingStateProvider><Story /></RecordingStateProvider>],
}
export default meta

/**
 * #118's wide cell. The component carries 16px of padding on each side, so a 1096px pane is a 1064px
 * content box — measured, not assumed: at a 1064px outer width the left bubble sits at x=16.
 */
export const WidePane: StoryObj<typeof AtWidth> = { args: { pane: 1096 } }

/** #118's narrow cell — the one where the approved variant lost the side entirely. */
export const NarrowPane: StoryObj<typeof AtWidth> = { args: { pane: 432 } }

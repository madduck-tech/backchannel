import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'

/**
 * Not a product component — the instrument's own calibration.
 *
 * Every geometry assertion in this catalogue is a multiple of one number: how wide a `ch` is. That
 * resolves against the *loaded* face, so if the application's webfont does not reach a story, every
 * measurement is 4.8% small and looks perfectly plausible. This story is what the check reads
 * instead of trusting the decorator to have worked.
 */
const Probe = () => (
  <div>
    <div data-probe="ch60" style={{ width: '60ch', fontSize: '14px' }} />
    <div data-probe="ch1" style={{ width: '1ch', fontSize: '14px' }} />
  </div>
)

const meta: Meta<typeof Probe> = { title: 'Instrument/Typography', component: Probe }
export default meta

export const Calibration: StoryObj<typeof Probe> = {}

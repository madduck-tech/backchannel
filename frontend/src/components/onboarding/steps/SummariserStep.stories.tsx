import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { SummariserStep } from './SummariserStep'
import { withTauri } from '../../../../.storybook/withTauri'
import { OnboardingProvider } from '@/contexts/OnboardingContext'

/**
 * First run, choosing where summaries are written.
 *
 * The story exists to be measured. On 2026-09-08 the product owner picked a remote provider and
 * concluded nothing had happened: the API key field appeared below the fold. jsdom computes no
 * layout, so nothing in the suite could see that — `storybook-summariser-reveal.test.mjs` opens this
 * story at the window the application actually permits (`minWidth: 720`, `minHeight: 520`) and reads
 * the field's rectangle.
 */
const meta: Meta<typeof SummariserStep> = {
  title: 'Onboarding/Summariser',
  component: SummariserStep,
  // The real provider, because Storybook does not substitute modules and a hand-stubbed hook would
  // be a second description of the step. What it asks the backend for is declared here rather than
  // answered globally — that list is the step's coupling, and #102 counts it.
  decorators: [
    withTauri({
      get_onboarding_status: null,
      check_first_launch: false,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      save_onboarding_status: null,
      api_save_model_config: null,
      api_get_api_key: null,
    }),
    (Story) => (
      <OnboardingProvider>
        <Story />
      </OnboardingProvider>
    ),
  ],
}
export default meta

/** Nothing chosen yet — the state the person arrives in. */
export const Fresh: StoryObj<typeof SummariserStep> = {}

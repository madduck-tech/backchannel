import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { TranscriptionModelStep } from './TranscriptionModelStep'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { withTauri } from '../../../../.storybook/withTauri'

/**
 * First run, choosing which model turns speech into text.
 *
 * The product owner rejected what shipped here on 2026-09-08: the catalogue behind its button carried
 * a sort control, an installed-only filter and a paragraph explaining word error rate, none of which
 * were asked for. `catalogue-offers-one-action.test.mjs` holds the removals; this story is what lets
 * the geometry be read at all, since jsdom computes no layout.
 */
const model = (over: Record<string, unknown>) => ({
  name: 'x', path: '/tmp/x.gguf', size_mb: 100, accuracy: 'High', wer: 2.5, wer_set: 'set',
  speed: 'Fast', status: 'Missing', description: '', streaming: false, languages: ['en'], ...over,
})

const meta: Meta<typeof TranscriptionModelStep> = {
  title: 'Onboarding/TranscriptionModel',
  component: TranscriptionModelStep,
  decorators: [
    withTauri({
      get_onboarding_status: null,
      check_first_launch: false,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      save_onboarding_status: null,
      transcribe_get_available_models: [
        model({ name: 'parakeet-tdt-0.6b-v3-q8', size_mb: 740, status: 'Available', languages: ['en', 'de'] }),
        model({ name: 'moonshine-tiny-q8', size_mb: 34 }),
      ],
    }),
    (Story) => (
      <OnboardingProvider>
        <Story />
      </OnboardingProvider>
    ),
  ],
}
export default meta

/** The four recommended options, catalogue closed — the state the person arrives in. */
export const Fresh: StoryObj<typeof TranscriptionModelStep> = {}

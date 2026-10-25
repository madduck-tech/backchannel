import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { DownloadProgressStep } from './DownloadProgressStep'
import { OnboardingProvider, useOnboarding } from '@/contexts/OnboardingContext'
import { withTauri } from '../../../../.storybook/withTauri'

/**
 * First run, fetching what was chosen.
 *
 * This screen is the one the product owner photographed showing `0.0 MB / 705.3 MB` at 0% while the
 * file was already on disk. The behaviour behind it was fixed in `ceb57a1` — it downloads, retries and
 * reports the model the person chose rather than a constant. The screen itself is still the one
 * inherited from the fork; `design/prototypes/onboarding-download.html` is what it should become, and
 * this story is what will let the two be compared.
 */
const meta: Meta<typeof DownloadProgressStep> = {
  title: 'Onboarding/Download',
  component: DownloadProgressStep,
  decorators: [
    withTauri({
      get_onboarding_status: null,
      check_first_launch: false,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      save_onboarding_status: null,
      transcribe_has_available_models: false,
      transcribe_get_available_models: [],
      transcribe_download_model: null,
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
    }),
    (Story) => (
      <OnboardingProvider>
        <Story />
      </OnboardingProvider>
    ),
  ],
}
export default meta

/** Nothing on disk yet — the state a first run actually starts in. */
export const Fresh: StoryObj<typeof DownloadProgressStep> = {}

/**
 * The state the product owner photographed: one of the two files is already on disk.
 *
 * `design/prototypes/onboarding-download.html` (`a-two-rows`, approved) states presence in words —
 * *"Already here from an earlier install. Nothing to fetch."* — and gives that row no progress bar at
 * all. The inherited screen instead starts the row at `status: 'completed'` with `downloadedMb: 0`,
 * so it draws a full bar over a counter reading `0.0 MiB / 0.0 MiB`.
 * `tests/lib/storybook-download-states.test.mjs` renders this story and reads that row.
 */
export const OneAlreadyOnDisk: StoryObj<typeof DownloadProgressStep> = {
  decorators: [
    withTauri({
      get_onboarding_status: null,
      check_first_launch: false,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      builtin_ai_is_model_ready: true,
      save_onboarding_status: null,
      transcribe_has_available_models: false,
      transcribe_get_available_models: [],
      transcribe_download_model: null,
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
    }),
  ],
}

/** Renders the step once the provider holds `model`, the way a choice made one screen earlier does. */
function ChosenFirst({ model, children }: { model: string; children: React.ReactNode }) {
  const { selectedTranscribeModel, setSelectedTranscribeModel } = useOnboarding()
  React.useEffect(() => {
    setSelectedTranscribeModel(model)
  }, [model, setSelectedTranscribeModel])
  return selectedTranscribeModel === model ? <>{children}</> : null
}

/**
 * A model outside the recommended four, chosen in the catalogue, before its first progress event.
 *
 * The frontend carries only the four's sizes, so this row read "0 of 0 MB" until the HTTP response
 * arrived (#166). Its size is now the catalogue's, from the backend.
 * `tests/lib/storybook-download-size.test.mjs` renders this story and reads the row.
 */
export const ChosenOutsideTheFour: StoryObj<typeof DownloadProgressStep> = {
  decorators: [
    (Story) => (
      <ChosenFirst model="whisper-tiny-q8">
        <Story />
      </ChosenFirst>
    ),
    withTauri({
      get_onboarding_status: null,
      check_first_launch: false,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      save_onboarding_status: null,
      transcribe_has_available_models: false,
      transcribe_get_available_models: [
        {
          name: 'whisper-tiny-q8', family: 'Whisper', path: '/tmp/x.gguf', size_mb: 44, accuracy: 'Low',
          wer: 7.7, wer_set: 'set', speed: 'Fast', status: 'Missing', description: '', streaming: false,
          languages: ['en'], recommended: false, diarizes: false,
        },
      ],
      // Accepted and never finished, so no progress event ever arrives: the window under test.
      transcribe_download_model: new Promise(() => {}),
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
    }),
  ],
}

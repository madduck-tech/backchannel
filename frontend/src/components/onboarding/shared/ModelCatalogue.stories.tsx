import * as React from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs'
import { ModelCatalogue } from './ModelCatalogue'
import { withTauri } from '../../../../.storybook/withTauri'

/**
 * First run's catalogue, behind "Browse every model".
 *
 * The rows follow `design/prototypes/onboarding-catalogue.html` (`a4`): a radio per row, and nothing
 * on the row a person can press but the row itself. Every row state is here, so the layout can be
 * read against the prototype: nothing on disk, a whole file, and a truncated one (#166).
 */
const model = (over: Record<string, unknown>) => ({
  path: '/tmp/x.gguf', accuracy: 'High', wer: 2.5, wer_set: 'set', speed: 'Fast', status: 'Missing',
  description: '', streaming: false, languages: ['en'], recommended: false, diarizes: false, ...over,
})

function Choosing() {
  const [chosen, setChosen] = React.useState('parakeet-tdt-0.6b-v3-q8')
  return <ModelCatalogue selectedModel={chosen} onModelSelect={setChosen} />
}

const meta: Meta<typeof ModelCatalogue> = {
  title: 'Onboarding/ModelCatalogue',
  component: ModelCatalogue,
  render: () => <Choosing />,
  decorators: [
    withTauri({
      transcribe_get_available_models: [
        model({ name: 'parakeet-tdt-0.6b-v3-q8', family: 'Parakeet TDT v3', size_mb: 740, languages: ['en', 'de', 'fr', 'ru', 'uk'], recommended: true }),
        model({ name: 'moonshine-tiny-q8', family: 'Moonshine', size_mb: 34, status: 'Available', recommended: true }),
        model({ name: 'nemotron-3.5-asr-streaming-0.6b-q8', family: 'Nemotron 3.5', size_mb: 716, streaming: true, languages: ['en-US', 'ru-RU', 'de-DE', 'ja-JP', 'zh-CN'] }),
        model({ name: 'gigaam-v3-ctc-q8', family: 'GigaAM', size_mb: 259, languages: ['ru'] }),
        model({ name: 'canary-180m-flash-q8', family: 'Canary', size_mb: 190, languages: ['en', 'de', 'fr', 'es'], status: { Corrupted: { file_size: 52_000_000, expected_min_size: 179_000_000 } } }),
      ],
    }),
  ],
}
export default meta

/** A clean profile apart from one whole file and one truncated one. */
export const EveryRowState: StoryObj<typeof ModelCatalogue> = {}

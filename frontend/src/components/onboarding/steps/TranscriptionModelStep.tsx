'use client';

import { useState } from 'react';
import TranscriptionModelManager from '@/components/TranscriptionModelManager';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { cn } from '@/lib/utils';

/**
 * The first decision of the first run: which model turns speech into text.
 *
 * **Four options and a button, not a catalogue.** The first version of this screen mounted
 * `TranscriptionModelManager` -- the Settings panel -- whole: 86 rows, a search field, a sort
 * control, an "installed only" toggle, and a paragraph explaining what a word error rate is. That
 * panel is written for someone who already knows what they are looking for. On the first screen of
 * the application it is noise, and the product owner said so in those words.
 *
 * The catalogue is still reachable, behind a button, for the person who came here to find one
 * specific model. That is the whole of what search is for at this point.
 *
 * **Order matters and is not alphabetical.** The multilingual models come first. The catalogue's own
 * order puts three English-only Moonshine rows above them, and the picker's "Recommended" sort is
 * `catalog` -- which returns the list unchanged -- so the first thing a Russian or Japanese speaker
 * saw was three models that cannot transcribe them.
 */

type Recommended = {
    id: string;
    mb: number;
    decode: 'batch' | 'streaming';
    wer: number;
    languages: string;
    isDefault?: boolean;
};

/** The four, in the order the approved design put them: widest language coverage first. */
const RECOMMENDED: Recommended[] = [
    {
        id: 'parakeet-tdt-0.6b-v3-q8',
        mb: 740,
        decode: 'batch',
        wer: 1.94,
        languages: '25 European languages',
        isDefault: true,
    },
    {
        id: 'nemotron-3.5-asr-streaming-0.6b-q8',
        mb: 716,
        decode: 'streaming',
        wer: 3.06,
        languages: '32 languages, including Chinese, Japanese, Korean, Arabic and Hindi',
    },
    {
        id: 'moonshine-streaming-small-q8',
        mb: 189,
        decode: 'streaming',
        wer: 2.54,
        languages: 'English only',
    },
    { id: 'moonshine-tiny-q8', mb: 34, decode: 'batch', wer: 4.6, languages: 'English only' },
];

/** What the decode mode does to the transcript, in words rather than in a term. */
function shape(decode: Recommended['decode']) {
    return decode === 'batch'
        ? 'Transcript in two sides, you and the others. Text arrives in chunks of a few seconds.'
        : 'Transcript in one column — a streaming model records no channel to place lines by. Text arrives word by word.';
}

export function TranscriptionModelStep() {
    const { goNext, selectedTranscribeModel, setSelectedTranscribeModel } = useOnboarding();
    const [showCatalogue, setShowCatalogue] = useState(false);

    return (
        <OnboardingContainer
            title="Choose a transcription model"
            description="It turns speech into text, on this machine."
            step={1}
        >
            <div className="flex w-full flex-col gap-4">
                <div role="radiogroup" aria-label="Recommended transcription models" className="flex flex-col gap-2">
                    {RECOMMENDED.map((model) => {
                        const selected = model.id === selectedTranscribeModel;
                        return (
                            <label
                                key={model.id}
                                className={cn(
                                    'flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2.5 transition-colors duration-fast',
                                    selected
                                        ? 'border-brand bg-brand-soft'
                                        : 'border-line bg-elevated hover:border-line-strong'
                                )}
                            >
                                <span className="flex items-baseline gap-2">
                                    <input
                                        type="radio"
                                        name="transcription-model"
                                        className="sr-only"
                                        checked={selected}
                                        onChange={() => setSelectedTranscribeModel(model.id)}
                                    />
                                    <span
                                        aria-hidden
                                        className={cn(
                                            'mt-1 h-2.5 w-2.5 shrink-0 rounded-full border',
                                            selected ? 'border-brand bg-brand' : 'border-line-strong'
                                        )}
                                    />
                                    <span className="readout text-md text-ink">{model.id}</span>
                                    {model.isDefault && (
                                        <span className="rounded-sm bg-sunken px-1.5 py-0.5 text-2xs text-ink-muted">
                                            default
                                        </span>
                                    )}
                                </span>
                                <span className="pl-[1.125rem] text-base text-ink-muted">
                                    {model.mb} MB · {model.decode} · {model.wer.toFixed(2)}% word error rate ·{' '}
                                    {model.languages}
                                </span>
                                <span className="pl-[1.125rem] text-base leading-relaxed text-ink-muted">
                                    {shape(model.decode)}
                                </span>
                            </label>
                        );
                    })}
                </div>

                <div className="flex items-center gap-3">
                    <Button onClick={goNext} className="h-11 flex-1" disabled={!selectedTranscribeModel}>
                        Continue
                    </Button>
                    <Button
                        variant="ghost"
                        className="h-11"
                        onClick={() => setShowCatalogue((v) => !v)}
                        aria-expanded={showCatalogue}
                    >
                        {showCatalogue ? 'Hide the catalogue' : 'All 86 models'}
                    </Button>
                </div>

                {/* Behind a button on purpose: the person who needs it came looking for one model by
                    name, and everyone else is served by the four above. */}
                {showCatalogue && (
                    <TranscriptionModelManager
                        selectedModel={selectedTranscribeModel}
                        onModelSelect={setSelectedTranscribeModel}
                    />
                )}
            </div>
        </OnboardingContainer>
    );
}

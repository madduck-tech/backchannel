'use client';

import TranscriptionModelManager from '@/components/TranscriptionModelManager';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

/**
 * The first decision of the first run: which model turns speech into text.
 *
 * It comes before the summariser because it is the one that cannot be skipped -- and because it
 * decides more than accuracy. `streaming.rs:168` sets `channel: None` on every row a streaming
 * model produces, and the transcript renders a two-sided conversation from that column (#112). So a
 * streaming model gives word-by-word text and a one-column transcript, while a batch model gives
 * ~8 second chunks and a conversation with two sides. `TranscriptionModelManager` shows that trade
 * on the card, along with WER beside the set it was measured on -- 1.94% on English read speech and
 * 5.50% on Russian are not two points on one scale.
 *
 * The catalogue has 86 rows, so the manager's own search is what makes this a decision rather than a
 * list. It matches name, family, description and language, and `languageHaystack` normalises both
 * code shapes -- a query for "ru" finds `ru` and `ru-RU` alike, which matters because the only
 * streaming models with Russian use the second form.
 */
export function TranscriptionModelStep() {
    const { goNext, selectedTranscribeModel, setSelectedTranscribeModel } = useOnboarding();

    return (
        <OnboardingContainer
            title="Choose a transcription model"
            description="This one runs on your machine and turns speech into text. It is the only model the app cannot work without."
            step={1}
        >
            <div className="flex w-full flex-col gap-6">
                <TranscriptionModelManager
                    selectedModel={selectedTranscribeModel}
                    onModelSelect={setSelectedTranscribeModel}
                />
                <div className="mx-auto w-full max-w-xs">
                    <Button onClick={goNext} className="h-11 w-full" disabled={!selectedTranscribeModel}>
                        Continue
                    </Button>
                </div>
            </div>
        </OnboardingContainer>
    );
}

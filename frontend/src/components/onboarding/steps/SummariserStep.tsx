'use client';

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Where the summary is written, and where the words go to get there.
 *
 * The claims that used to open the first run live here now, on the options that make each one true
 * or false. "Your data never leaves your device" was an absolute on screen one, and a minute later
 * the user could pick a provider that sends whole transcripts to a third party with nothing saying
 * so. Five of the seven do.
 *
 * The local choice costs 3651 MiB to download; a cloud choice costs nothing and needs a key.
 */

type Option = {
    id: string;
    name: string;
    where: string;
    local: boolean;
    /** Download size in MiB, when this choice adds one. */
    mib?: number;
    defaultModel: string;
};

const OPTIONS: Option[] = [
    {
        id: 'builtin-ai',
        name: 'Built-in AI',
        where: 'Runs on this machine. Nothing leaves.',
        local: true,
        mib: 3651,
        defaultModel: 'gemma4:e2b',
    },
    {
        id: 'ollama',
        name: 'Ollama',
        where: 'Runs on this machine, through an Ollama you already have. Nothing leaves.',
        local: true,
        defaultModel: 'llama3.2',
    },
    {
        id: 'claude',
        name: 'Claude',
        where: 'Each transcript is sent to Anthropic.',
        local: false,
        defaultModel: 'claude-sonnet-4-5-20250929',
    },
    {
        id: 'openai',
        name: 'OpenAI',
        where: 'Each transcript is sent to OpenAI.',
        local: false,
        defaultModel: 'gpt-4o',
    },
    {
        id: 'groq',
        name: 'Groq',
        where: 'Each transcript is sent to Groq.',
        local: false,
        defaultModel: 'llama-3.3-70b-versatile',
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        where: "Each transcript is sent to OpenRouter, and on to the model's provider.",
        local: false,
        defaultModel: 'anthropic/claude-sonnet-4.5',
    },
];

export function SummariserStep() {
    const {
        goNext,
        summaryProvider,
        setSummaryProvider,
        setSelectedSummaryModel,
        recommendedSummaryModel,
    } = useOnboarding();
    const [apiKey, setApiKey] = useState('');
    const [saving, setSaving] = useState(false);

    const chosen = OPTIONS.find((o) => o.id === summaryProvider) ?? OPTIONS[0];
    const needsKey = !chosen.local;
    const canContinue = !needsKey || apiKey.trim().length > 0;

    /**
     * The chosen option's own element, so the reveal can be brought into view.
     *
     * Measured on 2026-09-08 before this existed: at the application's minimum window -- 720x520 per
     * `tauri.conf.json` -- choosing a remote provider put its key field at 730..766px, **210px below
     * the fold**. The product owner picked OpenAI and reported that nothing happened; nothing visible
     * had. The approved prototype (`design/prototypes/onboarding-summariser.html`) solves it by
     * scrolling the chosen option to the top of the list rather than by moving the field.
     */
    const chosenRef = useRef<HTMLButtonElement | null>(null);
    const keyRef = useRef<HTMLInputElement | null>(null);

    // Scroll the chosen option to the top of whatever is scrolling, then put the caret in the field.
    // Not `scrollIntoView` on the field: that scrolls the minimum distance, which on a short window
    // leaves the option itself out of view and the person still cannot see what they chose.
    useEffect(() => {
        if (!needsKey) return;
        const option = chosenRef.current;
        if (!option) return;
        let scroller: HTMLElement | null = option.parentElement;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
        if (scroller) {
            scroller.scrollTop = Math.max(0, option.offsetTop - scroller.offsetTop - 12);
            // The option at the top is the prototype's intent, but at the minimum window the option and
            // its field together are taller than what is left: measured, the field still ended at 536px
            // in a 520px viewport. So if it still overhangs, take up exactly the overhang -- the option
            // slides up by that much and both are visible, which is the point of either rule.
            const over = keyRef.current
                ? keyRef.current.getBoundingClientRect().bottom - window.innerHeight
                : 0;
            if (over > 0) scroller.scrollTop += over + 12;
        }
        keyRef.current?.focus({ preventScroll: true });
    }, [needsKey, summaryProvider]);

    const pick = (option: Option) => {
        setSummaryProvider(option.id);
        setSelectedSummaryModel(
            option.id === 'builtin-ai' ? recommendedSummaryModel || option.defaultModel : option.defaultModel
        );
    };

    const onContinue = async () => {
        setSaving(true);
        try {
            // `api_save_model_config` writes the provider, the model and the key together — the key
            // path already existed and is registered; #111 v3 said it did not.
            await invoke('api_save_model_config', {
                provider: chosen.id,
                model: chosen.defaultModel,
                whisperModel: 'large-v3',
                apiKey: needsKey ? apiKey.trim() : '',
            });
        } catch (error) {
            console.error('[SummariserStep] Could not save the summariser choice:', error);
        } finally {
            setSaving(false);
            goNext();
        }
    };

    return (
        <OnboardingContainer
            title="Choose a summariser"
            description="This one writes the summary when a meeting ends. It is the only choice here that can send anything off this machine."
            step={2}
        >
            <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
                <div className="flex flex-col gap-2">
                    {OPTIONS.map((option) => {
                        const selected = option.id === summaryProvider;
                        return (
                            <button
                                key={option.id}
                                ref={selected ? chosenRef : undefined}
                                type="button"
                                onClick={() => pick(option)}
                                aria-pressed={selected}
                                className={cn(
                                    'flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors duration-fast',
                                    selected
                                        ? 'border-brand bg-brand-soft'
                                        : 'border-line bg-elevated hover:border-line-strong'
                                )}
                            >
                                <span className="flex w-full items-baseline justify-between gap-3">
                                    <span className="text-md font-medium text-ink">{option.name}</span>
                                    {option.mib && (
                                        <span className="readout shrink-0 text-2xs text-ink-faint">
                                            {option.mib} MiB to download
                                        </span>
                                    )}
                                </span>
                                <span className="text-base leading-relaxed text-ink-muted">
                                    {option.where}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {needsKey && (
                    <label className="flex flex-col gap-1.5">
                        <span className="text-base text-ink-muted">
                            API key for {chosen.name}. It is stored on this machine.
                        </span>
                        <Input
                            ref={keyRef}
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="Paste your key"
                            aria-label={`API key for ${chosen.name}`}
                        />
                    </label>
                )}

                <p className="text-base leading-relaxed text-ink-muted">
                    Works offline either way: transcription runs on this machine whatever you choose
                    here. Nothing else leaves — there is no telemetry and no analytics.
                </p>

                <Button onClick={onContinue} className="h-11 w-full" disabled={!canContinue || saving}>
                    {saving ? 'Saving…' : 'Continue'}
                </Button>
            </div>
        </OnboardingContainer>
    );
}

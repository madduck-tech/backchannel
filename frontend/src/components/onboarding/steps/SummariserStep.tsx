'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding, SUMMARISER_IDS } from '@/contexts/OnboardingContext';
import { cn } from '@/lib/utils';

/**
 * Where the summary is written, and where the words go to get there.
 *
 * **This is `design/prototypes/onboarding-summariser-agents.html`**, variant C, which the product
 * owner approved on 2026-10-25 (#212) on top of `c-inline-scroll` (approved 2026-09-08). Every
 * decision below is read out of that file rather than invented here: seven options in two named
 * groups, the key field opening *inside* the chosen option, an eighth option, "An agent on this
 * machine", that opens the agent CLIs found inside it, and a footer that says what the choice costs
 * and never leaves the window.
 *
 * The claims that used to open first run live on the options that make each one true or false.
 * "Your data never leaves your device" was an absolute on screen one, and a minute later a person
 * could pick a provider that sends whole transcripts to a third party with nothing saying so. Five
 * of the seven do.
 */

type Option = {
    /** One of the ids a resumed first run may restore (#172): an option the list lacks does not type-check. */
    id: (typeof SUMMARISER_IDS)[number];
    name: string;
    /** Where the words go. Local options describe the machine; remote ones name the recipient. */
    where?: string;
    dest?: string;
    /** What choosing it costs, for the two that run here. */
    cost?: string;
    local?: boolean;
    /** `custom-openai` needs an address as well as a key. */
    url?: boolean;
    defaultModel: string;
};

/** The seven, in the approved order: what runs here first, what leaves second. */
const OPTIONS: Option[] = [
    {
        id: 'builtin-ai',
        name: 'Built-in model',
        where: 'Runs on this machine. Nothing leaves it.',
        cost: 'adds a 3651 MiB download',
        local: true,
        defaultModel: 'gemma4:e2b',
    },
    {
        id: 'ollama',
        name: 'Ollama',
        where: 'Uses the Ollama you already run on this machine. Nothing leaves it.',
        cost: 'no download',
        local: true,
        defaultModel: 'llama3.2',
    },
    { id: 'claude', name: 'Claude', dest: 'Anthropic', defaultModel: 'claude-sonnet-4-5-20250929' },
    { id: 'openai', name: 'OpenAI', dest: 'OpenAI', defaultModel: 'gpt-4o' },
    { id: 'groq', name: 'Groq', dest: 'Groq', defaultModel: 'llama-3.3-70b-versatile' },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        dest: 'OpenRouter, which passes it to the host of the model you pick there',
        defaultModel: 'anthropic/claude-sonnet-4.5',
    },
    {
        id: 'custom-openai',
        name: 'An OpenAI-compatible server',
        dest: 'the server address you enter',
        url: true,
        defaultModel: 'gpt-4o',
    },
];

/** An agent CLI the person already has (#212): found by the backend, run under their own login. */
type Agent = {
    id: Extract<(typeof SUMMARISER_IDS)[number], 'claude-code' | 'codex'>;
    name: string;
    cli: string;
    vendor: string;
    /** Run with the person's own config ignored, so the caption says where it really goes. */
    isolated?: boolean;
};

/** What `agent_cli_status` reports for one CLI. */
type AgentStatus = { id: string; found: string | null; loggedIn: boolean | null };

/** The two the product owner kept (opencode waits for a mode without tools), in the approved order. */
const AGENTS: Agent[] = [
    { id: 'claude-code', name: 'Claude Code', cli: 'claude', vendor: 'Anthropic' },
    { id: 'codex', name: 'Codex', cli: 'codex', vendor: 'OpenAI', isolated: true },
];

/** The prototype's `caption`, word for word. */
const agentCaption = (a: Agent) =>
    a.isolated
        ? `Uses your ${a.name} login. The transcript is sent to ${a.vendor} with ${a.name}'s default model. It runs with its tools off.`
        : `Uses your ${a.name} login. The transcript goes to the provider ${a.name} is set up for, ${a.vendor} by default.`;

/** Found and logged in: the only state that can be chosen. Unknown login (`null`) counts as usable. */
const usable = (s: AgentStatus | undefined) => !!s?.found && s.loggedIn !== false;

/** The options' ids, in order, for the test that holds `SUMMARISER_IDS` equal to them (#172). */
export const OFFERED_SUMMARISERS = [...OPTIONS.map((o) => o.id), ...AGENTS.map((a) => a.id)];

export function SummariserStep() {
    const {
        goNext,
        summaryProvider,
        setSummaryProvider,
        setSelectedSummaryModel,
        recommendedSummaryModel,
    } = useOnboarding();
    const [apiKey, setApiKey] = useState('');
    const [serverUrl, setServerUrl] = useState('');
    const [saving, setSaving] = useState(false);
    /** Whether the agent option is open: chosen, or opened before a CLI in it is. */
    const [agentOpen, setAgentOpen] = useState(false);
    /** `null` while the backend is still looking (it asks the login shell for its PATH). */
    const [statuses, setStatuses] = useState<AgentStatus[] | null>(null);

    // Asked only once the agent option is open (or already chosen, on a resumed first run): looking
    // runs the person's login shell and both CLIs' login checks, which nobody who never opens the
    // option should pay for (#212 round 2).
    const wantStatus = agentOpen || AGENTS.some((a) => a.id === summaryProvider);
    useEffect(() => {
        if (!wantStatus) return;
        let alive = true;
        invoke<AgentStatus[]>('agent_cli_status')
            .then((s) => alive && setStatuses(s ?? []))
            .catch((e) => {
                console.error('[SummariserStep] Could not look for agent CLIs:', e);
                if (alive) setStatuses([]);
            });
        return () => {
            alive = false;
        };
    }, [wantStatus]);

    const chosen = OPTIONS.find((o) => o.id === summaryProvider) ?? null;
    const chosenAgent = AGENTS.find((a) => a.id === summaryProvider) ?? null;
    const statusOf = (a: Agent) => statuses?.find((s) => s.id === a.id);
    const needsKey = !!chosen && !chosen.local;
    /** The prototype's `ready()`, verbatim in meaning: a key, and an address where one is asked for; or
     *  an agent CLI that was found and is logged in. */
    const ready = chosenAgent
        ? usable(statusOf(chosenAgent))
        : !!chosen && (!!chosen.local || (apiKey.trim().length > 0 && (!chosen.url || serverUrl.trim().length > 0)));

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const chosenRef = useRef<HTMLDivElement | null>(null);
    const keyRef = useRef<HTMLInputElement | null>(null);

    /**
     * Bring the chosen option to the top of the scrolling region, then focus its key field.
     *
     * `sc.scrollTop = Math.max(0, o.offsetTop - 12)` is the prototype's line. `scrollIntoView` is
     * what this replaced and it is not the same: it moves the minimum distance, which at the
     * application's minimum window -- 720x520 per `tauri.conf.json` -- left the option itself out of
     * view while its field arrived. The product owner picked OpenAI and reported that nothing
     * happened; nothing visible had.
     */
    useEffect(() => {
        if (!needsKey) return;
        const sc = scrollRef.current;
        const opt = chosenRef.current;
        if (sc && opt) sc.scrollTop = Math.max(0, opt.offsetTop - 12);
        keyRef.current?.focus({ preventScroll: true });
    }, [needsKey, summaryProvider]);

    const pickAgent = (a: Agent) => {
        if (!usable(statusOf(a))) return;
        setSummaryProvider(a.id);
        setApiKey('');
        setServerUrl('');
        // The CLI's own default model (the product owner's decision): nothing is chosen here.
        setSelectedSummaryModel('');
    };

    const pick = (option: Option) => {
        setAgentOpen(false);
        setSummaryProvider(option.id);
        setApiKey('');
        setServerUrl('');
        setSelectedSummaryModel(
            option.id === 'builtin-ai' ? recommendedSummaryModel || option.defaultModel : option.defaultModel
        );
    };

    const onContinue = async () => {
        if (!chosen && !chosenAgent) return;
        setSaving(true);
        try {
            if (chosenAgent) {
                await invoke('api_save_model_config', {
                    provider: chosenAgent.id,
                    model: '',
                    whisperModel: 'large-v3',
                    apiKey: '',
                });
                return;
            }
            if (!chosen) return;
            if (chosen.url) {
                await invoke('api_save_custom_openai_config', {
                    endpoint: serverUrl.trim(),
                    apiKey: apiKey.trim() || null,
                    model: chosen.defaultModel,
                    maxTokens: null,
                    temperature: null,
                    topP: null,
                });
            }
            // `api_save_model_config` writes the provider, the model and the key together.
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

    /** The footer's readout, from the prototype's `[data-read]`. */
    const readout = chosenAgent ? (
        <>
            <b className="font-medium text-ink">{chosenAgent.name}</b>:{' '}
            {chosenAgent.isolated
                ? `transcripts go to ${chosenAgent.vendor}.`
                : `transcripts go to the provider ${chosenAgent.name} is set up for.`}
        </>
    ) : agentOpen ? (
        'Choose which agent writes the summary.'
    ) : !chosen ? (
        'Choose where the summary is written.'
    ) : chosen.local ? (
        <>
            <b className="font-medium text-ink">{chosen.name}</b>: nothing leaves this machine.
        </>
    ) : ready ? (
        <>
            <b className="font-medium text-ink">{chosen.name}</b>: transcripts go to {chosen.dest}.
        </>
    ) : (
        <>
            <b className="font-medium text-ink">{chosen.name}</b> needs an API key; the field is in the
            option above.
        </>
    );

    const groups: Array<{ label: string; options: Option[] }> = [
        { label: 'ON THIS MACHINE', options: OPTIONS.filter((o) => o.local) },
        { label: 'SENT TO A PROVIDER', options: OPTIONS.filter((o) => !o.local) },
    ];

    /** The prototype's `pathLine`: found; found but not logged in; not found; or still looking. */
    const agentState = (a: Agent) => {
        const st = statusOf(a);
        if (statuses === null) return <p className="mt-0.5 font-mono text-xs text-ink-faint">Looking on this machine…</p>;
        if (!st?.found)
            return (
                <p className="mt-0.5 font-mono text-xs text-ink">
                    Not found in your shell&apos;s PATH. Install {a.cli}, then reopen this step.
                </p>
            );
        if (st.loggedIn === false)
            return (
                <p className="mt-0.5 font-mono text-xs text-ink">
                    Found, but not logged in. Run {a.cli} once in a terminal to log in, then reopen this step.
                </p>
            );
        return <p className="mt-0.5 font-mono text-xs text-ink-faint">Found: {st.found}</p>;
    };

    /** "An agent on this machine": one option that opens the CLIs inside it (variant C). */
    const agentOption = () => {
        const open = agentOpen || !!chosenAgent;
        return (
            <div
                ref={open ? chosenRef : undefined}
                role="radio"
                aria-checked={open}
                tabIndex={0}
                onClick={(e) => {
                    if ((e.target as HTMLElement).closest('[data-agent]')) return;
                    setAgentOpen(true);
                    // Opened with no CLI chosen yet: nothing is chosen, so Continue waits for one.
                    if (!chosenAgent) setSummaryProvider('');
                }}
                onKeyDown={(e) => {
                    if ((e.key === ' ' || e.key === 'Enter') && !(e.target as HTMLElement).closest('[data-agent]')) {
                        e.preventDefault();
                        setAgentOpen(true);
                        if (!chosenAgent) setSummaryProvider('');
                    }
                }}
                className={cn(
                    'grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 rounded-md border bg-elevated px-3.5 py-2.5',
                    open ? 'border-brand-soft-ink' : 'border-line hover:border-ink'
                )}
            >
                <span
                    aria-hidden
                    className={cn(
                        'mt-0.5 h-4 w-4 rounded-full border',
                        open ? 'border-[5px] border-brand-soft-ink' : 'border-line-strong'
                    )}
                />
                <span>
                    <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 font-medium text-ink">
                        An agent on this machine
                        <span className="font-mono text-xs font-normal text-ink-faint">
                            {AGENTS.map((a) => a.cli).join(' · ')}
                        </span>
                    </span>
                    <p className="mt-px text-sm leading-[19px] text-ink-faint">
                        Uses an agent CLI you are already logged in to. No API key. The transcript goes to that
                        agent&apos;s provider.
                    </p>
                    {open && (
                        <div role="radiogroup" aria-label="Agent" className="mt-2.5 grid gap-1.5">
                            {AGENTS.map((a) => {
                                const can = usable(statusOf(a));
                                const on = summaryProvider === a.id;
                                return (
                                    <div
                                        key={a.id}
                                        data-agent={a.id}
                                        role="radio"
                                        aria-checked={on}
                                        aria-disabled={!can}
                                        tabIndex={can ? 0 : -1}
                                        onClick={() => pickAgent(a)}
                                        onKeyDown={(e) => {
                                            if (e.key === ' ' || e.key === 'Enter') {
                                                e.preventDefault();
                                                pickAgent(a);
                                            }
                                        }}
                                        className={cn(
                                            'grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2.5 rounded-md border bg-canvas px-2.5 py-2',
                                            on ? 'border-brand-soft-ink' : 'border-line',
                                            can ? 'cursor-pointer' : 'cursor-default opacity-55'
                                        )}
                                    >
                                        <span
                                            aria-hidden
                                            className={cn(
                                                'mt-0.5 h-4 w-4 rounded-full border',
                                                on ? 'border-[5px] border-brand-soft-ink' : 'border-line-strong'
                                            )}
                                        />
                                        <span>
                                            <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 font-medium text-ink">
                                                {a.name}
                                                <span className="font-mono text-xs font-normal text-ink-faint">{a.cli}</span>
                                            </span>
                                            <p className="mt-px text-sm leading-[19px] text-ink-faint">{agentCaption(a)}</p>
                                            {agentState(a)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </span>
            </div>
        );
    };

    return (
        <OnboardingContainer
            title="Where should the summary be written?"
            description="Eight choices. Each says where your transcripts go. The agent option opens the CLIs it found inside it."
            step={2}
            scrollRef={scrollRef}
            footer={
                <>
                    <span className="min-w-0 flex-1 text-xs leading-[17px] text-ink-faint">{readout}</span>
                    <Button onClick={onContinue} disabled={!ready || saving} className="h-8 shrink-0 px-4">
                        {saving ? 'Saving…' : 'Continue'}
                    </Button>
                </>
            }
        >
            <div role="radiogroup" aria-label="Summariser" className="mt-5 grid gap-1.5">
                {groups.map((group) => (
                    <div key={group.label} className="contents">
                        <div className="mt-[18px] mb-1.5 font-mono text-2xs text-ink-faint first:mt-0">
                            {group.label}
                        </div>
                        {group.options.map((option) => {
                            const selected = option.id === summaryProvider;
                            return (
                                <div
                                    key={option.id}
                                    ref={selected ? chosenRef : undefined}
                                    role="radio"
                                    aria-checked={selected}
                                    tabIndex={0}
                                    onClick={(e) => {
                                        if ((e.target as HTMLElement).closest('input')) return;
                                        pick(option);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === ' ' || e.key === 'Enter') {
                                            e.preventDefault();
                                            pick(option);
                                        }
                                    }}
                                    className={cn(
                                        'grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 rounded-md border bg-elevated px-3.5 py-2.5',
                                        selected ? 'border-brand-soft-ink' : 'border-line hover:border-ink'
                                    )}
                                >
                                    <span
                                        aria-hidden
                                        className={cn(
                                            'mt-0.5 h-4 w-4 rounded-full border',
                                            selected ? 'border-[5px] border-brand-soft-ink' : 'border-line-strong'
                                        )}
                                    />
                                    <span>
                                        <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 font-medium text-ink">
                                            {option.name}
                                            <span className="font-mono text-xs font-normal text-ink-faint">
                                                {option.id}
                                            </span>
                                        </span>
                                        <p
                                            className={cn(
                                                'mt-px text-sm leading-[19px]',
                                                option.local ? 'text-ink' : 'text-ink-faint'
                                            )}
                                        >
                                            {option.local
                                                ? option.where
                                                : `Sends each transcript to ${option.dest}. Needs an API key.`}
                                        </p>
                                        {option.local && (
                                            <p className="mt-px text-sm leading-[19px] text-ink-faint">
                                                {option.cost}
                                            </p>
                                        )}

                                        {/* The key field lives **inside** the option, which is what
                                            `c-inline-scroll` is. Below the list is where it was, and
                                            where it was below the fold. */}
                                        {selected && needsKey && (
                                            <div className="mt-2.5 grid gap-1.5">
                                                {option.url && (
                                                    <>
                                                        <label
                                                            htmlFor="summariser-url"
                                                            className="text-xs text-ink-faint"
                                                        >
                                                            Server address
                                                        </label>
                                                        <input
                                                            id="summariser-url"
                                                            type="url"
                                                            value={serverUrl}
                                                            onChange={(e) => setServerUrl(e.target.value)}
                                                            placeholder="https://"
                                                            className="h-9 rounded-md border border-line-strong bg-sunken px-2.5 text-sm text-ink outline-none focus:border-brand-soft-ink"
                                                        />
                                                    </>
                                                )}
                                                <label htmlFor="summariser-key" className="text-xs text-ink-faint">
                                                    API key for {option.name}
                                                </label>
                                                <input
                                                    id="summariser-key"
                                                    ref={keyRef}
                                                    type="password"
                                                    autoComplete="off"
                                                    value={apiKey}
                                                    onChange={(e) => setApiKey(e.target.value)}
                                                    placeholder="Paste the key"
                                                    aria-label={`API key for ${option.name}`}
                                                    className="h-9 rounded-md border border-line-strong bg-sunken px-2.5 text-sm text-ink outline-none focus:border-brand-soft-ink"
                                                />
                                            </div>
                                        )}
                                    </span>
                                </div>
                            );
                        })}
                        {group.label === 'SENT TO A PROVIDER' && agentOption()}
                    </div>
                ))}
            </div>
        </OnboardingContainer>
    );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { cn } from '@/lib/utils';

/**
 * Prove the two capture devices before a meeting depends on them.
 *
 * **A level meter is not proof.** It moves for any device that is delivering samples, and #10 is the
 * case where eleven inputs share one display name — a meter confirms something is open, not that it
 * is the thing the user picked. **Text is proof**: words come back only if the device carrying the
 * speech is the one being read.
 *
 * The system side needs no second participant. The application plays a short tone through the
 * default output and the system device should hear it — a check that is self-contained, and one that
 * fails loudly if the user picked an input that is not a monitor of their speakers.
 *
 * Offered, not mandatory. `recording_commands.rs:341-354` falls back to `default_output_device()`
 * when no preference is stored, so skipping this does not leave the app unable to record.
 */

type Device = { name: string; device_type: 'Input' | 'Output' };
type CheckResult = { device: string; heard_audio: boolean; text: string };
type State = { status: 'idle' | 'listening' | 'done' | 'error'; result?: CheckResult; error?: string };

export function AudioCheckStep() {
    const { goNext } = useOnboarding();
    const [devices, setDevices] = useState<Device[]>([]);
    const [mic, setMic] = useState('');
    const [speakers, setSpeakers] = useState('');
    const [micState, setMicState] = useState<State>({ status: 'idle' });
    const [sysState, setSysState] = useState<State>({ status: 'idle' });

    useEffect(() => {
        invoke<Device[]>('get_audio_devices')
            .then((list) => {
                setDevices(list);
                setMic((prev) => prev || list.find((d) => d.device_type === 'Input')?.name || '');
                setSpeakers((prev) => prev || list.find((d) => d.device_type === 'Output')?.name || '');
            })
            .catch((error) => console.error('[AudioCheckStep] Could not list devices:', error));
    }, []);

    const check = useCallback(
        async (name: string, system: boolean, set: (s: State) => void) => {
            if (!name) return;
            set({ status: 'listening' });
            try {
                const result = await invoke<CheckResult>('check_capture_device', { name, system });
                set({ status: 'done', result });
            } catch (error) {
                set({ status: 'error', error: String(error) });
            }
        },
        []
    );

    /**
     * A tone the system device should hear, played through the default output.
     *
     * Web Audio rather than cpal: the Rust side has no playback path at all
     * (`grep -rn build_output_stream src-tauri/src` is empty), and a tone needs none.
     */
    const playTone = useCallback(async () => {
        const AudioCtx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        // Guarded rather than assumed. Without it the whole check dies where Web Audio is absent,
        // and the listening half -- which is the half that proves anything -- would never run.
        if (typeof AudioCtx !== 'function') {
            console.warn('[AudioCheckStep] No Web Audio here; listening without playing a tone.');
            await new Promise((r) => setTimeout(r, 2500));
            return;
        }
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        await new Promise((r) => setTimeout(r, 2500));
        osc.stop();
        await ctx.close();
    }, []);

    const inputs = devices.filter((d) => d.device_type === 'Input');
    const outputs = devices.filter((d) => d.device_type === 'Output');

    return (
        <OnboardingContainer
            title="Check your audio"
            description="Two devices carry a meeting: your microphone, and whatever the other side is heard through. This proves each one with words, not a moving bar."
            step={4}
        >
            <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
                <Row
                    label="Microphone"
                    hint="Press check and say a sentence. The words come back only if this is the device that heard you."
                    devices={inputs}
                    value={mic}
                    onChange={setMic}
                    state={micState}
                    action="Check by speaking"
                    onCheck={() => check(mic, false, setMicState)}
                />

                <Row
                    label="The other side is heard through"
                    hint="The app plays a tone through your speakers. This device should hear it — if it cannot, it is not a monitor of your output."
                    devices={outputs}
                    value={speakers}
                    onChange={setSpeakers}
                    state={sysState}
                    action="Play a tone and listen"
                    onCheck={async () => {
                        const checking = check(speakers, true, setSysState);
                        await playTone();
                        await checking;
                    }}
                />

                <div className="flex items-center gap-3">
                    <Button onClick={goNext} className="h-11 flex-1">
                        Continue
                    </Button>
                    <Button variant="ghost" onClick={goNext} className="h-11">
                        Skip this
                    </Button>
                </div>
                <p className="text-base leading-relaxed text-ink-muted">
                    Skipping is safe: if you set nothing here the app uses your system defaults.
                </p>
            </div>
        </OnboardingContainer>
    );
}

function Row({
    label,
    hint,
    devices,
    value,
    onChange,
    state,
    action,
    onCheck,
}: {
    label: string;
    hint: string;
    devices: Device[];
    value: string;
    onChange: (v: string) => void;
    state: State;
    action: string;
    onCheck: () => void;
}) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-elevated p-3">
            <span className="text-md font-medium text-ink">{label}</span>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger aria-label={label}>
                    <SelectValue placeholder="No device found" />
                </SelectTrigger>
                <SelectContent>
                    {devices.map((d) => (
                        <SelectItem key={d.name} value={d.name}>
                            {d.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <p className="text-base leading-relaxed text-ink-muted">{hint}</p>
            <div className="flex items-center gap-3">
                <Button
                    size="sm"
                    variant="outline"
                    onClick={onCheck}
                    disabled={!value || state.status === 'listening'}
                >
                    {state.status === 'listening' ? 'Listening…' : action}
                </Button>
                <Outcome state={state} />
            </div>
        </div>
    );
}

/** What the check found, said plainly enough to act on. */
function Outcome({ state }: { state: State }) {
    if (state.status === 'error') {
        return <span className="text-base text-danger-ink">{state.error}</span>;
    }
    if (state.status !== 'done' || !state.result) return null;

    const { heard_audio: heard, text } = state.result;
    if (!heard) {
        return (
            <span className="text-base text-warn-ink">
                Nothing arrived. This device is open but silent — pick another.
            </span>
        );
    }
    if (!text) {
        return (
            <span className="text-base text-warn-ink">
                Audio arrived, but nothing came back as words.
            </span>
        );
    }
    return (
        <span className={cn('text-base text-ink')}>
            Heard: <b className="font-medium">{text}</b>
        </span>
    );
}

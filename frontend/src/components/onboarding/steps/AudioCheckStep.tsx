'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
/**
 * `loading` is its own state rather than a silent wait inside `listening`: a model can take seconds
 * to reach memory, and a button reading *Listening…* while nothing listens is the same lie as a level
 * meter that moves for a silent device (#168).
 */
type State = { status: 'idle' | 'loading' | 'listening' | 'done' | 'error'; result?: CheckResult; error?: string };

/** A tone whose context never reached `running`, so nothing played (#173). Its message is the reason
 * the row gives; any other failure keeps `String(error)`, as #168 wrote it. */
class ToneNeverStarted extends Error {}

/** The context could not be made. Carries what was thrown, untouched: wrapping it in a new `Error`
 * turned a DOMException's "NotSupportedError: …" into "Error: NotSupportedError: …" wherever the
 * thrown value came from another realm, which is every test. */
class ToneContextFailed {
    constructor(readonly thrown: unknown) {}
}

export function AudioCheckStep() {
    const { goNext, completeOnboarding, selectedTranscribeModel } = useOnboarding();
    const [isMac, setIsMac] = useState(false);
    /** One press, one completion. Without it a second click starts a second `completeOnboarding`. */
    const [finishing, setFinishing] = useState(false);
    const [devices, setDevices] = useState<Device[]>([]);
    const [mic, setMic] = useState('');
    const [speakers, setSpeakers] = useState('');
    const [micState, setMicState] = useState<State>({ status: 'idle' });
    const [sysState, setSysState] = useState<State>({ status: 'idle' });

    useEffect(() => {
        (async () => {
            try {
                const { platform } = await import('@tauri-apps/plugin-os');
                setIsMac(platform() === 'macos');
            } catch {
                setIsMac(navigator.userAgent.includes('Mac'));
            }
        })();
    }, []);

    /**
     * On macOS the next step is Permissions, which finishes onboarding itself. Everywhere else this
     * **is** the last step, so it finishes here — `goNext()` would land on step 5, which renders
     * nothing off macOS, and the person would sit on a blank screen.
     */
    const done = async () => {
        if (isMac) { goNext(); return; }
        if (finishing) return;
        setFinishing(true);
        try {
            await completeOnboarding();
            await new Promise((r) => setTimeout(r, 100));
            window.location.reload();
        } catch (error) {
            // The button comes back. A new user left on a dead control is the worst thing this
            // screen can do, and it is the last one before the application itself.
            console.error('[AudioCheckStep] Could not complete onboarding:', error);
            setFinishing(false);
        }
    };

    useEffect(() => {
        invoke<Device[]>('get_audio_devices')
            .then((list) => {
                setDevices(list);
                setMic((prev) => prev || list.find((d) => d.device_type === 'Input')?.name || '');
                setSpeakers((prev) => prev || list.find((d) => d.device_type === 'Output')?.name || '');
            })
            .catch((error) => console.error('[AudioCheckStep] Could not list devices:', error));
    }, []);

    /**
     * One check at a time, across both rows: they share one engine. Two quick presses used to open
     * the device twice, and pressing the other row while a model loaded started a second load of the
     * same model (#168). The ref stops the second press within the same tick; the state disables both
     * buttons once React renders.
     */
    const busy = useRef(false);
    const [checking, setChecking] = useState(false);

    /**
     * `alongside` runs once the device is being opened: the system row's tone. It used to start
     * before this function had loaded the model, so a load longer than the 2.5 s tone left the
     * device listening to silence (#168).
     */
    const check = useCallback(
        async (name: string, system: boolean, set: (s: State) => void, alongside?: () => Promise<void>) => {
            if (!name || busy.current) return;
            busy.current = true;
            setChecking(true);
            try {
                // Words need a model in memory, and nothing puts one there during first run: the
                // only preload is the call detector's (`call_detector.rs:225`), on a meeting
                // application launching. So every press used to answer `Could not transcribe what
                // <device> heard: No model loaded` (#168). Both sides decode: the tone is heard
                // audio too.
                //
                // **The model chosen two screens earlier, by name.** Not the readiness path
                // (`transcribe_validate_model_ready`): it resolves the model from
                // `transcript_settings`, which first run writes only in `completeOnboarding`, so here
                // it would load `DEFAULT_TRANSCRIBE_MODEL` for someone who chose another.
                if ((await invoke<string | null>('transcribe_get_current_model')) !== selectedTranscribeModel) {
                    set({ status: 'loading' });
                    await invoke('transcribe_load_model', { modelName: selectedTranscribeModel });
                }
                set({ status: 'listening' });
                // `allSettled`, not `all`: a tone that fails must not end this function while the
                // device is still listening, or the guard lets a second check start beside the first.
                const [capture, tone] = await Promise.allSettled([
                    invoke<CheckResult>('check_capture_device', { name, system }),
                    alongside ? alongside() : Promise.resolve(),
                ]);
                if (capture.status === 'rejected') throw capture.reason;
                if (tone.status === 'rejected') {
                    // The device result would read "nothing arrived, pick another", which blames a
                    // device that was never given anything to hear.
                    const why = tone.reason instanceof ToneNeverStarted ? tone.reason.message : String(tone.reason);
                    set({ status: 'error', error: `The tone could not play, so there was nothing to hear: ${why}` });
                    return;
                }
                set({ status: 'done', result: capture.value });
            } catch (error) {
                set({ status: 'error', error: String(error) });
            } finally {
                busy.current = false;
                setChecking(false);
            }
        },
        [selectedTranscribeModel]
    );

    /**
     * A tone the system device should hear, played through the default output.
     *
     * Web Audio rather than cpal: the Rust side has no playback path at all
     * (`grep -rn build_output_stream src-tauri/src` is empty), and a tone needs none.
     */
    /**
     * The tone's audio context, made **inside the click**, before anything is awaited. A webview may
     * start audio only from a user gesture, and the tone now plays after the model has loaded, which
     * is no longer inside the gesture (#168). `null` where there is no Web Audio at all.
     */
    const openToneContext = (): AudioContext | ToneContextFailed | null => {
        const AudioCtx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (typeof AudioCtx !== 'function') return null;
        try {
            return new AudioCtx();
        } catch (error) {
            return new ToneContextFailed(error);
        }
    };

    const playTone = useCallback(async (ctx: AudioContext | ToneContextFailed | null) => {
        if (ctx instanceof ToneContextFailed) throw ctx.thrown;
        // Guarded rather than assumed. Without it the whole check dies where Web Audio is absent,
        // and the listening half -- which is the half that proves anything -- would never run.
        if (!ctx) {
            console.warn('[AudioCheckStep] No Web Audio here; listening without playing a tone.');
            await new Promise((r) => setTimeout(r, 2500));
            return;
        }
        // Not awaited. A context the webview will not start leaves `resume()` pending forever, and
        // awaiting it held both rows shut until a reload (the gate's adversary, round 3). Made in the
        // click, the context normally runs; if it does not, the row names the tone (below).
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        await new Promise((r) => setTimeout(r, 2500));
        osc.stop();
        // Read after the tone and before closing: a context starts `suspended` and reaches `running`
        // only once its output starts, so a read any earlier calls every working tone a failure. One
        // that never got there played nothing. Until #173 that was every tone in the AppImage, where
        // WebKit found no audio sink, and the row told the person their device was silent. Compared
        // with `running`, not against `suspended`: `interrupted` played nothing either.
        const ran = ctx.state === 'running';
        await ctx.close();
        if (!ran) throw new ToneNeverStarted('the audio output never started');
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
                    busy={checking}
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
                    busy={checking}
                    onCheck={() => {
                        if (busy.current || !speakers) return;
                        const ctx = openToneContext();
                        // Closed on every path, not only after a tone that played: a load that fails
                        // never reaches the tone, and each open context holds an output stream.
                        void check(speakers, true, setSysState, () => playTone(ctx)).finally(() => {
                            if (ctx && !(ctx instanceof ToneContextFailed) && ctx.state !== 'closed') {
                                void ctx.close().catch(() => undefined);
                            }
                        });
                    }}
                />

                <div className="flex items-center gap-3">
                    <Button onClick={done} disabled={finishing} className="h-11 flex-1">
                        Continue
                    </Button>
                    <Button variant="ghost" onClick={done} disabled={finishing} className="h-11">
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
    busy,
    onCheck,
}: {
    label: string;
    hint: string;
    devices: Device[];
    value: string;
    onChange: (v: string) => void;
    state: State;
    action: string;
    /** A check is running on either row; they share one engine. */
    busy: boolean;
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
                    disabled={!value || busy || state.status === 'listening' || state.status === 'loading'}
                >
                    {state.status === 'loading' ? 'Loading the model…'
                        : state.status === 'listening' ? 'Listening…' : action}
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

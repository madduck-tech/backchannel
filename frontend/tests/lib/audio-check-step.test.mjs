// A device is proven by words, not by a moving bar.
//
// #111 cycle C. The first run showed a new user no devices at all, and the first evidence that
// either one worked arrived in the middle of a real meeting.
//
// **Why not a level meter.** It moves for any device delivering samples, and #10 is the case where
// eleven inputs share one display name — a meter confirms *something* is open, not that it is the
// thing the user selected. Text is proof: words come back only if the device carrying the speech is
// the one being read.
//
// **Why a tone for the system side.** It makes the check self-contained: no second participant, and
// it fails loudly when the user picked an input that is not a monitor of their own output.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 900, height: 700 });
const { loadTsx } = await import('./render-tsx.mjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');  // frontend/

const DEVICES = [
  { name: 'Built-in Microphone', device_type: 'Input' },
  { name: 'Headset Microphone', device_type: 'Input' },
  { name: 'Speakers Monitor', device_type: 'Output' },
];

// Not the default: a check that loads `DEFAULT_TRANSCRIBE_MODEL` for someone who chose another passes
// every assertion that takes the default (#168).
const CHOSEN = 'gigaam-v3-e2e-rnnt-q8';
const DEFAULT_MODEL = 'parakeet-tdt-0.6b-v3-q8';

async function render({ result, fail, failComplete = false, loaded = null, failLoad, holdLoad, holdCheck, toneFails, suspended, resumeRejects, startsOnResume, initialState } = {}) {
  const calls = [];
  // One timeline for IPC and the tone, so an ordering between them can be asserted.
  const events = [];
  const seen = { completed: 0, next: 0 };
  // What `TranscribeEngine` holds. Nothing during first run: no load path runs before this screen,
  // and `check_capture_device` decodes with whatever is there (#168).
  let inMemory = loaded;
  const { AudioCheckStep } = loadTsx('src/components/onboarding/steps/AudioCheckStep.tsx', {
    ...boundaryStubs().modules,
    '@/contexts/OnboardingContext': {
      useOnboarding: () => ({
        selectedTranscribeModel: CHOSEN,
        goNext: () => { seen.next += 1; },
        completeOnboarding: async () => {
          seen.completed += 1;
          if (failComplete) throw new Error('could not persist onboarding state');
        },
      }),
    },
    '../OnboardingContainer': {
      // Renders the footer too: #154 moved the primary control into it, and a children-only
      // passthrough hides it from every assertion in this file.
      OnboardingContainer: ({ children, footer }) =>
        React.createElement('div', null, children, React.createElement('footer', null, footer)),
    },
    '@tauri-apps/api/core': {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        events.push(cmd === 'check_capture_device' ? `check:${args.system ? 'system' : 'mic'}` : cmd);
        if (cmd === 'get_audio_devices') return DEVICES;
        if (cmd === 'transcribe_get_current_model') return inMemory;
        if (cmd === 'transcribe_load_model') {
          if (holdLoad) await holdLoad;
          if (failLoad) throw new Error(failLoad);
          inMemory = args.modelName;
          events.push('loaded');
          return null;
        }
        if (cmd === 'check_capture_device') {
          if (holdCheck) await holdCheck;
          if (fail) throw new Error(fail);
          // The engine's answer when nothing is in memory, which is what every press got (#168).
          if (!inMemory) throw new Error(`Could not transcribe what ${args.name} heard: No model loaded`);
          return result ?? { device: args.name, heard_audio: true, text: 'testing one two' };
        }
        return null;
      },
    },
  });
  // jsdom has no Web Audio. A minimal stand-in, so the tone path runs for real rather than being
  // skipped by the component's own guard — the guard is asserted separately by not installing this.
  const played = [];
  window.AudioContext = class {
    constructor() {
      events.push('ctx');
      // What WebKit throws: a DOMException, which is an Error in the page's realm (WebIDL).
      if (toneFails) throw new window.DOMException('no audio output', 'NotSupportedError');
      // A context the webview will not start: `resume()` stays pending, as the spec allows.
      this.state = initialState ?? (suspended ? 'suspended' : 'running');
    }
    // What WebKit does when it cannot build an audio sink: `resume()` rejects (`InvalidStateError`,
    // "Failed to start the audio device"). Pending is the other shape a context that never starts can
    // take; both leave the state `suspended` (#173). `startsOnResume` is a working webview: the state
    // turns `running` only once `resume()` settles, later than the click, as WebKit's does.
    resume() {
      if (startsOnResume) return new Promise((r) => setTimeout(() => { this.state = 'running'; r(); }, 50));
      return resumeRejects ? Promise.reject(new Error('InvalidStateError: Failed to start the audio device')) : new Promise(() => {});
    }
    createOscillator() {
      return {
        frequency: {},
        connect: (n) => n,
        start: () => { played.push('start'); events.push('tone'); },
        stop: () => played.push('stop'),
      };
    }
    createGain() {
      return { gain: {}, connect: () => this.destination };
    }
    get destination() { return {}; }
    async close() { this.state = 'closed'; events.push('close'); }
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(React.createElement(AudioCheckStep, null)); });
  return { container, calls, played, seen, events };
}

const buttons = (c) => [...c.querySelectorAll('button')];
const byText = (c, text) => buttons(c).find((b) => b.textContent.includes(text));
const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};

// --- 1: both devices are offered, each from its own half of the list -----------------------------
{
  const { container, calls } = await render();
  assert.ok(calls.some((c) => c.cmd === 'get_audio_devices'), 'the step must list the real devices');
  const labels = [...container.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
  assert.ok(labels.some((l) => /Microphone/i.test(l)), 'the microphone must have its own control');
  assert.ok(
    labels.some((l) => /other side/i.test(l)),
    'and so must the device the other side is heard through — two devices carry a meeting'
  );
}

// --- 2: the microphone is checked by capturing it, not by watching a meter -----------------------
{
  const { container, calls } = await render();
  await click(byText(container, 'Check by speaking'));
  const check = calls.find((c) => c.cmd === 'check_capture_device' && c.args.system === false);
  assert.ok(check, 'the microphone check must actually open the device');
  assert.equal(
    check.args.name,
    'Built-in Microphone',
    'and it must open the one that is selected, by name — #10 is eleven inputs sharing one label'
  );
  assert.match(
    container.textContent,
    /testing one two/,
    'the words it heard must be shown. That is the proof: a level meter moves for any device, and ' +
      'text comes back only from the one that carried the speech'
  );
}

// --- 3: the system side plays a tone and listens on the other device -----------------------------
{
  const { container, calls } = await render();
  await click(byText(container, 'Play a tone and listen'));
  const check = calls.find((c) => c.cmd === 'check_capture_device' && c.args.system === true);
  assert.ok(check, 'the system check must open the output monitor, not the microphone');
  assert.equal(check.args.name, 'Speakers Monitor');
  assert.equal(
    calls.filter((c) => c.cmd === 'check_capture_device').length,
    1,
    'and only that one — checking one device must not open the other'
  );
}

// --- 4: each failure says which one it is --------------------------------------------------------
{
  // Open but silent is a different problem from open and unintelligible, and both are different
  // from a device that would not open. A single "check failed" would leave the user guessing.
  const silent = await render({ result: { device: 'x', heard_audio: false, text: '' } });
  await click(byText(silent.container, 'Check by speaking'));
  assert.match(
    silent.container.textContent,
    /Nothing arrived/,
    'a device that delivers no audio must say so, and say the device is open'
  );

  const noWords = await render({ result: { device: 'x', heard_audio: true, text: '' } });
  await click(byText(noWords.container, 'Check by speaking'));
  assert.match(
    noWords.container.textContent,
    /nothing came back as words/,
    'audio without text is a different state and must read differently'
  );

  const refused = await render({ fail: 'A recording is in progress' });
  await click(byText(refused.container, 'Check by speaking'));
  assert.match(
    refused.container.textContent,
    /A recording is in progress/,
    "and the backend's own refusal must reach the user verbatim, not become a generic failure"
  );
}

// --- 4b: words need a model in memory, and it is the one the person chose (#168) ------------------
{
  // Nothing in memory: the chosen model is loaded by name, before the device is opened.
  const { container, calls } = await render();
  await click(byText(container, 'Check by speaking'));
  const order = calls.map((c) => c.cmd).filter((c) => c === 'transcribe_load_model' || c === 'check_capture_device');
  assert.deepEqual(order, ['transcribe_load_model', 'check_capture_device'], 'a model must be in memory before the check decodes');
  assert.equal(
    calls.find((c) => c.cmd === 'transcribe_load_model').args.modelName,
    CHOSEN,
    'and it must be the model chosen two screens earlier, by name. The readiness path resolves it from ' +
      '`transcript_settings`, which first run writes only at the end, so it would load the default'
  );
  assert.match(container.textContent, /testing one two/);
}
{
  // The default in memory, another chosen: the chosen one replaces it.
  const { calls } = await (async () => {
    const r = await render({ loaded: DEFAULT_MODEL });
    await click(byText(r.container, 'Check by speaking'));
    return r;
  })();
  assert.equal(calls.find((c) => c.cmd === 'transcribe_load_model')?.args.modelName, CHOSEN, 'a different model in memory is replaced');
}
{
  // Already the chosen one: nothing is loaded twice.
  const { container, calls } = await render({ loaded: CHOSEN });
  await click(byText(container, 'Check by speaking'));
  assert.ok(!calls.some((c) => c.cmd === 'transcribe_load_model'), 'the model already in memory is not loaded again');
  assert.match(container.textContent, /testing one two/);
}
{
  // While it loads, the button says so. *Listening…* while nothing listens is the moving-bar lie.
  let release;
  const holdLoad = new Promise((r) => { release = r; });
  const { container, calls } = await render({ holdLoad });
  const press = act(async () => {
    byText(container, 'Check by speaking').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await press;
  const busy = byText(container, 'Loading the model');
  assert.ok(busy, `the button must read "Loading the model…" while the model reaches memory: ${buttons(container).map((b) => b.textContent).join(' / ')}`);
  assert.equal(busy.disabled, true, 'and must not take a second press');
  assert.ok(!calls.some((c) => c.cmd === 'check_capture_device'), 'and no device is opened before the model is ready');
  await act(async () => { release(); await holdLoad; });
}
{
  // A load that fails is the outcome, verbatim, and the device is never opened.
  const { container, calls } = await render({ failLoad: "Model file not found: gigaam-v3-e2e-rnnt-Q8_0.gguf" });
  await click(byText(container, 'Check by speaking'));
  assert.match(container.textContent, /Model file not found/, 'a failed load must say what failed');
  assert.ok(!calls.some((c) => c.cmd === 'check_capture_device'), 'and must not go on to open the device');
  assert.equal(byText(container, 'Check by speaking').disabled, false, 'and the button comes back');
}

// --- 4c: one check at a time, and the tone plays while the device listens (#168) -----------------
//
// Found by the gate's adversary, and shown red on the previous version of this component: two quick
// presses opened the device twice, the other row could start a second load of the same model, and
// the tone, started before the model had loaded, could end before the device was opened.
{
  let release;
  const holdCheck = new Promise((r) => { release = r; });
  const { container, calls } = await render({ loaded: CHOSEN, holdCheck });
  const button = byText(container, 'Check by speaking');
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { release(); await holdCheck; });
  assert.equal(
    calls.filter((c) => c.cmd === 'check_capture_device').length,
    1,
    'two presses in one tick open the device once'
  );
}
{
  let release;
  const holdLoad = new Promise((r) => { release = r; });
  const { container, calls } = await render({ holdLoad });
  await act(async () => {
    byText(container, 'Check by speaking').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  const other = byText(container, 'Play a tone and listen');
  assert.equal(other.disabled, true, 'while one row loads the model, the other row cannot start: they share one engine');
  await act(async () => { other.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.equal(calls.filter((c) => c.cmd === 'transcribe_load_model').length, 1, 'and no second load of the same model starts');
  await act(async () => { release(); await holdLoad; });
}
{
  let release;
  const holdLoad = new Promise((r) => { release = r; });
  const { container, events } = await render({ holdLoad });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.ok(!events.includes('tone'), `no tone while the model is still loading, or it ends before anything listens: ${events.join(' > ')}`);
  await act(async () => { release(); await holdLoad; await new Promise((r) => setTimeout(r, 2600)); });
  const at = (e) => events.indexOf(e);
  assert.ok(
    at('loaded') >= 0 && at('loaded') < at('check:system') && at('check:system') < at('tone'),
    `the order must be: model loaded, device opened, tone played. It was: ${events.join(' > ')}`
  );
}

{
  // A tone that cannot play must not release the guard while the device still listens (found by
  // the gate's adversary in round 2: `Promise.all` rejected at once and both buttons came back).
  let release;
  const holdCheck = new Promise((r) => { release = r; });
  const { container, calls } = await render({ loaded: CHOSEN, holdCheck, toneFails: true });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.equal(
    byText(container, 'Check by speaking').disabled,
    true,
    'while the device is still listening, the other row stays shut even though the tone already failed'
  );
  await act(async () => {
    byText(container, 'Check by speaking').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(calls.filter((c) => c.cmd === 'check_capture_device').length, 1, 'and no second check starts beside the first');
  await act(async () => { release(); await holdCheck; });
  assert.ok(
    container.textContent.includes('The tone could not play, so there was nothing to hear: NotSupportedError: no audio output'),
    `the outcome names the tone, not the device, with the error as #168 wrote it (String(error)): ${container.textContent}`
  );
}
{
  // The tone's context is made in the click, before any await: a webview may start audio only from
  // a user gesture, and the tone now plays after the model has loaded.
  const { container, events } = await render({ loaded: CHOSEN });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.ok(
    events.indexOf('ctx') >= 0 && events.indexOf('ctx') < events.indexOf('transcribe_get_current_model'),
    `the audio context must exist before the first await of the press: ${events.join(' > ')}`
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 2600)); });
}

{
  // A context that never starts must not hold the screen (round 3: an awaited `resume()` left both
  // rows disabled until a reload).
  const { container, calls } = await render({ loaded: CHOSEN, suspended: true });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
  assert.ok(calls.some((c) => c.cmd === 'check_capture_device' && c.args.system), 'the device was checked');
  assert.equal(byText(container, 'Play a tone and listen')?.disabled, false, 'and the row comes back, whatever the context did');
  assert.equal(byText(container, 'Check by speaking').disabled, false, 'and so does the other one');
}
{
  // Every context made in a click is closed, including when the tone never plays: three presses whose
  // model load fails leaked three in round 3.
  const { container, events } = await render({ failLoad: 'Failed to load model: not downloaded' });
  for (let k = 0; k < 3; k++) {
    await act(async () => {
      byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  const made = events.filter((e) => e === 'ctx').length;
  assert.equal(made, 3, 'the sentinel: three presses made three contexts');
  assert.equal(events.filter((e) => e === 'close').length, made, `each one is closed: ${events.join(' > ')}`);
}

// --- 4d: a tone that never sounded is named, not blamed on the device (#173) ----------------------
//
// Until #173, Web Audio had no output in the AppImage: every context stayed `suspended`. The row then heard nothing
// and told the person "Nothing arrived … pick another", which is false advice about a device that was
// given nothing to hear. The exact string is chosen here and written down in #173.
const TONE_NEVER_STARTED = 'The tone could not play, so there was nothing to hear: the audio output never started';
for (const resumeRejects of [true, false]) {
  const { container } = await render({ loaded: CHOSEN, suspended: true, resumeRejects, result: { device: 'x', heard_audio: false, text: '' } });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
  assert.ok(
    container.textContent.includes(TONE_NEVER_STARTED),
    `a context that never left \`suspended\` (resume ${resumeRejects ? 'rejects' : 'pends'}) must be named as the tone failing: ${container.textContent.slice(0, 400)}`
  );
  assert.ok(!/Nothing arrived/.test(container.textContent), 'and must not tell the person their device is silent');
}
// A context that reached some state other than `running` played nothing either.
{
  const { container } = await render({ loaded: CHOSEN, initialState: 'interrupted', result: { device: 'x', heard_audio: false, text: '' } });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
  assert.ok(container.textContent.includes(TONE_NEVER_STARTED), `an \`interrupted\` context is not a tone that played: ${container.textContent.slice(0, 300)}`);
}
{
  // Negative control: a context that ran, and a device that heard nothing, is still the device. It
  // starts \`suspended\` and runs once \`resume()\` settles, so the state must be read after the tone.
  const { container } = await render({ loaded: CHOSEN, suspended: true, startsOnResume: true, result: { device: 'x', heard_audio: false, text: '' } });
  await act(async () => {
    byText(container, 'Play a tone and listen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
  assert.match(container.textContent, /Nothing arrived/, 'a tone that played into a silent device is the device');
}

// --- 5: the step is offered, not mandatory -------------------------------------------------------
{
  const { container } = await render();
  assert.ok(
    byText(container, 'Skip this'),
    'skipping must be possible: `recording_commands.rs:341-354` falls back to the default output ' +
      'device when no preference is stored, so a user who skips is not left unable to record'
  );
  assert.ok(
    /system defaults/i.test(container.textContent),
    'and the screen must say that skipping is safe, rather than leaving it to be guessed'
  );
}

// --- 6: the tone needs no Rust, and the check refuses to disturb a recording ---------------------
{
  const step = fs.readFileSync(
    path.join(root, 'src/components/onboarding/steps/AudioCheckStep.tsx'),
    'utf8'
  );
  assert.match(
    step,
    /createOscillator/,
    'the tone is Web Audio: the Rust side has no playback path at all — `grep -rn ' +
      'build_output_stream src-tauri/src` is empty — and a tone needs none'
  );

  const command = fs.readFileSync(path.join(root, 'src-tauri/src/audio/device_check.rs'), 'utf8');
  assert.match(
    command,
    /is_recording_now\(\)/,
    'the command must refuse while a meeting is recording: a second stream on the same Model fails ' +
      'with Error::Busy, and a second microphone stream is real damage to a recording in progress'
  );
  assert.match(
    command,
    /stop_streams_only/,
    'and it must stop without saving — this check has nothing to save and must create no meeting'
  );
  assert.ok(
    !/auto_save:\s*true/.test(command),
    'nothing here may write a recording to disk'
  );
  // The idle unloader must leave the model alone while the check uses it (#168). The guard's
  // behaviour is unit-tested beside the unloader (`a_device_check_keeps_the_model_loaded_while_it_runs`);
  // what that test cannot see is whether the command takes it **and keeps it**, so the wiring is read
  // here, from code with its comments removed. Round 2's version matched a substring, and `let _ =`,
  // `drop(...)` and a commented-out line all passed it (the gate's adversary).
  // Block comments first, then line comments: round 3's version stripped only `//`, and a
  // `/* … */` around the guard line passed it.
  const code = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  // The command's own body: from its signature to the first closing brace at column 0.
  const fromCommand = code(command).slice(code(command).indexOf('pub async fn check_capture_device'));
  const body = fromCommand.slice(0, fromCommand.indexOf('\n}\n') + 2);
  // At the function body's own level (four spaces), so the guard lives until the function returns.
  // Taken inside a block (`{ let g = take(); }`, or under an `if`) it ends at that block's brace and
  // holds nothing, and nothing later mentions it (the gate's adversary, round 4).
  const bound = /\n {4}let\s+(_[a-z][a-z_]*)\s*=\s*crate::audio::common::DeviceCheckHoldsEngine::take\(\);/.exec(body);
  assert.ok(
    bound && bound.index < body.indexOf('.transcribe_batch('),
    'the check must take the engine guard into a **named** binding before it decodes. `let _ =` and a bare ' +
      'call drop it on the spot, and a tick after five idle minutes then drops the model it just loaded'
  );
  // Any later mention of the binding before the decode is a way to end it early: `drop(g)`,
  // `std::mem::forget(g)` (which also leaks the count), or a move into an inner scope.
  // Nor gated: `#[cfg(debug_assertions)]` above the take compiles cleanly and leaves release builds
  // with no guard at all, #167's own mistake one level down (the gate's adversary, round 5).
  const above = body.slice(0, bound.index).trimEnd().split('\n').pop().trim();
  assert.ok(!above.startsWith('#['), `the take must not sit under an attribute: \`${above}\` gates it out of some builds`);
  const before = body.slice(bound.index + bound[0].length, body.indexOf('.transcribe_batch('));
  assert.ok(
    !new RegExp(`\\b${bound[1]}\\b`).test(before),
    `and must not touch it again before the decode: \`${bound[1]}\` is used in between`
  );
  const sides = body.match(/side_checked\([^)]*\)/g) ?? [];
  assert.deepEqual(sides, ['side_checked(system)'], 'the side read follows the row that was pressed, not a constant');
  // #299 condition 4: both of the command's results come from one constructor, given the default input
  // as the start itself reads it and the row that was pressed. `is_default: false` hardcoded in the
  // command, or the default output passed instead, would pass every unit test of the constructor.
  const built = body.match(/check_result\([^;]*\)/g) ?? [];
  assert.equal(built.length, 2, `#299 4: the command builds its result through check_result at both sites, silent and with words: ${JSON.stringify(built)}`);
  for (const b of built) {
    assert.ok(/default_input_device\(\)/.test(b) && /\bsystem\b/.test(b) && !/default_output_device/.test(b),
      `#299 4: each call passes the default input's lookup and the row: \`${b}\``);
  }
  assert.ok(!/DeviceCheck\s*\{/.test(body), '#299 4: and the command builds no DeviceCheck of its own');
  // A literal, not the type's declaration or a return type.
  const nonTest = code(command).slice(0, code(command).indexOf('#[cfg(test)]'));
  const literals = nonTest.match(/(?<!struct |-> )DeviceCheck\s*\{/g) ?? [];
  const ctor = nonTest.slice(nonTest.indexOf('fn check_result('));
  assert.ok(literals.length === 1 && ctor.slice(0, ctor.indexOf('\n}\n')).match(/(?<!struct |-> )DeviceCheck\s*\{/),
    `#299 4: the file's one DeviceCheck literal is inside check_result: found ${literals.length}`);
  const loadCommand = code(fs.readFileSync(path.join(root, 'src-tauri/src/transcribe_engine/commands.rs'), 'utf8'));
  const load = loadCommand.slice(loadCommand.indexOf('pub async fn transcribe_load_model'));
  assert.ok(
    load.slice(0, load.indexOf('#[command]')).includes('touch_engine_idle()'),
    'a model just loaded must reset the idle clock, or the next tick can unload it before anything uses it'
  );
}

// --- completing is once, and a failure gives the button back -------------------------------------
//
// **These moved here from `first-run-step.test.mjs` with the behaviour they guard.** The download
// screen used to finish onboarding off macOS — which is exactly why nobody reached this step, the
// one that proves the microphone and the speakers before a first meeting. Now every platform lands
// here and this screen finishes, so the guarantees follow: a second press must not complete twice,
// and a failure must give the control back rather than leave a new user on a dead spinner.
{
  const { container, seen } = await render();
  const go = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue');
  assert.ok(go, 'the audio check must offer a way forward');
  await click(go);
  await click(go);
  assert.equal(seen.completed, 1, 'a second press while completing must not complete onboarding twice');
  assert.equal(seen.next, 0, 'and off macOS it must finish rather than walk on to a step that renders nothing');
}
{
  const { container, seen } = await render({ failComplete: true });
  const go = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue');
  await click(go);
  assert.equal(seen.completed, 1, 'the failing attempt must have been made');
  assert.equal(
    [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue').disabled,
    false,
    'and a failure must give the button back — leaving a new user on a dead spinner is the worst ' +
      'first impression this screen can make'
  );
}

// --- #299: the microphone first run proved is the one the first recording opens --------------------
//
// First run's audio check proved a microphone and kept it in component state, and nothing wrote it to
// the store: the first recording then opened `default_input_device()`, not the device the person had
// just heard working. The product owner decided (2026-10-30): the last microphone check that came back
// with words decides; a non-default one is stored as `"<name> (input)"`; the default clears a stored
// microphone and otherwise writes nothing; nothing on screen changes.
//
// A fixture of its own. The default is `Digital Microphone`: neither first in the list nor the
// preselection, so only `is_default` on the check's result can name it. The struct read carries
// `file_format: 'wav'`, which is neither Settings' initial state nor the Rust default, and
// `system_audio_backend`, which the TypeScript interface does not declare.
const KEEP_DEVICES = [
  { name: 'Headset Microphone', device_type: 'Input' },
  { name: 'USB Microphone', device_type: 'Input' },
  { name: 'Digital Microphone', device_type: 'Input' },
  { name: 'Speakers Monitor', device_type: 'Output' },
];
const DEFAULT_INPUT = 'Digital Microphone';
const READ = { save_folder: '/srv/elsewhere', auto_save: false, file_format: 'wav', preferred_system_device: 'Speakers Monitor (output)', system_audio_backend: 'coreaudio' };

/**
 * The step against a store. `answers` is one entry per check, in order: 'words', 'silent', 'nowords'
 * or 'reject'.
 */
async function keep({ platform = 'linux', stored = null, answers = [], holdWrite, rejectWrite } = {}) {
  const calls = [];
  const seen = { completed: 0, next: 0, order: [] };
  const queue = [...answers];
  const { AudioCheckStep } = loadTsx('src/components/onboarding/steps/AudioCheckStep.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/plugin-os': { platform: () => platform },
    '@/contexts/OnboardingContext': {
      useOnboarding: () => ({
        selectedTranscribeModel: CHOSEN,
        goNext: () => { seen.next += 1; seen.order.push('goNext'); },
        completeOnboarding: async () => { seen.completed += 1; seen.order.push('complete'); },
      }),
    },
    '../OnboardingContainer': {
      OnboardingContainer: ({ children, footer }) =>
        React.createElement('div', null, children, React.createElement('footer', null, footer)),
    },
    '@tauri-apps/api/core': {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args: args === undefined ? undefined : structuredClone(args) });
        if (cmd === 'get_audio_devices') return KEEP_DEVICES;
        if (cmd === 'transcribe_get_current_model') return CHOSEN;
        if (cmd === 'get_recording_preferences') return structuredClone({ ...READ, preferred_mic_device: stored });
        if (cmd === 'set_recording_preferences') {
          seen.order.push('write');
          if (holdWrite) await holdWrite;
          if (rejectWrite) throw new Error('Failed to save recording preferences: disk full');
          return null;
        }
        if (cmd === 'check_capture_device') {
          const a = queue.shift() ?? 'words';
          if (a === 'reject') throw new Error(`Could not open ${args.name}: device busy`);
          return { device: args.name, heard_audio: a !== 'silent', text: a === 'words' ? 'testing one two' : '', is_default: !args.system && args.name === DEFAULT_INPUT };
        }
        return null;
      },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(React.createElement(AudioCheckStep, null)); });
  // The platform is read in an effect, from a dynamic import.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const writes = () => calls.filter((c) => c.cmd === 'set_recording_preferences').map((c) => c.args.preferences);
  return { container, calls, seen, writes };
}
// The picker as a person uses it: open the trigger, press the option. Radix opens on a click that is
// not a mouse's pointerdown, and selects on a click likewise; the options render in a portal. Not
// through a <form>'s hidden native <select>: in jsdom that one answers the first value with '' and
// clears the preselection.
// jsdom has no scrollIntoView, which an open Radix list calls on its selected option.
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
async function pick(c, name) {
  await click(c.querySelector('button[aria-label="Microphone"]'));
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === name);
  assert.ok(option, `#299: the microphone picker offers ${name}`);
  await click(option);
  assert.ok(c.querySelector('button[aria-label="Microphone"]').textContent.includes(name), `#299: the picker shows ${name}`);
}
const checkMic = (c) => click(byText(c, 'Check by speaking'));
const checkSystem = async (c) => {
  await click(byText(c, 'Play a tone and listen'));
  await act(async () => { await new Promise((r) => setTimeout(r, 2600)); });
};
// By place, not label: the step's last two buttons are Continue and Skip, and a control that relabels one
// must reach the case it breaks rather than end the run here.
const finish = (c, how) => click(buttons(c).slice(-2)[how === 'Skip' ? 1 : 0]);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });
const finished = (seen, platform) => (platform === 'macos' ? seen.next : seen.completed);
const as = (mic) => ({ ...READ, preferred_mic_device: mic });

// Collected, not thrown: a control then shows every case it turns red, not only the first.
const red299 = [];
const same = (actual, want, label) => { if (!isDeepStrictEqual(actual, want)) red299.push(`${label} -- got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); };
const holds = (cond, label) => { if (!cond) red299.push(label); };
// A rejection that escapes the step's handlers is a defect of its own, and must not end the run before the
// list below is printed.
process.on('unhandledRejection', (e) => { red299.push(`#299: a rejection escaped the step: ${e}`); });

// --- #299 condition 1: a non-default check with words is stored, and nothing else changes ----------
for (const platform of ['linux', 'macos']) {
  for (const how of ['Continue', 'Skip']) {
    const { container, seen, writes } = await keep({ platform });
    await checkMic(container);
    await finish(container, how);
    await settle();
    same(writes(), [as('Headset Microphone (input)')],
      `#299 1: ${platform}, ${how}: the untouched preselection, checked with words, must be stored as "<name> (input)", and every other field written back as read`);
    same(finished(seen, platform), 1, `#299 1: ${platform}, ${how}: and first run still finishes`);
  }
}
for (const platform of ['linux', 'macos']) {
  // The write settles first, before either reload.
  let release;
  const holdWrite = new Promise((r) => { release = r; });
  const { container, seen, writes } = await keep({ platform, holdWrite });
  await checkMic(container);
  await finish(container, 'Continue');
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  same(writes().length, 1, `#299 1: ${platform}: the write has started`);
  same(finished(seen, platform), 0, `#299 1: ${platform}: and nothing finishes first run while it is held: ${seen.order.join(' > ')}`);
  await act(async () => { release(); await holdWrite; });
  await settle();
  same(finished(seen, platform), 1, `#299 1: ${platform}: once it settles, first run finishes: ${seen.order.join(' > ')}`);
}
for (const platform of ['linux', 'macos']) {
  // A write that fails does not stop first run.
  const { container, seen, writes } = await keep({ platform, rejectWrite: true });
  await checkMic(container);
  await finish(container, 'Continue');
  await settle();
  same(writes().length, 1, `#299 1: ${platform}: the failing write was made`);
  same(finished(seen, platform), 1, `#299 1: ${platform}: and first run still finishes`);
}
{
  // A second press while the write is held writes once and finishes once (the guarantee at :56-57).
  let release;
  const holdWrite = new Promise((r) => { release = r; });
  const { container, seen, writes } = await keep({ holdWrite });
  await checkMic(container);
  await finish(container, 'Continue');
  await finish(container, 'Continue');
  await finish(container, 'Skip');
  await act(async () => { release(); await holdWrite; });
  await settle();
  same(writes().length, 1, `#299 1: three presses while the write is held write once: ${seen.order.join(' > ')}`);
  same(seen.completed, 1, `#299 1: and finish once: ${seen.order.join(' > ')}`);
}

// --- #299 condition 2: only the last microphone check with words counts --------------------------
{
  const cases = [
    ['(a) a silent check', ['silent'], async () => {}, []],
    ['(b) audio without words', ['nowords'], async () => {}, []],
    ['(c) words, then another silent', ['words', 'silent'], async (c) => { await pick(c, 'USB Microphone'); await checkMic(c); }, [as('Headset Microphone (input)')]],
    ['(d) words, then the picker moved with no check', ['words'], async (c) => { await pick(c, 'USB Microphone'); }, [as('Headset Microphone (input)')]],
    ['(e) words, then another with words', ['words', 'words'], async (c) => { await pick(c, 'USB Microphone'); await checkMic(c); }, [as('USB Microphone (input)')]],
    ['(f) words, then the system row with words', ['words', 'words'], async (c) => { await checkSystem(c); }, [as('Headset Microphone (input)')]],
    ['(g) words, then another check rejected', ['words', 'reject'], async (c) => { await pick(c, 'USB Microphone'); await checkMic(c); }, [as('Headset Microphone (input)')]],
  ];
  for (const [name, answers, then, want] of cases) {
    const { container, writes } = await keep({ answers });
    await checkMic(container);
    await then(container);
    await finish(container, 'Continue');
    await settle();
    same(writes(), want, `#299 2${name}: ${JSON.stringify(writes())}`);
  }
}

// --- #299 condition 3: the system default clears a stored microphone, and writes nothing otherwise ---
{
  const USB = 'USB Microphone (input)';
  const cases = [
    ['(a) none stored, the default with words', null, async (c) => { await pick(c, DEFAULT_INPUT); await checkMic(c); }, ['words'], [], ['linux', 'macos'], ['Continue']],
    ['(b) one stored, the default with words', USB, async (c) => { await pick(c, DEFAULT_INPUT); await checkMic(c); }, ['words'], [as(null)], ['linux', 'macos'], ['Continue', 'Skip']],
    ['(c) one stored, another with words, then the default with words', USB, async (c) => { await checkMic(c); await pick(c, DEFAULT_INPUT); await checkMic(c); }, ['words', 'words'], [as(null)], ['linux'], ['Continue']],
    ['(d) one stored, only a silent check of the default', USB, async (c) => { await pick(c, DEFAULT_INPUT); await checkMic(c); }, ['silent'], [], ['linux'], ['Continue']],
    ['(e) one stored, another with words', USB, async (c) => { await checkMic(c); }, ['words'], [as('Headset Microphone (input)')], ['linux', 'macos'], ['Continue']],
    ['(f) none stored, another with words, then the default with words', null, async (c) => { await checkMic(c); await pick(c, DEFAULT_INPUT); await checkMic(c); }, ['words', 'words'], [], ['linux'], ['Continue']],
    ['(g) one stored, the default with words, then another with words', USB, async (c) => { await pick(c, DEFAULT_INPUT); await checkMic(c); await pick(c, 'Headset Microphone'); await checkMic(c); }, ['words', 'words'], [as('Headset Microphone (input)')], ['linux'], ['Continue']],
  ];
  for (const [name, stored, steps, answers, want, platforms, hows] of cases) {
    for (const platform of platforms) {
      for (const how of hows) {
        const { container, seen, writes } = await keep({ platform, stored, answers });
        await steps(container);
        await finish(container, how);
        await settle();
        same(writes(), want, `#299 3${name}, ${platform}, ${how}: ${JSON.stringify(writes())}`);
        same(finished(seen, platform), 1, `#299 3${name}, ${platform}, ${how}: first run finishes`);
      }
    }
  }
}

// --- #299 condition 5: Settings → Recordings shows what the step stored ---------------------------
{
  const { container, writes } = await keep();
  await checkMic(container);
  await finish(container, 'Continue');
  await settle();
  const stored = writes()[0];
  holds(stored, '#299 5: the sentinel: condition 1 wrote a struct');
  if (stored) {
    const { RecordingSettings } = loadTsx('src/components/RecordingSettings.tsx', {
      ...boundaryStubs().modules,
      sonner: { toast: Object.assign(() => {}, { success: () => {}, error: () => {} }) },
      '@tauri-apps/api/core': {
        invoke: async (cmd) => {
          if (cmd === 'get_recording_preferences') return structuredClone(stored);
          if (cmd === 'get_audio_devices') return KEEP_DEVICES;
          if (cmd === 'get_default_recordings_folder_path') return '/srv/elsewhere';
          // AudioBackendSelector's list, which it reads whatever the platform: none here.
          if (cmd === 'get_audio_backend_info') return [];
          return null;
        },
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const log = console.log;
    console.log = () => {};
    await act(async () => { createRoot(host).render(React.createElement('form', null, React.createElement(RecordingSettings, null))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    console.log = log;
    const trigger = host.querySelector('button[role="combobox"]');
    const native = host.querySelectorAll('select')[0];
    const shown = trigger?.textContent.trim() || '';
    holds(
      shown === 'Headset Microphone' || (native && native.value === 'Headset Microphone (input)' && !/Default Microphone/.test(shown)),
      `#299 5: Settings' microphone picker must read the microphone first run stored: the trigger reads '${shown}', the native select '${native?.value}'`
    );
  }
}

// --- #299 condition 6: nothing on screen changes (ADR 0023) ----------------------------------------
//
// The step's text, button labels and aria-labels in six states, against a literal captured at `main`
// (`133d100`) by this same function. The first four exist there; after Continue with the write held,
// and after it rejected, Continue only disables the buttons, so both compare with the after-words state.
const screenOf = (c) => ({
  text: c.textContent,
  buttons: buttons(c).map((b) => b.textContent.trim()),
  labels: [...c.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
});
const SCREENS = {
  idle: {"text": "MicrophoneHeadset MicrophonePress check and say a sentence. The words come back only if this is the device that heard you.Check by speakingThe other side is heard throughSpeakers MonitorThe app plays a tone through your speakers. This device should hear it — if it cannot, it is not a monitor of your output.Play a tone and listenContinueSkip thisSkipping is safe: if you set nothing here the app uses your system defaults.", "buttons": ["Headset Microphone", "Check by speaking", "Speakers Monitor", "Play a tone and listen", "Continue", "Skip this"], "labels": ["Microphone", "The other side is heard through"]},
  words: {"text": "MicrophoneHeadset MicrophonePress check and say a sentence. The words come back only if this is the device that heard you.Check by speakingHeard: testing one twoThe other side is heard throughSpeakers MonitorThe app plays a tone through your speakers. This device should hear it — if it cannot, it is not a monitor of your output.Play a tone and listenContinueSkip thisSkipping is safe: if you set nothing here the app uses your system defaults.", "buttons": ["Headset Microphone", "Check by speaking", "Speakers Monitor", "Play a tone and listen", "Continue", "Skip this"], "labels": ["Microphone", "The other side is heard through"]},
  silent: {"text": "MicrophoneHeadset MicrophonePress check and say a sentence. The words come back only if this is the device that heard you.Check by speakingNothing arrived. This device is open but silent — pick another.The other side is heard throughSpeakers MonitorThe app plays a tone through your speakers. This device should hear it — if it cannot, it is not a monitor of your output.Play a tone and listenContinueSkip thisSkipping is safe: if you set nothing here the app uses your system defaults.", "buttons": ["Headset Microphone", "Check by speaking", "Speakers Monitor", "Play a tone and listen", "Continue", "Skip this"], "labels": ["Microphone", "The other side is heard through"]},
  nowords: {"text": "MicrophoneHeadset MicrophonePress check and say a sentence. The words come back only if this is the device that heard you.Check by speakingAudio arrived, but nothing came back as words.The other side is heard throughSpeakers MonitorThe app plays a tone through your speakers. This device should hear it — if it cannot, it is not a monitor of your output.Play a tone and listenContinueSkip thisSkipping is safe: if you set nothing here the app uses your system defaults.", "buttons": ["Headset Microphone", "Check by speaking", "Speakers Monitor", "Play a tone and listen", "Continue", "Skip this"], "labels": ["Microphone", "The other side is heard through"]},
};
{
  const states = {};
  states.idle = screenOf((await keep()).container);
  for (const [k, a] of [['words', 'words'], ['silent', 'silent'], ['nowords', 'nowords']]) {
    const { container } = await keep({ answers: [a] });
    await checkMic(container);
    states[k] = screenOf(container);
  }
  if (process.env.PRINT_SCREENS) console.log(JSON.stringify(states));
  for (const k of Object.keys(SCREENS)) same(states[k], SCREENS[k], `#299 6: the ${k} screen changed`);
  let release;
  const holdWrite = new Promise((r) => { release = r; });
  const held = await keep({ holdWrite });
  await checkMic(held.container);
  await finish(held.container, 'Continue');
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  same(screenOf(held.container), SCREENS.words, '#299 6: Continue with the write held shows nothing new');
  await act(async () => { release(); await holdWrite; });
  const rejected = await keep({ rejectWrite: true });
  await checkMic(rejected.container);
  await finish(rejected.container, 'Continue');
  await settle();
  same(rejected.seen.completed, 1, '#299 6: the sentinel: after the rejection, first run finished');
  same(screenOf(rejected.container), SCREENS.words, '#299 6: a rejected write shows nothing');
}

assert.deepEqual(red299, [], `RED CONDITIONS:\n${red299.join('\n')}`);

console.log(
  'ok - audio check: both devices are listed and opened by name, the microphone is proven by the ' +
    'words it heard, the system side is proven by a tone the app plays, each failure names itself, ' +
    'the step is skippable, and the command refuses to disturb a recording; and the last microphone ' +
    'check with words is stored at Continue or Skip, the default clearing a stored one, with nothing ' +
    'new on screen (#299)'
);

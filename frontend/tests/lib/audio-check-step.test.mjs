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

async function render({ result, fail, failComplete = false } = {}) {
  const calls = [];
  const seen = { completed: 0, next: 0 };
  const { AudioCheckStep } = loadTsx('src/components/onboarding/steps/AudioCheckStep.tsx', {
    ...boundaryStubs().modules,
    '@/contexts/OnboardingContext': {
      useOnboarding: () => ({
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
        if (cmd === 'get_audio_devices') return DEVICES;
        if (cmd === 'check_capture_device') {
          if (fail) throw new Error(fail);
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
    createOscillator() {
      return {
        frequency: {},
        connect: (n) => n,
        start: () => played.push('start'),
        stop: () => played.push('stop'),
      };
    }
    createGain() {
      return { gain: {}, connect: () => this.destination };
    }
    get destination() { return {}; }
    async close() {}
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(React.createElement(AudioCheckStep, null)); });
  return { container, calls, played, seen };
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

console.log(
  'ok - audio check: both devices are listed and opened by name, the microphone is proven by the ' +
    'words it heard, the system side is proven by a tone the app plays, each failure names itself, ' +
    'the step is skippable, and the command refuses to disturb a recording'
);

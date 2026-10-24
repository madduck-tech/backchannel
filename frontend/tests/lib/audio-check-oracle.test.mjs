// The gate's reading of the audio check, run against the component itself. (#167, #168)
//
// `scripts/lib/audio-check-outcome.js` is what both Stage 2 passes send to the running application to
// read the microphone row. This file runs **that same text** against `AudioCheckStep` rendered in
// jsdom, so the matcher the gate uses is the one under test, not a copy.
//
// Two things it must get right, and each was wrong once:
//
//   - **The words come from the decoded text alone.** The step's fixed copy already holds four words
//     of the sample (`and`, `not`, `you`, `your`). #168 v3's rule read `document.body.innerText`, so
//     it passed on a one-word decode, or on any decode at all.
//   - **Only the command's own answers are accepted.** `Command check_capture_device not found` is what
//     every release build said (#167), and a classifier that takes any red text as "the command
//     answered" would accept it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 900, height: 700 });
const { loadTsx } = await import('./render-tsx.mjs');
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ORACLE = fs.readFileSync(path.join(repo, 'scripts', 'lib', 'audio-check-outcome.js'), 'utf8');
// A function body, as WebDriver runs it.
const read = () => JSON.parse(new Function(ORACLE)());

async function render({ text, heard = true, fail } = {}) {
  const { AudioCheckStep } = loadTsx('src/components/onboarding/steps/AudioCheckStep.tsx', {
    ...boundaryStubs().modules,
    '@/contexts/OnboardingContext': {
      useOnboarding: () => ({ selectedTranscribeModel: 'parakeet-tdt-0.6b-v3-q4', goNext() {}, async completeOnboarding() {} }),
    },
    '../OnboardingContainer': {
      // The real frame draws a step strip whose numbers are `<b>`s (`OnboardingContainer.tsx:63`), so
      // one is drawn here: an oracle that picks the first `<b>` on the page reads a digit.
      OnboardingContainer: ({ children, footer }) =>
        React.createElement('div', null, React.createElement('b', null, '4'), children, React.createElement('footer', null, footer)),
    },
    '@tauri-apps/api/core': {
      invoke: async (cmd, args) => {
        if (cmd === 'get_audio_devices') return [{ name: 'Backchannel', device_type: 'Input' }, { name: 'Monitor', device_type: 'Output' }];
        if (cmd === 'transcribe_get_current_model') return 'parakeet-tdt-0.6b-v3-q4';
        if (cmd === 'check_capture_device') {
          if (fail) throw fail;
          return { device: args.name, heard_audio: heard, text };
        }
        return null;
      },
    },
  });
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(React.createElement(AudioCheckStep, null)); });
  return container;
}

async function press(container) {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Check by speaking');
  await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

// --- before the press: the control is found, enabled, and nothing is on the row yet -------------------
{
  await render({ text: 'unused' });
  const v = read();
  assert.equal(v.found, true, 'the oracle must find the microphone row');
  assert.equal(v.button, 'Check by speaking');
  assert.equal(v.disabled, false, 'a device is in the picker, so the control is enabled');
  assert.equal(v.device, 'Backchannel');
  assert.equal(v.kind, 'NONE', 'and no outcome is read before anything was pressed');
}

// --- the words are the decoded text's, never the page's ---------------------------------------------
{
  const c = await render({ text: 'you' });
  await press(c);
  const v = read();
  assert.equal(v.kind, 'HEARD');
  assert.equal(v.decoded, 'you', 'the decoded text, and not the step strip\'s <b>4</b>');
  assert.ok(
    /and|not|your/.test(document.body.textContent.toLowerCase()),
    'the sentinel: the page copy around it does contain sample words'
  );
  assert.equal(
    v.sampleWords,
    1,
    'a one-word decode holds one sample word. The page copy holds four more, and they must not count: ' +
      'the core pass requires three, so a matcher that read the page would pass this decode'
  );
}
{
  const c = await render({ text: 'And so my fellow Americans, ask not' });
  await press(c);
  assert.equal(read().sampleWords, 7, 'and a real decode is counted by distinct words, ignoring case and punctuation');
}

// --- only the command's own answers are its answers ------------------------------------------------
const kindFor = async (opts) => {
  const c = await render(opts);
  await press(c);
  return read();
};
assert.equal((await kindFor({ heard: false, text: '' })).kind, 'SILENT');
assert.equal((await kindFor({ heard: true, text: '' })).kind, 'NO_WORDS');
assert.equal((await kindFor({ fail: 'Could not open Backchannel: device busy' })).kind, 'BODY_ERROR');
assert.equal(
  (await kindFor({ fail: 'Command check_capture_device not found' })).kind,
  'OTHER',
  '#167: what every release build answered is not the command answering'
);
assert.equal(
  (await kindFor({ fail: 'invalid args `system` for command `check_capture_device`' })).kind,
  'OTHER',
  'nor is a registration with broken arguments'
);

console.log(
  'ok - audio check oracle: the gate\'s own reader finds the microphone row, counts sample words in the ' +
    'decoded text alone (1 for "you" on a page whose copy holds four), and accepts only answers ' +
    'the command itself gives'
);

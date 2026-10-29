// What the system audio backend selector lets a person choose, and what it shows as chosen.
//
// #275. The `screencapturekit` option was disabled by id since upstream 483fea6, so on macOS
// the System Audio device picker did nothing: Core Audio taps every application whatever is
// picked. And the selector compared `get_current_audio_backend` against ids while Rust
// returned the label, so after a relaunch no option was checked (observed in #276's gate).
//
// This test holds the frontend half only. That Rust returns an id is held by
// `the_current_backend_is_reported_as_an_offered_id` in `recording_preferences.rs`; here the
// stub returns one, so the "checked" case goes red only if the component stops matching ids.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

// The two backends `get_audio_backend_info` returns on macOS (`available_on(MacOs)`), with the
// labels #276 gave them.
const BACKENDS = [
  { id: 'screencapturekit', name: 'Selected device', description: 'Records only the device selected above.' },
  { id: 'coreaudio', name: 'All system audio', description: 'The System Audio device selected above is not used.' },
];

async function render(currentBackend) {
  const stubs = tauriStubs({ backends: BACKENDS, currentBackend });
  const { AudioBackendSelector } = loadTsx('src/components/AudioBackendSelector.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
  });
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(AudioBackendSelector)); });
  const radios = [...container.querySelectorAll('input[type=radio]')];
  return { root, radios, stubs };
}

const byId = (radios, id) => radios.find((r) => r.value === id);

for (const current of ['screencapturekit', 'coreaudio']) {
  const { root, radios, stubs } = await render(current);

  // A positive sentinel first: an empty list would satisfy every "none is disabled" below.
  assert.deepEqual(radios.map((r) => r.value), BACKENDS.map((b) => b.id), 'both options render');

  // No option is disabled merely by its id.
  for (const radio of radios) {
    assert.equal(radio.disabled, false, `${radio.value} is disabled`);
  }

  // The current backend, reported as an id, is the one checked; the other is not.
  assert.equal(byId(radios, current).checked, true, `${current} is current but not checked`);
  for (const radio of radios.filter((r) => r.value !== current)) {
    assert.equal(radio.checked, false, `${radio.value} is checked but ${current} is current`);
  }

  // Choosing the other option asks Rust to set it, by id.
  const other = radios.find((r) => r.value !== current);
  await act(async () => { other.click(); });
  const set = stubs.calls.filter((c) => c.cmd === 'set_audio_backend');
  assert.deepEqual(set.map((c) => ({ ...c.args })), [{ backend: other.value }]);
  assert.equal(byId([...document.querySelectorAll('input[type=radio]')], other.value).checked, true);

  await act(async () => { root.unmount(); });
}

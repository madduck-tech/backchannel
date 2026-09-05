// The picker must not tell the user to click a control it does not draw.
//
// It did. `DeviceSelection` rendered `Tip: Click "Test Mic" to check if your microphone is
// working`, guarded by `!isMonitoring` — a flag set only inside a block commented out
// upstream in 1e81fdb (2025-10-23), so the guard was permanently true and the button never
// existed. The instruction shipped for the life of this fork (#15).
//
// Stated as a rule rather than as "no Test Mic tip", so it also catches the next one: every
// quoted label the interface tells the user to click must name a control that is rendered.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const stubs = tauriStubs({
  devices: [
    { name: 'Headset Mic', device_type: 'Input' },
    { name: 'Monitor of Speakers', device_type: 'Output' },
  ],
});
const { DeviceSelection } = loadTsx('src/components/DeviceSelection.tsx', {
  '@tauri-apps/api/core': stubs.core,
  '@tauri-apps/api/event': stubs.event,
  'lucide-react': new Proxy({}, { get: () => () => null }),
});

const root = createRoot(document.getElementById('root'));
const realLog = console.log;
console.log = () => {};
await act(async () => {
  root.render(
    React.createElement('form', null,
      React.createElement(DeviceSelection, {
        selectedDevices: { micDevice: null, systemDevice: null },
        onDeviceChange: () => {},
      }))
  );
});
console.log = realLog;

const text = document.body.textContent ?? '';
assert.ok(text.length > 0, 'the picker rendered nothing — the harness, not the component, is broken');

// Every `Click "Label"` instruction must name something the user can actually click.
const instructed = [...text.matchAll(/Click\s+["“]([^"”]+)["”]/g)].map((m) => m[1]);
const clickable = [...document.querySelectorAll('button, [role=button], a')].map((el) =>
  (el.getAttribute('aria-label') || el.textContent || '').trim()
);

const missing = instructed.filter(
  (label) => !clickable.some((name) => name === label || name.includes(label))
);

assert.deepEqual(
  missing,
  [],
  'the picker instructs the user to click controls it does not render:\n  ' +
    missing.map((l) => `"${l}"`).join('\n  ') +
    `\n\n  rendered controls: ${clickable.filter(Boolean).join(' | ')}` +
    '\n  Either render the control, or stop telling the user to use it.'
);

console.log(
  `ok - device picker: ${instructed.length} click instruction(s), all naming a rendered control`
);

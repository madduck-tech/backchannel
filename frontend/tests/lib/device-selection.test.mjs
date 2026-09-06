// What the device picker does with what it is given.
//
// Four mutations were measured against everything this repository had before these tests:
// stripping the ` (input)` suffix inside `handleMicDeviceChange`, swapping the two
// `onValueChange` handlers, swapping the two device arrays, and merging the lists. All four
// passed `node --test` and `tsc --noEmit`. The first is invisible even to a person, because
// the option *label* is `{device.name}` while the *value* carries the suffix — the picker
// looks identical and the stored preference silently stops parsing in Rust.
//
// These assertions read Radix's hidden native <select>, which needs no polyfills. See
// dom-harness.mjs for what that costs and what it mirrors.
import assert from 'node:assert/strict';
import { setupDom, changeSelect } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const DEVICES = [
  { name: 'Headset Mic', device_type: 'Input' },
  { name: 'Array Mic', device_type: 'Input' },
  { name: 'Monitor of Speakers', device_type: 'Output' },
];

const stubs = tauriStubs({ devices: DEVICES });
const { DeviceSelection } = loadTsx('src/components/DeviceSelection.tsx', {
    ...boundaryStubs().modules,
  '@tauri-apps/api/core': stubs.core,
  '@tauri-apps/api/event': stubs.event,
  // Icons render as SVG and carry nothing asserted here.
});

// The component runs in a vm context, so objects it creates carry that context's Object
// prototype and `deepStrictEqual` rejects them against ours even when every field matches.
// Copying into this realm is the fix; asserting on fields one at a time would hide which
// combination was wrong.
const asPlain = (o) => (o === null ? null : { ...o });

let received = null;
const container = document.getElementById('root');
const root = createRoot(container);

// The wrapper holds state and feeds the choice back, the way RecordingSettings.tsx:77-86
// does. Not decoration: React tracks the current value of a <select> and suppresses a change
// event when it has not moved, so a fixed prop makes the second interaction on a picker
// silently do nothing -- the test would then read the previous assertion's value and pass or
// fail for the wrong reason.
function Harness() {
  const [devices, setDevices] = React.useState({ micDevice: null, systemDevice: null });
  return React.createElement(
    // The <form> is scaffolding: it is what makes Radix render its hidden native <select>,
    // and this application contains no <form> of its own. Documented in dom-harness.mjs.
    'form',
    null,
    React.createElement(DeviceSelection, {
      selectedDevices: devices,
      onDeviceChange: (d) => { received = d; setDevices(d); },
    })
  );
}

// The component logs the device list it loaded. Kept out of the test's own output, but
// only `log` -- a warning or an error from React or the component must still be seen.
const realLog = console.log;
console.log = () => {};
await act(async () => { root.render(React.createElement(Harness)); });
console.log = realLog;

// Re-queried before every interaction: React replaces these nodes on re-render, and a
// reference captured earlier goes stale silently -- the change fires on a detached node and
// the assertion reads the previous state.
const selects = () => [...document.querySelectorAll('select')];
const micSelect = () => selects()[0];
const systemSelect = () => selects()[1];
assert.equal(selects().length, 2, `expected two hidden selects, got ${selects().length}`);
const values = (s) => [...s.options].map((o) => o.value);

// --- test 3: the two lists are neither swapped nor merged -------------------------------
assert.deepEqual(
  values(micSelect()).filter((v) => v !== 'default'),
  ['Headset Mic (input)', 'Array Mic (input)'],
  'the microphone picker must offer exactly the Input devices. Swapping the two arrays, or ' +
    'feeding it the whole list, both passed every check before this test existed.'
);
assert.deepEqual(
  values(systemSelect()).filter((v) => v !== 'default'),
  ['Monitor of Speakers (output)'],
  'the system-audio picker must offer exactly the Output devices'
);
assert.deepEqual(
  [...micSelect().options].map((o) => o.textContent).filter((t) => t !== 'Default Microphone'),
  ['Headset Mic', 'Array Mic'],
  'the label a user reads is the bare device name; the suffix lives only in the value, which ' +
    'is why mangling it is invisible on screen'
);

// --- test 2: the handlers are not swapped, and neither mangles the string ----------------
await changeSelect(micSelect(), 'Headset Mic (input)', act);
assert.deepStrictEqual(
  asPlain(received),
  { micDevice: 'Headset Mic (input)', systemDevice: null },
  'picking a microphone must set micDevice — and must keep the "(input)" suffix, which ' +
    'AudioDevice::from_name in Rust requires. Stripping it passed every check before this test.'
);

await changeSelect(systemSelect(), 'Monitor of Speakers (output)', act);
assert.deepStrictEqual(
  asPlain(received),
  { micDevice: 'Headset Mic (input)', systemDevice: 'Monitor of Speakers (output)' },
  'picking system audio must set systemDevice and leave the microphone alone. The two ' +
    'handlers are byte-identical except for this field and are wired by hand at :258 and ' +
    ':327; swapping them passed every check before this test existed.'
);

// --- 'default' means "no preference", on both -------------------------------------------
await changeSelect(micSelect(), 'default', act);
assert.equal(received.micDevice, null, "'default' must become null, not the string 'default'");
assert.equal(
  received.systemDevice,
  'Monitor of Speakers (output)',
  'clearing the microphone must not clear system audio'
);
await changeSelect(systemSelect(), 'default', act);
assert.equal(received.systemDevice, null, "'default' must become null on the system picker too");

console.log(
  `ok - device selection: ${values(micSelect()).length - 1} inputs and ` +
    `${values(systemSelect()).length - 1} outputs partitioned, both handlers on their own field`
);

// The device picker writes an identity string; the Rust lookup parses it back. They agreed by
// authorship and nothing checked it, which is how `"<name> (System Audio)"` came to be advertised
// while every lookup compared the unsuffixed description — a device you could see and could not
// select (#13).
//
// The Rust test that covers that round trip builds the stored form with a *literal*
// `format!("{} (output)", …)`. Change the TSX template to `[output]` and that test still passes,
// because it never reads the TSX. This is the missing half: the two sides must spell the same
// string, checked in CI, with no renderer and no driver.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tsx = fs.readFileSync(path.join(root, 'src', 'components', 'DeviceSelection.tsx'), 'utf8');
const rs = fs.readFileSync(
  path.join(root, 'src-tauri', 'src', 'audio', 'stream.rs'),
  'utf8'
);
const config = fs.readFileSync(
  path.join(root, 'src-tauri', 'src', 'audio', 'devices', 'configuration.rs'),
  'utf8'
);

// What the picker stores, read out of the component rather than assumed.
const stored = [
  ...tsx.matchAll(/value=\{`\$\{device\.name\}\s*\(\$\{device\.device_type\.toLowerCase\(\)\}\)`\}/g),
];
assert.equal(
  stored.length,
  2,
  'DeviceSelection no longer stores `${device.name} (${device.device_type.toLowerCase()})` for both ' +
    'pickers. If the shape changed on purpose, change it here, in `AudioDevice::from_name` and in ' +
    "stream.rs's round-trip test together — they are one contract."
);

// What the Rust round-trip test builds. It must be the same shape, lowercased type in parentheses.
const roundTrip = rs.match(/let stored = format!\("\{\} \((input|output)\)", /);
assert.ok(
  roundTrip,
  'stream.rs no longer builds the stored form as `format!("{} (<type>)", …)`; the round-trip test ' +
    'has stopped mirroring what DeviceSelection.tsx writes.'
);

// And what the parser strips. `from_name` is the only thing that has to agree with both.
for (const suffix of ['(input)', '(output)']) {
  assert.ok(
    config.includes(`ends_with("${suffix}")`) && config.includes(`trim_end_matches("${suffix}")`),
    `AudioDevice::from_name no longer recognises "${suffix}", which the picker still writes`
  );
}

console.log('ok - device preference string: picker, Rust round-trip test and from_name agree');

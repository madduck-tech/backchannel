// Modal keys that no code can open, and the four places the key list is declared.
//
// `deviceSettings` renders the audio device picker and `modelSettings` the summary model
// dialog. Neither is ever passed to `showModal(`, so neither can be opened by anything the
// user does. They were found only by reading the code (#17).
//
// Two conditions, deliberately in one file because they are one contract:
//   A. the four declarations of the key list agree with each other -- a literal pin, no
//      allowlist, green today;
//   B. the set of keys never reaching `showModal(` equals the allowlist below.
//
// Four declarations, not three: `modalType` and `SettingsModalsProps.modals` sit sixteen
// lines apart in the same file, which makes drift between *those two* the likeliest of the
// four. Counting them as one site would never compare them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, sourceFiles, assertSetEquals } from './reachability-shared.mjs';

const hook = fs.readFileSync(path.join(root, 'src/hooks/useModalState.ts'), 'utf8');
const modal = fs.readFileSync(path.join(root, 'src/app/_components/SettingsModal.tsx'), 'utf8');

// Quote-agnostic on purpose: useModalState.ts uses 'single' and SettingsModal.tsx "double".
// The two unions differ in case -- `ModalType` in the hook, `modalType` in the modal -- which
// is itself a small sign of how independently these four drifted apart.
const unionNames = (text, name) => {
  const m = text.match(new RegExp('type\\s+' + name + '\\s*=([^;]+);'));
  assert.ok(m, `${name} union not found — the parse target moved`);
  return new Set([...m[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((x) => x[1]));
};
const objectKeys = (text, header) => {
  const i = text.indexOf(header);
  assert.ok(i >= 0, `${header} not found — the parse target moved`);
  const body = text.slice(text.indexOf('{', i) + 1, text.indexOf('}', i));
  return new Set([...body.matchAll(/([A-Za-z0-9_]+)\s*:\s*boolean/g)].map((x) => x[1]));
};

const declarations = {
  'ModalType union (useModalState.ts)': unionNames(hook, 'ModalType'),
  'ModalState interface (useModalState.ts)': objectKeys(hook, 'interface ModalState'),
  'modalType union (SettingsModal.tsx)': unionNames(modal, 'modalType'),
  'SettingsModalsProps.modals (SettingsModal.tsx)': objectKeys(modal, 'modals: {'),
};

// --- A: the four agree ------------------------------------------------------------------
const entries = Object.entries(declarations);
const [refName, reference] = entries[0];
assert.ok(reference.size >= 4, `only ${reference.size} keys parsed from ${refName}`);
for (const [name, keys] of entries.slice(1)) {
  assert.deepEqual(
    [...keys].sort(),
    [...reference].sort(),
    `${name} does not list the same modal keys as ${refName}. All four declarations are one ` +
      'contract; change them together.'
  );
}

// --- B: which of them can be opened -----------------------------------------------------
// Allowlisted rather than fixed: #17 scopes the fix out. The entries exist so that an
// unopenable modal is a decision instead of a silence.
const NEVER_OPENED = new Set([
  'deviceSettings',  // renders DeviceSelection; the picker is reachable via the settings page instead
  'modelSettings',   // renders ModelSettingsModal; reachable via SummaryModelSettings instead
]);

const opened = new Set();
for (const f of sourceFiles()) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/showModal\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g)) opened.add(m[1]);
}

assertSetEquals(
  new Set([...reference].filter((k) => !opened.has(k))),
  NEVER_OPENED,
  'modal keys never passed to showModal(',
  'Opened one? Remove it here. Added a modal nothing opens? Add it with a reason, or wire it.'
);

console.log(
  `ok - ${reference.size} modal keys, declared in ${entries.length} places that agree; ` +
    `${opened.size} openable, ${NEVER_OPENED.size} allowlisted as unopenable`
);

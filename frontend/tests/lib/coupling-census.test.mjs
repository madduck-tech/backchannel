// What each component needs before anyone can construct it. (#102)
//
// A component that cannot render in isolation is coupled -- to a provider it does not declare, or to
// props with no sensible default. **That is a fact worth surfacing, not an obstacle to route around**,
// and this file is where the count lives so it can fall on purpose rather than drift.
//
// The census comes from `gallery.mjs`, which already renders every component in a child process under
// a kernel memory cap. One census, not two that disagree.
//
// **The assertion is one-sided, and `assertSetEquals` is deliberately not used.** That helper throws
// on STALE as well as NEW, so decoupling a component -- the improvement this file exists to
// encourage -- would turn it red. The shape here is `actual ⊆ pinned`, plus strict equality on the
// reason for entries in both, plus a floor on the denominator so shrinking the list by deleting
// components is not free.
//
// **The reason is the runtime error verbatim, and the chosen export sits beside it.** Without the
// export name, a component renamed so a different symbol is picked produces the same file and the
// same message, and the change is invisible in a diff.
//
// **Cost, measured 2026-09-08: 156 seconds** for 85 components, because `buildCards` runs them
// serially -- deliberately, after two OOM kills of a developer's machine. If that becomes intolerable
// the fix is bounded concurrency in `buildCards`, not skipping the census.
import assert from 'node:assert/strict';
import { componentFiles } from './reachability-shared.mjs';
import { census, blocked, drawn } from './coupling-census.mjs';
import { DRAWN_PIN, DRAWN_FLOOR } from './gallery.mjs';

/**
 * Every component that cannot be constructed, with the verbatim reason and the export that was
 * chosen. Entries leave when a component gains a default or declares its provider; new entries are
 * red until written down.
 */
const BLOCKED = [
  {
    file: 'src/app/_components/SettingsModal.tsx',
    kind: 'failed-on-mount',
    name: 'SettingsModals',
    reason: "Cannot read properties of undefined (reading 'modelSettings')",
  },
  {
    file: 'src/components/AISummary/Block.tsx',
    kind: 'failed-on-mount',
    name: 'BlockComponent',
    reason: "Cannot read properties of undefined (reading 'content')",
  },
  {
    file: 'src/components/AISummary/BlockNoteSummaryView.tsx',
    kind: 'will-not-load',
    name: null,
    reason: "ne.default.extend is not a function",
  },
  {
    file: 'src/components/AISummary/Section.tsx',
    kind: 'failed-on-mount',
    name: 'Section',
    reason: "Cannot read properties of undefined (reading 'title')",
  },
  {
    file: 'src/components/BlockNoteEditor/BasicBlockNoteTest.tsx',
    kind: 'will-not-load',
    name: null,
    reason: "Invalid or unexpected token",
  },
  {
    file: 'src/components/BlockNoteEditor/Editor.tsx',
    kind: 'will-not-load',
    name: null,
    reason: "ne.default.extend is not a function",
  },
  {
    file: 'src/components/ChunkProgressDisplay.tsx',
    kind: 'failed-on-mount',
    name: 'ChunkProgressDisplay',
    reason: "Cannot read properties of undefined (reading 'total_chunks')",
  },
  {
    file: 'src/components/DeviceSelection.tsx',
    kind: 'failed-on-mount',
    name: 'DeviceSelection',
    reason: "Cannot read properties of undefined (reading 'micDevice')",
  },
  {
    file: 'src/components/MeetingDetails/SummaryGeneratorButtonGroup.tsx',
    kind: 'failed-on-mount',
    name: 'SummaryGeneratorButtonGroup',
    reason: "Cannot read properties of undefined (reading 'length')",
  },
  {
    file: 'src/components/MeetingDetails/SummaryPanel.tsx',
    kind: 'will-not-load',
    name: null,
    reason: "ne.default.extend is not a function",
  },
  {
    file: 'src/components/MeetingDetails/TranscriptPanel.tsx',
    kind: 'failed-on-mount',
    name: 'TranscriptPanel',
    reason: "Cannot read properties of undefined (reading 'map')",
  },
  {
    file: 'src/components/molecules/form-components/form-input-item.tsx',
    kind: 'failed-on-mount',
    name: 'FormInputItem',
    reason: "Cannot read properties of null (reading '_names')",
  },
  {
    file: 'src/components/molecules/form-components/form-input-switch.tsx',
    kind: 'failed-on-mount',
    name: 'SwitchInput',
    reason: "Cannot read properties of null (reading '_names')",
  },
  {
    file: 'src/components/molecules/form-components/form-select-item.tsx',
    kind: 'failed-on-mount',
    name: 'FormSelectItem',
    reason: "Cannot read properties of null (reading '_names')",
  },
  {
    file: 'src/components/PaneDivider.tsx',
    kind: 'failed-on-mount',
    name: 'PaneDivider',
    reason: "Cannot read properties of undefined (reading 'min')",
  },
  {
    file: 'src/components/SettingTabs.tsx',
    kind: 'failed-on-mount',
    name: 'SettingTabs',
    reason: "Cannot read properties of undefined (reading 'apiKey')",
  },
  {
    file: 'src/components/TranscriptRecovery/TranscriptRecovery.tsx',
    kind: 'failed-on-mount',
    name: 'TranscriptRecovery',
    reason: "Cannot read properties of undefined (reading 'find')",
  },
  {
    file: 'src/components/TranscriptSettings.tsx',
    kind: 'failed-on-mount',
    name: 'TranscriptSettings',
    reason: "Cannot read properties of undefined (reading 'apiKey')",
  },
  {
    file: 'src/components/UpdateNotification.tsx',
    kind: 'no-component-export',
    name: null,
    reason: "exports nothing component-shaped: setUpdateDialogCallback, showUpdateNotification",
  },
  {
    file: 'src/components/VirtualizedTranscriptView.tsx',
    kind: 'failed-on-mount',
    name: 'VirtualizedTranscriptView',
    reason: "segments is not iterable",
  },];

/**
 * Deleting components must not be a way to shrink the list above. 85 on 2026-09-08, after
 * `AudioPlayer.tsx` -- zero bytes, imported by nothing -- was removed from the tree and from the
 * three allowlists that named it.
 */
const COMPONENT_FLOOR = 85;

const components = componentFiles();
assert.ok(
  components.length >= COMPONENT_FLOOR,
  `${components.length} components; the floor is ${COMPONENT_FLOOR}. Components were deleted, which ` +
    'shrinks the blocked list for free. Lower the floor deliberately, in the same change.'
);

const pinned = new Map(BLOCKED.map((b) => [b.file, b]));
// One census, two issues. Rendering 85 components costs 156 seconds; running it twice would cost
// 312, and `node --test` gives each file its own process, so the two sets of assertions share a file
// rather than a cache that cannot exist across processes.
const cards = census(components);
const actual = new Map(blocked(cards).map((b) => [b.file, b]));

// --- nothing is blocked that is not written down --------------------------------------------------
const unlisted = [...actual.keys()].filter((f) => !pinned.has(f)).sort();
assert.deepEqual(
  unlisted, [],
  'these components cannot be constructed and are not written down:\n    ' +
    unlisted.map((f) => `${f}  ->  ${actual.get(f).reason}`).join('\n    ') +
    '\n\n  Give it a default or a declared provider, or add it to BLOCKED with its verbatim reason.'
);

// --- for the ones in both, the reason and the export are exactly what is pinned --------------------
const drifted = [...actual.values()]
  .filter((a) => pinned.has(a.file))
  .map((a) => ({ a, p: pinned.get(a.file) }))
  .filter(({ a, p }) => a.kind !== p.kind || a.reason !== p.reason || a.name !== p.name)
  .map(({ a, p }) =>
    `${a.file}\n      pinned: ${p.kind} / ${p.name} / ${p.reason}\n      actual: ${a.kind} / ${a.name} / ${a.reason}`);
assert.deepEqual(
  drifted, [],
  'the reason a component is blocked has changed:\n    ' + drifted.join('\n    ') +
    '\n\n  Update the pin in the same change that changed the behaviour.'
);

// --- and a component that became constructible is reported, never red -----------------------------
const freed = [...pinned.keys()].filter((f) => !actual.has(f)).sort();
if (freed.length) {
  console.log(
    `ok - ${freed.length} component(s) can now be constructed and their lines in BLOCKED are ` +
      `removable:\n    ${freed.join('\n    ')}`
  );
}

// --- #100 condition 5: a component that used to draw still draws -----------------------------------
//
// `DRAWN_PIN` and `DRAWN_FLOOR` have lived in `gallery.mjs`'s main block since #108, which runs as its
// own CI step and **not** under `pnpm test`. So the one guard against a rendering component quietly
// becoming unrenderable was outside the glob `ignored-tests-are-run.test.mjs` enforces -- a check this
// repository could not prove it runs. It runs here now, on the census that was taken anyway.
const drew = drawn(cards);
const lost = DRAWN_PIN.filter((f) => !drew.has(f));
assert.deepEqual(
  lost, [],
  'components that used to draw no longer do:\n    ' +
    lost.map((f) => `${f}  ->  ${cards.find((c) => c.file === f)?.kind ?? 'missing'}`).join('\n    ') +
    '\n\n  Either fix it, or update DRAWN_PIN in gallery.mjs deliberately.'
);
assert.ok(
  drew.size >= DRAWN_FLOOR,
  `${drew.size} components draw; the floor is ${DRAWN_FLOOR}. Something that drew stopped. ` +
    'Raise the floor when the number goes up, never to make this pass.'
);

console.log(
  `ok - ${actual.size} of ${components.length} components cannot be constructed, each with its ` +
    `reason; ${drew.size} draw, floor ${DRAWN_FLOOR}, ${DRAWN_PIN.length} pinned`
);

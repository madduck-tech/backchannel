// Components no page can reach.
//
// Reachability, not "has an importer". `CustomDialog.tsx` is imported by nothing, and
// `SettingTabs.tsx` -- which it renders -- is imported by exactly one file: `CustomDialog`
// itself. A check asking "does anything import this" passes SettingTabs and misses the
// interior of a dead subtree, which is the middle of the very chain #17 cites as evidence.
// So: reachable by import, transitively, from a Next entry file.
//
// `src/components/ui/**` is excluded by rule. `components.json` vendors shadcn there, so
// those files are generated rather than written here, and a vendored primitive nobody has
// used yet is not the class this hunts -- that class is surface which was wired and rotted,
// or added and never wired. Including them would turn CI red on unrelated pull requests both
// for `shadcn add` and for *using* a primitive, which is how a `ui/**` wildcard ends up in
// the allowlist under pressure. The three `molecules/form-components/*` files are ours, not
// vendored, and stay in scope.
import assert from 'node:assert/strict';
import { sourceFiles, rel, reachableFromEntries, entryFiles, assertSetEquals } from './reachability-shared.mjs';

const UNREACHABLE = new Set([
  // Dead subtree: nothing imports CustomDialog, and SettingTabs dies with it. The components
  // SettingTabs renders -- RecordingSettings, ModelSettingsModal -- survive through other
  // importers, which is the point: this is a dead second entrance to live components.
  'src/components/CustomDialog.tsx',
  'src/components/SettingTabs.tsx',
  // Ours, not vendored, never reached.
  'src/components/molecules/form-components/form-input-item.tsx',
  'src/components/molecules/form-components/form-input-switch.tsx',
  'src/components/molecules/form-components/form-select-item.tsx',
  // Written and never surfaced.
  'src/components/AudioPlayer.tsx',
  'src/components/BluetoothPlaybackWarning.tsx',
  'src/components/ComplianceNotification.tsx',
  'src/components/MessageToast.tsx',
  'src/components/ChunkProgressDisplay.tsx',
  'src/components/MainNav/index.tsx',
  'src/components/BlockNoteEditor/BasicBlockNoteTest.tsx',
  'src/components/DatabaseImport/LegacyDatabaseImport.tsx',
  'src/components/DatabaseImport/HomebrewDatabaseDetector.tsx',
]);

const VENDORED = /^src\/components\/ui\//;

const files = sourceFiles();
const reachable = reachableFromEntries(files);
const entries = entryFiles(files);

assert.ok(entries.length > 0, 'no Next entry files found — the glob moved');

const unreachable = new Set(
  files
    .filter((f) => !reachable.has(f))
    .map(rel)
    .filter((f) => f.startsWith('src/components/') && !VENDORED.test(f))
);

assertSetEquals(
  unreachable,
  UNREACHABLE,
  'components unreachable from any Next entry file',
  'Wired one up? Remove it here. Added a component nothing renders? Add it with a reason, or ' +
    'render it. Deleted one? Remove it here too. Do not add a src/components/ui/** wildcard: ' +
    'that directory is already excluded by rule above.'
);

console.log(
  `ok - ${entries.length} entry files; ${UNREACHABLE.size} components allowlisted as unreachable, ` +
    'src/components/ui/** excluded by rule'
);

// Components no page can reach.
//
// Reachability, not "has an importer". `CustomDialog.tsx` is imported by nothing, and until `91e901d`
// it rendered `SettingTabs.tsx`, which was then imported by exactly one file: `CustomDialog` itself.
// A check asking "does anything import this" passed SettingTabs and missed the interior of a dead
// subtree, which is the middle of the very chain #17 cites as evidence. So: reachable by import,
// transitively, from a Next entry file.
//
// The chain is gone -- #147 removed the unused import while switching `no-unused-vars` back on, so
// today they are two separately dead files rather than a subtree, and this paragraph would read as a
// live example of something no longer in the tree. Kept in the past tense because it is the reason
// the rule is transitive, and corrected because a rationale presented as a current fact is a stale
// excuse (#160).
//
// `src/components/ui/**` is excluded by rule. `components.json` vendors shadcn there, so
// those files are generated rather than written here, and a vendored primitive nobody has
// used yet is not the class this hunts -- that class is surface which was wired and rotted,
// or added and never wired. Including them would turn CI red on unrelated pull requests both
// for `shadcn add` and for *using* a primitive, which is how a `ui/**` wildcard ends up in
// the allowlist under pressure. The three `molecules/form-components/*` files are ours, not
// vendored, and stay in scope.
import assert from 'node:assert/strict';
import { sourceFiles, rel, reachableFromEntries, entryFiles, assertSetEquals, STORY_FILES } from './reachability-shared.mjs';

const UNREACHABLE = new Set([
  // Both dead: nothing imports CustomDialog, and nothing imports SettingTabs either since #147 took
  // the unused import out of it. Until then it was one subtree. The components
  // SettingTabs renders -- RecordingSettings, ModelSettingsModal -- survive through other
  // importers, which is the point: this is a dead second entrance to live components.
  'src/components/CustomDialog.tsx',
  'src/components/SettingTabs.tsx',
  // Ours, not vendored, never reached.
  'src/components/molecules/form-components/form-input-item.tsx',
  'src/components/molecules/form-components/form-input-switch.tsx',
  'src/components/molecules/form-components/form-select-item.tsx',
  // Written and never surfaced.
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
    // A story is unreachable from a Next entry **by construction** -- that is what a story is. Listing
    // them in UNREACHABLE would grow that allowlist by one line per story forever, which is how an
    // allowlist stops being read (#124).
    .filter((f) => f.startsWith('src/components/') && !VENDORED.test(f) && !STORY_FILES.test(f))
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

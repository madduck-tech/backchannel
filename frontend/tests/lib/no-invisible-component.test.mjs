// A component cannot arrive invisible.
//
// #98. The check this replaces made the dilution visible and made it cost nothing: its own failure
// message said *"If you added a component, raise TOTAL"*, and one character made it green again.
// Measured before the change: add `src/components/Probe.tsx` with no test -> red at 10/76; change
// `const TOTAL = 75;` to `76` -> green.
//
// **Five routes let a component arrive unrendered. Three close here; two are named below.**
// The third is why the first design of this was worse than doing nothing: the numerator used to be a
// regex over *every* `.mjs` under `tests/`, so a single line in a helper `pnpm test` never runs --
//     export const NOTE = "loadTsx('src/components/Probe.tsx')";
// -- moved the numerator from 10 to 11. Under set equality that is a green CI with no test, no reason
// and no allowlist edit: the escape relocated from a constant in this file, where a reviewer's eye is
// trained, into a plausible line in a stub. The numerator is now scanned only in `*.test.mjs`.
//
// **Two lists, and only one of them can grow.** `BACKLOG` holds what predates the rule; entries only
// ever leave it. `EXCEPTIONS` starts empty and each entry carries its own reason. One 68-entry list
// sharing one sentence would make the 69th a line pasted into the middle of a block whose neighbours
// are indistinguishable from it -- the least visible diff this repository can produce.
// `NEVER_INVOKED` works because it holds *one* entry with a ten-line reason, where a second is
// conspicuous by arithmetic.
//
// **The ratio is printed, never asserted.** Pinning it is what made adding a component *with* a test
// go red, and a rule that punishes the right behaviour is an obstacle rather than a rule.
//
// **Plus a floor, because set equality alone loses a tooth.** Deleting a rendered component together
// with its test is red today and green under equality alone. The header of the check this replaces
// rejected a ratchet -- but as a *substitute* for the denominator pin ("add fifty components, cover
// none, stay green"), and the allowlist closes exactly that. Equality plus a floor is not what that
// argument was against.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles, rel, assertSetEquals, componentFiles } from './reachability-shared.mjs';

// The scope rule moved to `reachability-shared.mjs` in #107 and is imported, not copied: the gallery
// holds the same denominator, and two copies of it drift. `SettingsModal.tsx` is already a parse
// target of `modal-reachability.test.mjs`; before #98 a component added under `src/app/_components/`
// was invisible with zero edits.

/**
 * Everything that predates this rule. **Entries only ever leave.** One collective reason, because
 * inventing 68 individual ones for components nobody has looked at would read as considered and be
 * false. Each one that gains a test is deleted from here.
 */
const BACKLOG = new Set([
  'src/app/_components/SettingsModal.tsx',
  'src/app/_components/StatusOverlays.tsx',
  'src/app/_components/TranscriptPanel.tsx',
  'src/components/AISummary/Block.tsx',
  'src/components/AISummary/BlockNoteSummaryView.tsx',
  'src/components/AISummary/Section.tsx',
  'src/components/AISummary/index.tsx',
  'src/components/About.tsx',
  'src/components/AudioBackendSelector.tsx',
  'src/components/AudioPlayer.tsx',
  'src/components/BlockNoteEditor/BasicBlockNoteTest.tsx',
  'src/components/BlockNoteEditor/Editor.tsx',
  'src/components/BluetoothPlaybackWarning.tsx',
  'src/components/ChunkProgressDisplay.tsx',
  'src/components/ComplianceNotification.tsx',
  'src/components/ConfidenceIndicator.tsx',
  'src/components/ConfirmationModel/confirmation-modal.tsx',
  'src/components/ConsoleToggle.tsx',
  'src/components/CustomDialog.tsx',
  'src/components/DatabaseImport/HomebrewDatabaseDetector.tsx',
  'src/components/DatabaseImport/LegacyDatabaseImport.tsx',
  'src/components/EditableTitle.tsx',
  'src/components/EmptyStateSummary.tsx',
  'src/components/ImportAudio/ImportDropOverlay.tsx',
  'src/components/Info.tsx',
  'src/components/LanguagePickerPopover.tsx',
  'src/components/LanguageSelection.tsx',
  'src/components/LiveIndicator.tsx',
  'src/components/Logo.tsx',
  'src/components/MainContent/index.tsx',
  'src/components/MainNav/index.tsx',
  'src/components/MeetingDetails/SummaryGeneratorButtonGroup.tsx',
  'src/components/MeetingDetails/SummaryPanel.tsx',
  'src/components/MeetingDetails/SummaryUpdaterButtonGroup.tsx',
  'src/components/MeetingDetails/TranscriptButtonGroup.tsx',
  'src/components/MeetingDetails/TranscriptPanel.tsx',
  'src/components/MessageToast.tsx',
  'src/components/PaneDivider.tsx',
  'src/components/PermissionWarning.tsx',
  'src/components/PreferenceSettings.tsx',
  'src/components/RecordingSettings.tsx',
  'src/components/RecordingStatusBar.tsx',
  'src/components/SettingTabs.tsx',
  'src/components/Sidebar/SidebarProvider.tsx',
  'src/components/SpeakerLabelSettings.tsx',
  'src/components/SummaryLanguageSettings.tsx',
  'src/components/SummaryModelSettings.tsx',
  'src/components/SummaryTemplateSettings.tsx',
  'src/components/ThemeToggle.tsx',
  'src/components/TranscriptRecovery/TranscriptRecovery.tsx',
  'src/components/TranscriptSettings.tsx',
  'src/components/TranscriptionModelManager.tsx',
  'src/components/UpdateCheckProvider.tsx',
  'src/components/UpdateDialog.tsx',
  'src/components/UpdateNotification.tsx',
  'src/components/molecules/form-components/form-input-item.tsx',
  'src/components/molecules/form-components/form-input-switch.tsx',
  'src/components/molecules/form-components/form-select-item.tsx',
  'src/components/onboarding/OnboardingContainer.tsx',
  'src/components/onboarding/OnboardingFlow.tsx',
  'src/components/onboarding/shared/PermissionRow.tsx',
  'src/components/onboarding/shared/ProgressIndicator.tsx',
  'src/components/onboarding/shared/StatusIndicator.tsx',
  'src/components/onboarding/steps/PermissionsStep.tsx',
  'src/components/onboarding/steps/SetupOverviewStep.tsx',
  'src/components/onboarding/steps/WelcomeStep.tsx',
  'src/components/shared/DownloadProgressToast.tsx',
]);

/**
 * A component that may ship without a test, deliberately. **Starts empty.** Each key needs its own
 * non-empty reason -- an entry cannot be added by pasting a path.
 */
const EXCEPTIONS = {};

const components = componentFiles();

// Only files the runner actually runs. `pnpm test` globs `tests/**/*.test.mjs`, and
// `ignored-tests-are-run.test.mjs` sanctions everything else under `tests/` as a helper -- so a
// helper is exactly where a forged numerator would hide.
const here = path.dirname(new URL(import.meta.url).pathname);
const rendered = new Set();
for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs'))) {
  const body = fs
    .readFileSync(path.join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const m of body.matchAll(/loadTsx\(\s*['"]([^'"]+)['"]/g)) {
    if (components.includes(m[1])) rendered.add(m[1]);
  }
}

const unrendered = new Set(components.filter((c) => !rendered.has(c)));
const allowed = new Set([...BACKLOG, ...Object.keys(EXCEPTIONS)]);

// --- every exception carries a reason -------------------------------------------------------------
{
  const empty = Object.entries(EXCEPTIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
    .map(([p]) => p);
  assert.deepEqual(
    empty,
    [],
    'these exceptions have no reason:\n    ' + empty.join('\n    ') +
      '\n\n  An entry that can be added by pasting a path is not an exception, it is an omission.'
  );
}

// --- the set of components with no test is exactly what is written down ---------------------------
assertSetEquals(
  unrendered,
  allowed,
  'components with no test that renders them',
  'A component arrived with no test. Give it one -- `loadTsx(\'<its path>\')` in a `*.test.mjs` -- ' +
    'or add it to EXCEPTIONS with a reason of its own. BACKLOG is closed: entries only leave it.\n' +
    '  Raising a number does not help; there is no number here any more.'
);

// --- and the count of rendered components never falls ---------------------------------------------
//
// Set equality alone would let a rendered component and its test disappear together in silence.
const FLOOR = 11;
assert.ok(
  rendered.size >= FLOOR,
  `${rendered.size} components are rendered by a test; the floor is ${FLOOR}. Something that had a ` +
    'test lost it. Raise the floor when the number goes up, never to make this pass.'
);

const pct = ((rendered.size / components.length) * 100).toFixed(1);
console.log(
  `ok - ${rendered.size} of ${components.length} components (${pct}%) are rendered by a test; ` +
    `${BACKLOG.size} in the backlog, ${Object.keys(EXCEPTIONS).length} deliberate exceptions`
);

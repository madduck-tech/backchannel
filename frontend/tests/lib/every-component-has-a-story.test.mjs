// Every component either has a story, or is written down as not having one. (#124 condition 5)
//
// The shape is `no-invisible-component.test.mjs`'s, and deliberately: set equality on the remainder
// plus a floor on the number that is meant to rise. #100's condition 5 pinned the number meant to
// *fall* instead, so its own control could move it up and pass -- the mistake this file exists not to
// repeat.
//
// **Adding a component with no story is red. Landing a story is never red.** That asymmetry is the
// whole design: a rule that punishes the right behaviour is an obstacle rather than a rule.
//
// `WITHOUT_STORY` opened at 84 of 86 on 2026-09-08, the day the instrument landed. Entries only ever
// leave it. It is not a backlog of intentions -- a component in this list is one nobody can see in a
// real browser, and #100's gallery draws it in jsdom, which computes no layout at all.
import assert from 'node:assert/strict';
import { componentFiles, sourceFiles, rel, assertSetEquals } from './reachability-shared.mjs';

/** Components with no `*.stories.tsx` beside them. Entries only ever leave. */
const WITHOUT_STORY = new Set([
  'src/app/_components/SettingsModal.tsx',
  'src/app/_components/StatusOverlays.tsx',
  'src/app/_components/TranscriptPanel.tsx',
  'src/components/AISummary/Block.tsx',
  'src/components/AISummary/BlockNoteSummaryView.tsx',
  'src/components/AISummary/Section.tsx',
  'src/components/AISummary/index.tsx',
  'src/components/About.tsx',
  'src/components/AppToaster.tsx',
  'src/components/AudioBackendSelector.tsx',
  'src/components/AudioLevelMeter.tsx',
  'src/components/BlockNoteEditor/BasicBlockNoteTest.tsx',
  'src/components/BlockNoteEditor/Editor.tsx',
  'src/components/BluetoothPlaybackWarning.tsx',
  'src/components/BuiltInModelManager.tsx',
  'src/components/ChunkProgressDisplay.tsx',
  'src/components/ComplianceNotification.tsx',
  'src/components/ConfidenceIndicator.tsx',
  'src/components/ConfirmationModel/confirmation-modal.tsx',
  'src/components/ConsoleToggle.tsx',
  'src/components/CustomDialog.tsx',
  'src/components/DatabaseImport/HomebrewDatabaseDetector.tsx',
  'src/components/DatabaseImport/LegacyDatabaseImport.tsx',
  'src/components/DeviceSelection.tsx',
  'src/components/EditableTitle.tsx',
  'src/components/EmptyStateSummary.tsx',
  'src/components/ImportAudio/ImportAudioDialog.tsx',
  'src/components/ImportAudio/ImportDropOverlay.tsx',
  'src/components/Info.tsx',
  'src/components/LanguagePickerPopover.tsx',
  'src/components/LanguageSelection.tsx',
  'src/components/LiveIndicator.tsx',
  'src/components/Logo.tsx',
  'src/components/MainContent/index.tsx',
  'src/components/MainNav/index.tsx',
  'src/components/MeetingDetails/RetranscribeDialog.tsx',
  'src/components/MeetingDetails/SummaryGeneratorButtonGroup.tsx',
  'src/components/MeetingDetails/SummaryPanel.tsx',
  'src/components/MeetingDetails/SummaryUpdaterButtonGroup.tsx',
  'src/components/MeetingDetails/TranscriptPanel.tsx',
  'src/components/MessageToast.tsx',
  'src/components/ModelSettingsModal.tsx',
  'src/components/PaneDivider.tsx',
  'src/components/PermissionWarning.tsx',
  'src/components/PreferenceSettings.tsx',
  'src/components/RecordingClocks.tsx',
  'src/components/RecordingControls.tsx',
  'src/components/RecordingSettings.tsx',
  'src/components/SettingTabs.tsx',
  'src/components/Sidebar/SidebarProvider.tsx',
  'src/components/Sidebar/index.tsx',
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
  'src/components/onboarding/steps/AudioCheckStep.tsx',
  'src/components/onboarding/steps/DownloadProgressStep.tsx',
  'src/components/onboarding/steps/PermissionsStep.tsx',
  'src/components/onboarding/steps/SummariserStep.tsx',
  'src/components/onboarding/steps/TranscriptionModelStep.tsx',
  'src/components/shared/DownloadProgressToast.tsx',
  'src/contexts/ConfigContext.tsx',
  'src/contexts/ImportDialogContext.tsx',
  'src/contexts/OllamaDownloadContext.tsx',
  'src/contexts/OnboardingContext.tsx',
  'src/contexts/RecordingPostProcessingProvider.tsx',
  'src/contexts/RecordingStateContext.tsx',
  'src/contexts/TranscriptContext.tsx',
]);

const components = componentFiles();

/** A story sits beside its component: `Foo.stories.tsx` next to `Foo.tsx`. */
const storied = new Set(
  sourceFiles()
    .map(rel)
    .filter((f) => f.endsWith('.stories.tsx'))
    .map((f) => f.replace(/\.stories\.tsx$/, '.tsx'))
);

const withStory = new Set(components.filter((c) => storied.has(c)));
const withoutStory = new Set(components.filter((c) => !storied.has(c)));

// --- the set with no story is exactly what is written down ----------------------------------------
assertSetEquals(
  withoutStory,
  WITHOUT_STORY,
  'components with no story',
  'A component arrived with no story, or one gained a story and the list was not trimmed.\n' +
    '  Write `<Name>.stories.tsx` beside it, then delete its line from WITHOUT_STORY.'
);

// --- and the number that has one never falls ------------------------------------------------------
//
// Set equality alone would let a component and its story disappear together in silence.
const FLOOR = 2;
assert.ok(
  withStory.size >= FLOOR,
  `${withStory.size} components have a story; the floor is ${FLOOR}. Something lost one. ` +
    'Raise the floor when the number goes up, never to make this pass.'
);

const pct = ((withStory.size / components.length) * 100).toFixed(1);
console.log(
  `ok - ${withStory.size} of ${components.length} components (${pct}%) have a story; ` +
    `${WITHOUT_STORY.size} written down as not`
);

// The first-run download screen waits for the model the person chose, not for any model. (#170)
//
// `parakeetDownloaded` decides whether Continue is offered, whether the footer says "Everything you
// chose is on this device.", and whether the chosen row says "Already here from an earlier install".
// Two sites set it from `transcribe_has_available_models`, which is "is SOME model on disk": the
// step's mount check and the provider's resume. So anyone with a leftover model, who chose another,
// was offered Continue for a file still on its way.
//
// **The real provider, not a stub of it.** `first-run-step.test.mjs` hands the step a constant flag,
// which cannot see who sets the flag or when. #170's critic measured that its #92 assertion stayed
// green with the fix removed. Here the provider and the step are the application's own, and only the
// disk is stubbed, through `transcribe_get_available_models` and the any-model command beside it. So
// `main` is red for the reason the person saw.
//
// **Why the selection change matters.** Any first run left open for a second resumes at step 1 or 2
// (the 1 s auto-save writes `current_step`). So the default is checked, found on disk, and then the
// person picks another model. Before #170 the flag stayed true for the default. A recompute on the
// step's mount alone came too late: the step reads the flag on its first render (#170's critic,
// rounds 3 and 4).
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const DEFAULT = 'parakeet-tdt-0.6b-v3-q8';
const OTHER = 'moonshine-tiny-q8';
const EVERYTHING = 'Everything you chose is on this device.';
const ALREADY = 'Already here from an earlier install';

const mounted = [];
/**
 * A command's next answer, held until the test releases it. The races below are about an answer that
 * arrives after the person has chosen again, so the test decides when each one lands.
 */
function holdable() {
  const queue = [];
  const h = {
    /** How many held answers have been handed back: the sentinel that the late answer landed. */
    released: 0,
    hold() {
      let release;
      const gate = new Promise((r) => { release = r; });
      queue.push(gate);
      return () => release();
    },
    async pass(answer) {
      const gate = queue.shift();
      if (gate) { await gate; h.released += 1; }
      return answer();
    },
  };
  return h;
}
// Longer than `settle`: a late answer may be applied a little after it lands, and the check below has
// to outlast that, or a stale write that comes later than this reads as one that never came.
const outlast = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });
async function mount({ onDisk = [], saved = null, disk = holdable(), summaryReady = holdable() } = {}) {
  const stubs = tauriStubs({
    extra: {
      transcribe_init: null,
      transcribe_has_available_models: () => onDisk.length > 0,
      transcribe_get_available_models: () => disk.pass(() => onDisk.map((name) => ({ name, status: 'Available' }))),
      // Accepted and never finished: the download stays in flight, which is the moment that matters.
      transcribe_download_model: () => new Promise(() => {}),
      transcribe_list_models: [],
      builtin_ai_download_model: () => new Promise(() => {}),
      builtin_ai_list_models: [],
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      builtin_ai_is_model_ready: () => summaryReady.pass(() => true),
      get_onboarding_status: saved,
      save_onboarding_status: null,
      complete_onboarding: null,
      check_first_launch: !saved,
      check_database_exists: false,
      get_permission_status: {},
      // The provider's database start-up, which is not under test here.
      check_default_legacy_database: false,
      initialize_fresh_database: null,
    },
  });
  const modules = {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
  };
  const context = loadTsx('src/contexts/OnboardingContext.tsx', modules);
  const motionProxy = new Proxy({}, { get: () => (props) => React.createElement('div', null, props?.children) });
  const { DownloadProgressStep } = loadTsx('src/components/onboarding/steps/DownloadProgressStep.tsx', {
    ...modules,
    // The application's own provider module, so the step reads the context the provider writes.
    '@/contexts/OnboardingContext': context,
    // Renders the footer as well as the children: #154 put the forward control there.
    '../OnboardingContainer': {
      OnboardingContainer: ({ children, footer }) => React.createElement('div', null, children, React.createElement('footer', null, footer)),
    },
    'framer-motion': { motion: motionProxy, AnimatePresence: ({ children }) => children },
  });

  // Every value of the flag, each with the step it was rendered at, from the probe's first render.
  const seen = [];
  let ctx = null;
  const Probe = () => {
    ctx = context.useOnboarding();
    seen.push({ step: ctx.currentStep, model: ctx.selectedTranscribeModel, flag: ctx.parakeetDownloaded });
    return ctx.currentStep === 3 ? React.createElement(DownloadProgressStep) : null;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(context.OnboardingProvider, null, React.createElement(Probe))); });
  await settle();
  mounted.push({ root, container });
  return { container, seen, ctx: () => ctx, stubs };
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); });
const clear = async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
};
const continueButton = (c) => c.querySelector('footer button');
const chosenRow = (c, name) => c.querySelector(`section[aria-label="${name}"]`);

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

// 1a-1d: a fresh first run, the default on disk, another model chosen.
{
  const m = await mount({ onDisk: [DEFAULT] });
  await act(async () => { m.ctx().setSelectedTranscribeModel(OTHER); });
  await settle();
  const from = m.seen.length;
  await act(async () => { m.ctx().goToStep(3); });
  await settle();
  const go = continueButton(m.container);
  check('1a Continue waits for the chosen model', go && go.disabled === true, `footer button ${go ? `disabled=${go.disabled}` : 'missing'}`);
  check('1b nothing says everything is here', !m.container.textContent.includes(EVERYTHING), `the screen reads "${EVERYTHING}" while ${OTHER} is not on disk`);
  const row = chosenRow(m.container, OTHER);
  check('1c the chosen row is not "already here"', row && !row.textContent.includes(ALREADY), row ? `the ${OTHER} row reads "${row.textContent.slice(0, 120)}"` : `no row for ${OTHER}`);
  const atStep3 = m.seen.slice(from).filter((s) => s.step === 3);
  check('1d the flag is never true from step 3 on', atStep3.length > 0 && atStep3.every((s) => s.flag === false),
    `step-3 renders: ${JSON.stringify(atStep3.map((s) => s.flag))}`);
  await clear();
}

// 2: resumed at step 3, only a model that is not the chosen one on disk.
{
  const m = await mount({ onDisk: [OTHER], saved: { version: '1.0', completed: false, current_step: 3, model_status: { parakeet: 'not_downloaded', summary: 'not_downloaded' } } });
  check('2 a resume does not take another model for the chosen one', m.ctx().parakeetDownloaded === false,
    `parakeetDownloaded is ${m.ctx().parakeetDownloaded} with only ${OTHER} on disk and ${m.ctx().selectedTranscribeModel} chosen`);
  await clear();
}

// 2b: resumed at step 1 with the default on disk, then another model chosen.
{
  const m = await mount({ onDisk: [DEFAULT], saved: { version: '1.0', completed: false, current_step: 1, model_status: { parakeet: 'not_downloaded', summary: 'not_downloaded' } } });
  await act(async () => { m.ctx().setSelectedTranscribeModel(OTHER); });
  await settle();
  check('2b the flag answers for the new choice before step 3', m.ctx().parakeetDownloaded === false,
    `parakeetDownloaded is ${m.ctx().parakeetDownloaded} after choosing ${OTHER}, with only ${DEFAULT} on disk`);
  await act(async () => { m.ctx().goToStep(3); });
  await settle();
  const go = continueButton(m.container);
  const row = chosenRow(m.container, OTHER);
  check('2b then step 3 waits', go && go.disabled === true && !m.container.textContent.includes(EVERYTHING) && row && !row.textContent.includes(ALREADY),
    `disabled=${go?.disabled}, everything=${m.container.textContent.includes(EVERYTHING)}, already=${row?.textContent.includes(ALREADY)}`);
  await clear();
}

// 2c: a resume whose answer arrives after the person has chosen again. Resumed at step 1 with the
// default on disk; the summary check is held, so the resume's flag lands after `OTHER` is picked. The
// resume asked about the default, and its answer must not stand for the new choice. (#170's gate,
// adversary finding 2)
{
  const summaryReady = holdable();
  const releaseResume = summaryReady.hold();
  const m = await mount({ onDisk: [DEFAULT], summaryReady, saved: { version: '1.0', completed: false, current_step: 1, model_status: { parakeet: 'not_downloaded', summary: 'not_downloaded' } } });
  await act(async () => { m.ctx().setSelectedTranscribeModel(OTHER); });
  await settle();
  const before = m.ctx().parakeetDownloaded;
  releaseResume();
  await settle();
  await outlast();
  // The sentinel: only the resume sets the summary flag in this run, so it is true once the resume's
  // answer has been applied. Without it, "the flag stayed false" could mean the answer never arrived.
  check('2c precondition: the resume finished', summaryReady.released === 1 && m.ctx().summaryModelDownloaded === true,
    `held answers released: ${summaryReady.released}; summaryModelDownloaded is ${m.ctx().summaryModelDownloaded}`);
  check('2c a late resume answer does not answer for a newer choice', before === false && m.ctx().parakeetDownloaded === false,
    `parakeetDownloaded is ${before} after choosing ${OTHER} and ${m.ctx().parakeetDownloaded} once the resume's check of ${DEFAULT} returned`);
  await act(async () => { m.ctx().goToStep(3); });
  await settle();
  const go = continueButton(m.container);
  const row = chosenRow(m.container, OTHER);
  check('2c then step 3 waits', go && go.disabled === true && !m.container.textContent.includes(EVERYTHING) && row && !row.textContent.includes(ALREADY),
    `disabled=${go?.disabled}, everything=${m.container.textContent.includes(EVERYTHING)}, already=${row?.textContent.includes(ALREADY)}`);
  await clear();
}

// 1e: two quick choices, the first on disk and its answer late, the second not on disk. The first
// answer must not stand for the second. (#170's gate, adversary finding 3)
{
  const SECOND_ON_DISK = 'nemotron-3.5-asr-streaming-0.6b-q8';
  const disk = holdable();
  const m = await mount({ onDisk: [DEFAULT, SECOND_ON_DISK], disk });
  const releaseFirst = disk.hold();
  await act(async () => { m.ctx().setSelectedTranscribeModel(SECOND_ON_DISK); });
  await act(async () => { m.ctx().setSelectedTranscribeModel(OTHER); });
  await settle();
  releaseFirst();
  await settle();
  await outlast();
  check('1e precondition: the earlier choice\'s answer landed', disk.released === 1, `held answers released: ${disk.released}`);
  check('1e a late disk answer for an earlier choice does not answer for the current one', m.ctx().parakeetDownloaded === false,
    `parakeetDownloaded is ${m.ctx().parakeetDownloaded} with ${OTHER} chosen, once the check of ${SECOND_ON_DISK} returned`);
  await clear();
}

// 3b: a choice that is on disk is known to be before step 3, and choosing it again does not unset it.
{
  const m = await mount({ onDisk: [DEFAULT, OTHER] });
  await act(async () => { m.ctx().setSelectedTranscribeModel(OTHER); });
  await settle();
  check('3b a chosen model on disk is known before step 3', m.ctx().parakeetDownloaded === true,
    `parakeetDownloaded is ${m.ctx().parakeetDownloaded} after choosing ${OTHER}, which is on disk`);
  const from = m.seen.length;
  await act(async () => { m.ctx().setSelectedTranscribeModel(OTHER); });
  await settle();
  const after = m.seen.slice(from).map((x) => x.flag);
  check('3b choosing the same model again does not unset it', after.every((f) => f === true),
    `renders after choosing ${OTHER} again: ${JSON.stringify(after)}`);
  await clear();
}

// 3: #92 holds. The chosen file is present and the flag starts unset: Continue is offered at once.
{
  const m = await mount({ onDisk: [DEFAULT] });
  check('3 precondition: the flag starts unset', m.ctx().parakeetDownloaded === false, `parakeetDownloaded is ${m.ctx().parakeetDownloaded} on a fresh mount`);
  await act(async () => { m.ctx().goToStep(3); });
  await settle();
  const go = continueButton(m.container);
  check('3 a chosen model already on disk is not waited for (#92)', go && go.disabled === false, `footer button ${go ? `disabled=${go.disabled}` : 'missing'}`);
  check('3 and the row says it was already here', chosenRow(m.container, DEFAULT)?.textContent.includes(ALREADY) === true, 'the row does not say it was already here');
  await clear();
}

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log(`ok - first-run download: Continue, the footer and the chosen row wait for the chosen model, on a fresh run, on resume, and after a choice made following a resume; a chosen model already on disk is offered at once (#92)`);

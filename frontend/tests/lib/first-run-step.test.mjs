// What the first screen a new user meets refuses to do, driven rather than read.
//
// #66, component 8 of 8. The issue's row: *"first-run; a defect here is the first thing a new user
// meets"*. 540 lines, never rendered. Its whole job is to not let someone past until the thing the
// application exists for can work.
//
//   1. **Continue is refused until the transcription model is there.** Past this screen with no
//      engine, a new user has an app whose one job it cannot do, and nothing tells them why.
//   2. **Continue verifies against the backend, not against remembered state.** The component calls
//      `transcribe_init` and `transcribe_has_available_models` every time; its own comment says
//      "catches state drift". Trusting the flag alone is how a reinstall or a deleted model becomes
//      a broken first run.
//   3. **The drift repair the component advertises cannot run.** `handleContinue` contains
//      `if (actuallyAvailable && !parakeetDownloaded) { setParakeetDownloaded(true); … }` with the
//      comment "catches state drift" — but the only control that calls `handleContinue` is
//      `disabled={!parakeetDownloaded || isCompleting}`. The branch needs `parakeetDownloaded`
//      false; the button is disabled by exactly that. **A user whose model is on disk while the
//      flag says otherwise is stuck at a disabled button forever, and the code written to rescue
//      them is unreachable.** Filed separately; assertion 1 below is what pins the reachability
//      fact, and this test does not pretend to cover a branch nothing can enter.
//   4. **Onboarding is completed exactly once per press**, and a failure to complete gives the
//      button back instead of stranding the user on a spinner.
//
// Three behaviours asserted, three controls; the fourth entry above is a defect this test found
// and does not cover, because it cannot be reached.
//
// Scaffolding divergences, written where the next person reads them (#66 condition 4):
//  * `window.location.reload()` runs on the success path. In jsdom it is a non-configurable no-op
//     that logs "Not implemented: navigation". That is a *divergence*: the real app reloads and
//     this does not, so nothing after the reload is asserted here.
//   * `framer-motion` is stubbed to plain elements — animation is not behaviour.
//   * `useOnboarding` is stubbed and hands back one object per render.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

function harness({
  parakeetDownloaded = true,
  hasAvailableModels = true,
  failComplete = false,
} = {}) {
  const seen = { completed: 0, next: 0, parakeetSet: [], reloads: 0 };
  const stubs = tauriStubs({
    extra: {
      transcribe_init: null,
      transcribe_has_available_models: () => hasAvailableModels,
      transcribe_download_model: null,
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
    },
  });
  const onboarding = {
    goNext: () => { seen.next += 1; },
    selectedSummaryModel: 'gemma4:e2b',
    recommendedSummaryModel: 'gemma4:e2b',
    parakeetDownloaded,
    setParakeetDownloaded: (v) => { seen.parakeetSet.push(v); },
    summaryModelDownloaded: true,
    setSummaryModelDownloaded: () => {},
    // Must be a promise: the component chains `.catch` onto it (`:179`).
    startBackgroundDownloads: async () => {},
    completeOnboarding: async () => {
      seen.completed += 1;
      if (failComplete) throw new Error('could not persist onboarding state');
    },
  };
  const motionProxy = new Proxy(
    {},
    { get: () => (props) => React.createElement('div', null, props?.children) }
  );
  const overrides = {
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    '@/contexts/OnboardingContext': { useOnboarding: () => onboarding },
    '../OnboardingContainer': { OnboardingContainer: ({ children }) => children },
    'framer-motion': { motion: motionProxy, AnimatePresence: ({ children }) => children },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    sonner: { toast: Object.assign(() => {}, { success: () => {}, error: () => {}, info: () => {} }) },
  };
  return { seen, stubs, overrides };
}

const mounted = [];
async function render(opts = {}) {
  const h = harness(opts);
  // jsdom's `location.reload` is a non-configurable no-op that logs "Not implemented: navigation"
  // to stderr rather than throwing, so it is left alone. The divergence stands and is stated in the
  // header: the real app reloads here and this does not, so nothing past the reload is asserted.
  const { DownloadProgressStep } = loadTsx(
    'src/components/onboarding/steps/DownloadProgressStep.tsx',
    h.overrides
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(DownloadProgressStep)); });
  mounted.push({ root, container });
  return { ...h, container, root };
}
const clear = async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
};

/**
 * The step's own forward control.
 *
 * **Not found by its text, and that is a finding.** It reads "Continue" only when the model is
 * present and nothing is completing; otherwise it renders a bare spinner
 * (`DownloadProgressStep.tsx:530-534`) with no text, no `aria-label` and no `title`. So on the
 * first screen a new user meets, the one control on it has **no accessible name for most of the
 * time it is on screen** — a screen-reader user is offered an unlabelled, disabled button and told
 * nothing about what it is waiting for. Out of scope for a test-only change; located structurally
 * here so the assertions can run, and written down so it is not rediscovered.
 */
const continueButton = (container) => {
  const wrap = [...container.querySelectorAll('div')].find((d) =>
    (d.className || '').includes('max-w-xs') && d.querySelector('button')
  );
  return wrap?.querySelector('button');
};
const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};

// --- 1: no engine, no way past -----------------------------------------------------------------
{
  await clear();
  const { container, seen } = await render({ parakeetDownloaded: false });
  const go = continueButton(container);
  assert.ok(go, 'the first-run screen must offer a way forward');
  assert.equal(
    go.disabled,
    true,
    'without the transcription model the screen must not let a new user past — beyond it the app ' +
      'cannot do the one thing it exists for, and nothing on the next screen says why'
  );
  await click(go);
  assert.equal(seen.completed, 0, 'and pressing it anyway must not complete onboarding');
}

// --- 2 and 3: the backend is asked, and drift is repaired ----------------------------------------
{
  await clear();
  // The flag says the model is missing, the backend says it is there.
  const { container, seen, stubs } = await render({
    parakeetDownloaded: false,
    hasAvailableModels: true,
  });
  // The repair branch needs this flag false; the button is disabled by this flag. So the branch
  // cannot be entered from the UI at all — asserted here rather than described, because it is the
  // whole of finding 3.
  assert.equal(
    continueButton(container).disabled,
    true,
    'with the flag false the only control is disabled, so `handleContinue` — and the state-drift ' +
      'repair inside it — can never run. The rescue path is unreachable from the screen it lives on'
  );
  assert.equal(
    seen.parakeetSet.length,
    0,
    'and nothing has repaired the flag, which is what leaves the user stuck'
  );
  void stubs;

  await clear();
  const ok = await render({ parakeetDownloaded: true, hasAvailableModels: true });
  await click(continueButton(ok.container));
  assert.ok(
    ok.stubs.calls.some((c) => c.cmd === 'transcribe_has_available_models'),
    'Continue must ask the backend whether a model is really there — the component says this ' +
      'catches state drift, and trusting the flag is how a deleted model becomes a broken first run'
  );
  assert.equal(ok.seen.completed, 1, 'and with everything in place it must complete onboarding');
}

// --- 4: completing is once, and a failure gives the button back ----------------------------------
{
  await clear();
  const { container, seen } = await render();
  const go = continueButton(container);
  await click(go);
  await click(go);
  assert.equal(
    seen.completed,
    1,
    'a second press while completing must not complete onboarding twice'
  );

  await clear();
  const failed = await render({ failComplete: true });
  await click(continueButton(failed.container));
  assert.equal(failed.seen.completed, 1, 'the failing attempt must have been made');
  assert.equal(
    continueButton(failed.container).disabled,
    false,
    'and a failure must give the button back — leaving a new user on a dead spinner is the worst ' +
      'first impression this screen can make'
  );
}

console.log(
  'ok - first run: no engine means no way past, Continue asks the backend rather than trusting the ' +
    'flag, onboarding completes once per press, and a failure gives the button back'
);

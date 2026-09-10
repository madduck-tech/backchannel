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
import { boundaryStubs } from './boundary-stubs.mjs';

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
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    '@/contexts/OnboardingContext': { useOnboarding: () => onboarding },
    // The stub renders the **footer** as well as the children, because #154 moved the primary
    // control there. A children-only passthrough silently dropped the one thing this file asserts
    // about -- it looked like "the screen offers no way forward" when the screen offers one and the
    // stub was not showing it.
    '../OnboardingContainer': {
      OnboardingContainer: ({ children, footer }) =>
        React.createElement('div', null, children, React.createElement('footer', null, footer)),
    },
    'framer-motion': { motion: motionProxy, AnimatePresence: ({ children }) => children },
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
 * **Not found by its text**, historically because it had none: it read "Continue" only when the
 * model was present and nothing was completing, and otherwise rendered a bare spinner with no text,
 * no `aria-label` and no `title`. On the first screen a new user meets, the one control on it had
 * **no accessible name for most of the time it was on screen**. #92 fixed that — assertion 5 below
 * holds it — and the structural lookup stays, because the button's name now changes with its state
 * and finding it by text would make the test depend on which state it is in.
 *
 * The address changed with #154 and the rule did not: it used to key on `max-w-xs`, a Tailwind class
 * of the layout before the approved shell, and the shell puts the control in a persistent `<footer>`.
 * Still structural, still independent of what the button currently says.
 */
const continueButton = (container) => container.querySelector('footer button');
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
  // This assertion used to record the trap: the repair branch needs the flag false, the button was
  // disabled by exactly that flag, so the rescue could never run from the screen it lived on. #92
  // inverts it. The verification now runs on mount, gated by nothing, so a user whose model is on
  // disk while the flag disagrees is repaired before they ever reach for a control.
  assert.ok(
    stubs.calls.some((c) => c.cmd === 'transcribe_has_available_models'),
    'the backend must be asked on mount, not only behind a button the stuck user cannot press'
  );
  assert.deepEqual(
    seen.parakeetSet,
    [true],
    'and when the backend says the model is there, the flag is repaired — exactly once'
  );
  // What is NOT asserted here, and why. The button stays disabled in this render, because
  // `parakeetDownloaded` is a constant in the harness and `setParakeetDownloaded` only records the
  // call -- in the application it comes from the onboarding context and re-renders the step.
  // Simulating that re-render would assert the simulation, so instead the two halves are held
  // separately: assertion 1 above holds "flag false -> the control is disabled", and the two
  // assertions here hold "the flag is repaired, on mount, without the user touching anything".
  // Together they are the whole of #92; neither over-claims.
  assert.equal(
    continueButton(container).disabled,
    true,
    'still disabled in THIS render, because the harness holds the flag constant — see the note above'
  );

  await clear();
  const ok = await render({ parakeetDownloaded: true, hasAvailableModels: true });
  // Counted across the click, not merely "did it ever happen". Since #92 the same call also runs on
  // mount, so `some(...)` is satisfied by the mount one and would pass with Continue's own call
  // removed — measured: the published control for exactly that assertion went `check-stayed-green`
  // the moment the second call site existed. The runner's message is the rule this file lives by:
  // "something else guarantees the same behaviour and both need mutating."
  const asked = () => ok.stubs.calls.filter((c) => c.cmd === 'transcribe_has_available_models').length;
  const before = asked();
  await click(continueButton(ok.container));
  assert.ok(
    asked() > before,
    'Continue must ask the backend ITSELF whether a model is really there — the component says this ' +
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

// --- 5: the control says what it is waiting for, in every state ----------------------------------
//
// The other half of #92, which the issue files as "one line of the same fix": while disabled the
// button rendered a bare spinner. A screen-reader user was offered an unlabelled, disabled control
// on the first screen of the application and told nothing about why.
{
  await clear();
  const waiting = await render({ parakeetDownloaded: false, hasAvailableModels: false });
  const button = continueButton(waiting.container);
  const name = (button.getAttribute('aria-label') || button.textContent || '').trim();
  assert.ok(
    name.length > 0,
    'a disabled control must still have an accessible name — this is the state it is in for most ' +
      'of the first run'
  );
  assert.match(
    name,
    /transcription model/i,
    `and the name must say what it is waiting for, not merely that it is waiting; got ${JSON.stringify(name)}`
  );
  // **This assertion's wording changed with #154; its substance did not.** It used to require the
  // literal string "Waiting for the transcription model", which was the label #92 shipped. The
  // approved prototype puts the reason in the footer's readout instead — "N MB left to fetch.
  // Continue is available when the transcription model has arrived." — so pinning the old phrase
  // would have made this check enforce copy the product owner replaced, which is what ADR 0023
  // forbids. What #92 was about is kept: whatever the control is waiting for, a sighted user is
  // told, in words, on screen.
  assert.match(
    waiting.container.textContent,
    /transcription model/i,
    'the reason is on screen too, not only in the accessibility tree — a sighted user watching a ' +
      'disabled control is owed the same subject the accessible name names'
  );

  await clear();
  const ready = await render({ parakeetDownloaded: true, hasAvailableModels: true });
  const readyButton = continueButton(ready.container);
  assert.equal(
    (readyButton.getAttribute('aria-label') || readyButton.textContent).trim(),
    'Continue',
    'and once there is nothing to wait for it is simply Continue'
  );
}

console.log('ok - first run: the control is named in every state it can be in');

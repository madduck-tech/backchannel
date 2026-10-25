// A first run that is quit and resumed keeps the transcription model and the summariser chosen. (#172)
//
// The context started both at their defaults on every mount, and the saved status carried neither. So
// a resumed first run fetched the default on its download screen, and `complete_onboarding` wrote the
// default model with `builtin-ai` beside a cloud summariser's model name.
//
// **The real provider and the real download step**, with only the backend stubbed. The save is stubbed
// by the command's registered name, `save_onboarding_status_cmd` (`lib.rs:665`), and every call is
// recorded: other tests stub `save_onboarding_status`, which does not exist, and the provider swallows
// the throw, so a save there was never seen.
//
// **(c) and (e) run outside `act()`, with stub latency.** `act()` merges the restore and the step change
// into one render, which hides a restore that lands after the step: measured by #172's critic, the
// download asked for moonshine inside `act()` and for the default outside it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const DEFAULT = 'parakeet-tdt-0.6b-v3-q8';
const CHOSEN = 'moonshine-tiny-q8';
const PROVIDER = 'claude';
const CLOUD_MODEL = 'claude-sonnet-4-5-20250929';
// The rows the stubbed catalogue lists. A saved name outside it is a model this build no longer has.
const CATALOGUE = [DEFAULT, CHOSEN, 'whisper-tiny-q8'];
const GONE = 'canary-1b-q8-removed';
// The payload condition (a) captures, committed, so the Rust round trip in `onboarding.rs` reads the
// very same JSON.
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/onboarding-status-with-choices.json', import.meta.url), 'utf8'));

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withoutTime = (status) => { const s = JSON.parse(JSON.stringify(status)); delete s.last_updated; return s; };

/**
 * The provider and the download step, mounted on a backend that records every call.
 * `outsideAct` renders without `act()`, with real timers and `latency` ms on every answer.
 */
async function mount({ saved = null, onDisk = [], latency = 0, outsideAct = false } = {}) {
  const saves = [];
  const completes = [];
  const stubs = tauriStubs({
    extra: {
      transcribe_init: null,
      transcribe_has_available_models: () => onDisk.length > 0,
      // As the command answers: every catalogue row, each with its status.
      transcribe_get_available_models: () =>
        CATALOGUE.map((name) => ({ name, status: onDisk.includes(name) ? 'Available' : 'Missing', size_mb: 34 })),
      // Accepted and never finished: what is asked for is the measurement, not what arrives.
      transcribe_download_model: () => new Promise(() => {}),
      transcribe_list_models: [],
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      builtin_ai_is_model_ready: false,
      get_onboarding_status: saved,
      save_onboarding_status_cmd: (args) => { saves.push(JSON.parse(JSON.stringify(args.status))); return null; },
      complete_onboarding: (args) => { completes.push(args); return null; },
      check_first_launch: !saved,
      check_database_exists: false,
      get_permission_status: {},
      check_default_legacy_database: false,
      initialize_fresh_database: null,
    },
  });
  const invoke = async (cmd, args) => {
    if (latency) await sleep(latency);
    return stubs.core.invoke(cmd, args);
  };
  const modules = { ...boundaryStubs().modules, '@tauri-apps/api/core': { invoke }, '@tauri-apps/api/event': stubs.event };
  const context = loadTsx('src/contexts/OnboardingContext.tsx', modules);
  const motion = new Proxy({}, { get: () => (props) => React.createElement('div', null, props?.children) });
  const { DownloadProgressStep } = loadTsx('src/components/onboarding/steps/DownloadProgressStep.tsx', {
    ...modules,
    '@/contexts/OnboardingContext': context,
    '../OnboardingContainer': {
      OnboardingContainer: ({ children, footer }) => React.createElement('div', null, children, React.createElement('footer', null, footer)),
    },
    'framer-motion': { motion, AnimatePresence: ({ children }) => children },
  });
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
  const tree = React.createElement(context.OnboardingProvider, null, React.createElement(Probe));
  if (outsideAct) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    root.render(tree);
    await sleep(400);
  } else {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => { root.render(tree); });
    await settle();
  }
  const downloads = (cmd) => stubs.calls.filter((c) => c.cmd === cmd).map((c) => c.args?.modelName);
  const unmount = async () => {
    if (outsideAct) root.unmount(); else await act(async () => { root.unmount(); });
    container.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  };
  return { ctx: () => ctx, seen, saves, completes, container, downloads, unmount };
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await sleep(5); });
// Longer than the provider's 1 s auto-save debounce.
const pastTheSave = (outsideAct) => (outsideAct ? sleep(1400) : act(async () => { await sleep(1400); }));

// (a) Choose, walk to step 4, and the auto-saved payload names both choices. The status the step 1→2
// change writes is kept for (g), so (g) resumes from what the provider wrote, not from a hand-made one.
let fromStepTwo = null;
{
  const m = await mount();
  await act(async () => { m.ctx().setSelectedTranscribeModel(CHOSEN); });
  await settle();
  await act(async () => { m.ctx().goToStep(2); });
  await pastTheSave(false);
  fromStepTwo = m.saves.at(-1);
  await act(async () => {
    m.ctx().setSummaryProvider(PROVIDER);
    m.ctx().setSelectedSummaryModel(CLOUD_MODEL);
  });
  await settle();
  await act(async () => { m.ctx().goToStep(4); });
  await pastTheSave(false);
  const last = m.saves.at(-1);
  check('(a) precondition: the status was saved', m.saves.length > 0, 'save_onboarding_status_cmd was never called');
  check('(a) the saved payload names both choices, as the committed fixture does',
    last && JSON.stringify(withoutTime(last)) === JSON.stringify(withoutTime(FIXTURE)),
    `saved ${JSON.stringify(last && withoutTime(last))}`);
  await m.unmount();
}

// (b) Resume from that payload at step 4: both choices are back, and finishing sends them.
{
  const m = await mount({ saved: FIXTURE });
  check('(b) the context holds both choices on resume', m.ctx().selectedTranscribeModel === CHOSEN && m.ctx().summaryProvider === PROVIDER,
    `model ${m.ctx().selectedTranscribeModel}, provider ${m.ctx().summaryProvider}`);
  await act(async () => { await m.ctx().completeOnboarding(); });
  const sent = m.completes[0];
  check('(b) complete_onboarding sends the choices',
    sent && sent.transcribeModel === CHOSEN && sent.provider === PROVIDER && sent.model === CLOUD_MODEL,
    `complete_onboarding was sent ${JSON.stringify(sent)}`);
  await m.unmount();
}

// (c) Resume at step 3, outside act(): the only download asked for is the chosen model's, and nothing is
// asked of the on-device summariser.
{
  const m = await mount({ saved: { ...FIXTURE, current_step: 3 }, latency: 15, outsideAct: true });
  await sleep(1200);
  const asked = m.downloads('transcribe_download_model');
  check('(c) the only transcription download is the chosen model', JSON.stringify(asked) === JSON.stringify([CHOSEN]), `asked for ${JSON.stringify(asked)}`);
  const summary = m.downloads('builtin_ai_download_model');
  check('(c) no on-device summary download is asked for', summary.length === 0, `asked for ${JSON.stringify(summary)}`);
  const rows = [...m.container.querySelectorAll('section[aria-label]')].map((s) => s.getAttribute('aria-label'));
  check('(c) the download screen shows only the chosen model\'s row', JSON.stringify(rows) === JSON.stringify([CHOSEN]), `rows ${JSON.stringify(rows)}`);
  // (e) Resume twice: the first resume's own save, then a second resume from that save.
  await pastTheSave(true);
  const first = m.saves.at(-1);
  check('(e) precondition: the first resume saved', !!first, 'no save after the first resume');
  await m.unmount();
  const again = await mount({ saved: first, latency: 15, outsideAct: true });
  await sleep(1200);
  await pastTheSave(true);
  const second = again.saves.at(-1);
  check('(e) precondition: the second resume saved', !!second, 'no save after the second resume');
  check('(e) the save after a second resume still names both choices',
    second?.model_status?.selected_transcribe_model === CHOSEN && second?.model_status?.summary_provider === PROVIDER,
    `saved ${JSON.stringify(second?.model_status)}`);
  await again.unmount();
}

// (d) Resume at step 3 with only the default on disk: the flag is false on every step-3 render; with the
// chosen file on disk, it is true.
{
  const m = await mount({ saved: { ...FIXTURE, current_step: 3 }, onDisk: [DEFAULT] });
  await settle();
  const atStep3 = m.seen.filter((s) => s.step === 3);
  check('(d) the flag is never true at step 3 while the chosen file is absent', atStep3.length > 0 && atStep3.every((s) => s.flag === false),
    `step-3 renders: ${JSON.stringify(atStep3.map((s) => [s.model, s.flag]))}`);
  await m.unmount();
  const h = await mount({ saved: { ...FIXTURE, current_step: 3 }, onDisk: [CHOSEN] });
  await settle();
  check('(d) and true once the chosen file is on disk', h.ctx().parakeetDownloaded === true, `parakeetDownloaded is ${h.ctx().parakeetDownloaded}`);
  await h.unmount();
}

// (f) A status saved before this change, with neither field: the defaults, and nothing undefined.
{
  const old = { version: '1.0', completed: false, current_step: 3, model_status: { parakeet: 'not_downloaded', summary: 'not_downloaded' }, last_updated: '2026-10-01T00:00:00Z' };
  const m = await mount({ saved: old });
  await settle();
  check('(f) an old status resumes on the default model and builtin-ai', m.ctx().selectedTranscribeModel === DEFAULT && m.ctx().summaryProvider === 'builtin-ai',
    `model ${m.ctx().selectedTranscribeModel}, provider ${m.ctx().summaryProvider}`);
  const asked = m.downloads('transcribe_download_model');
  check('(f) and asks for the default, never for undefined', JSON.stringify(asked) === JSON.stringify([DEFAULT]), `asked for ${JSON.stringify(asked)}`);
  await m.unmount();
}

// (g) Resume at step 2 from the status the step 1→2 change wrote: the model chosen at step 1 is the
// choice, and step 3 asks for it.
{
  check('(g) precondition: the step 1→2 change saved step 2 with the choice',
    fromStepTwo?.current_step === 2 && fromStepTwo?.model_status?.selected_transcribe_model === CHOSEN,
    `saved ${JSON.stringify(fromStepTwo)}`);
  const m = await mount({ saved: fromStepTwo });
  check('(g) the model chosen at step 1 survives a resume at step 2', m.ctx().selectedTranscribeModel === CHOSEN, `model ${m.ctx().selectedTranscribeModel}`);
  await act(async () => { m.ctx().goToStep(3); });
  await settle();
  const asked = m.downloads('transcribe_download_model');
  check('(g) and step 3 asks for it', JSON.stringify(asked) === JSON.stringify([CHOSEN]), `asked for ${JSON.stringify(asked)}`);
  await m.unmount();
}

// (h) A saved model this build no longer lists resumes on the default, not on "Unknown model" with
// Continue disabled and no way back, and the next save does not write the dead name again.
{
  const gone = { ...FIXTURE, current_step: 3, model_status: { ...FIXTURE.model_status, selected_transcribe_model: GONE } };
  const m = await mount({ saved: gone, latency: 15, outsideAct: true });
  await sleep(1200);
  const asked = m.downloads('transcribe_download_model');
  check('(h) a model the catalogue no longer lists resumes on the default', JSON.stringify(asked) === JSON.stringify([DEFAULT]), `asked for ${JSON.stringify(asked)}`);
  await pastTheSave(true);
  const last = m.saves.at(-1);
  check('(h) and the save after it names the default, not the dead name',
    last?.model_status?.selected_transcribe_model === DEFAULT, `saved ${JSON.stringify(last?.model_status)}`);
  check('(h) the summariser is still restored', last?.model_status?.summary_provider === PROVIDER, `saved ${JSON.stringify(last?.model_status)}`);
  await m.unmount();
}

// (i) A saved summariser the screen does not offer resumes on the default one.
{
  const m = await mount({ saved: { ...FIXTURE, model_status: { ...FIXTURE.model_status, summary_provider: 'gemini' } } });
  check('(i) a summariser the screen does not offer resumes on builtin-ai', m.ctx().summaryProvider === 'builtin-ai', `provider ${m.ctx().summaryProvider}`);
  check('(i) and the model is still restored', m.ctx().selectedTranscribeModel === CHOSEN, `model ${m.ctx().selectedTranscribeModel}`);
  await m.unmount();
}

// The list the restore checks against is the screen's list, in its order.
{
  const t = tauriStubs({});
  const { SUMMARISER_IDS } = loadTsx('src/contexts/OnboardingContext.tsx', { ...boundaryStubs().modules, '@tauri-apps/api/core': t.core, '@tauri-apps/api/event': t.event });
  const src = fs.readFileSync(new URL('../../src/components/onboarding/steps/SummariserStep.tsx', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const OPTIONS'), src.indexOf('];', src.indexOf('const OPTIONS')));
  const offered = [...block.matchAll(/\bid: '([^']+)'/g)].map((x) => x[1]);
  check('precondition: the summariser screen\'s options were read', offered.length >= 5, `read ${JSON.stringify(offered)}`);
  check('SUMMARISER_IDS equals the summariser screen\'s options', JSON.stringify([...SUMMARISER_IDS]) === JSON.stringify(offered),
    `context ${JSON.stringify(SUMMARISER_IDS)}, screen ${JSON.stringify(offered)}`);
}

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - a resumed first run keeps the transcription model and the summariser: saved, restored before the download screen reads them, and sent at completion; an old status resumes on the defaults');

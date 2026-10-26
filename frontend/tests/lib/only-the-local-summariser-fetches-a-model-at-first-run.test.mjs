// Finishing first run asks for an on-device summary model only when the on-device summariser was
// chosen. (#181, and #212 round 2 before it)
//
// Through the real `OnboardingProvider`, with the backend stubbed. `completeOnboarding` used to ask
// `builtin_ai_is_model_ready` and `builtin_ai_download_model` for every provider but the two agent
// CLIs, with the model that provider's option leaves: `claude-sonnet-4-5-20250929`, `gpt-4o`, ...
// The backend refuses those ids as `Unknown model` before a byte, so the cost was a refused request
// and an error toast; but with an empty model, or with `gemma4:e2b` -- which
// `initializeSummaryModelSelection` sets when it lands after `pick()` -- the same block fetched
// 3651 MiB of Gemma for a person who chose Claude. `startBackgroundDownloads` already skipped every
// provider but `builtin-ai`; this site did not.
//
// Each provider runs three ways: (a) the model its option leaves, (b) an empty model, (c)
// `gemma4:e2b`. The two agent CLIs are guards (green on `0dd1c3f` too); `builtin-ai` is the
// positive sentinel, so the check cannot pass by never asking for anything.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

/** The model each option's `pick()` (or `pickAgent()`) leaves, from `SummariserStep.tsx`. */
const MODEL_LEFT = {
  ollama: 'llama3.2',
  claude: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'anthropic/claude-sonnet-4.5',
  'custom-openai': 'gpt-4o',
  'claude-code': '',
  codex: '',
};

function load(stubs) {
  return loadTsx('src/contexts/OnboardingContext.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
  });
}

function backend() {
  return tauriStubs({
    extra: {
      transcribe_init: null,
      transcribe_has_available_models: () => true,
      transcribe_get_available_models: () => [{ name: 'parakeet-tdt-0.6b-v3-q8', status: 'Available' }],
      transcribe_download_model: null,
      transcribe_list_models: [],
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      builtin_ai_is_model_ready: false,
      get_onboarding_status: null,
      save_onboarding_status: null,
      complete_onboarding: null,
      check_database_exists: false,
      check_first_launch: false,
      get_permission_status: {},
    },
  });
}

async function finish(provider, model) {
  const stubs = backend();
  const { OnboardingProvider, useOnboarding } = load(stubs);
  let ctx = null;
  const Probe = () => { ctx = useOnboarding(); return null; };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(OnboardingProvider, null, React.createElement(Probe))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => { ctx.setSummaryProvider(provider); ctx.setSelectedSummaryModel(model); });
  stubs.calls.length = 0;
  await act(async () => { await ctx.completeOnboarding(); });
  const downloads = stubs.calls.filter((c) => c.cmd === 'builtin_ai_download_model').map((c) => c.args.modelName);
  const readyChecks = stubs.calls.filter((c) => c.cmd === 'builtin_ai_is_model_ready').map((c) => c.args.modelName);
  const done = stubs.calls.find((c) => c.cmd === 'complete_onboarding')?.args;
  await act(async () => { root.unmount(); });
  container.remove();
  return { downloads, readyChecks, done };
}

// The map covers exactly the providers first run offers but the local one: a provider added later
// is red here until it is given the model its option leaves.
const { SUMMARISER_IDS } = load(backend());
assert.deepEqual(
  Object.keys(MODEL_LEFT).sort(),
  // Copied into this realm: the module's array is another vm realm's, which strict deepEqual refuses.
  Array.from(SUMMARISER_IDS).filter((id) => id !== 'builtin-ai').sort(),
  'MODEL_LEFT must name every summariser first run offers except builtin-ai'
);

// The positive sentinel: the on-device summariser still asks for its model.
const local = await finish('builtin-ai', 'gemma4:e2b');
assert.deepEqual(local.downloads, ['gemma4:e2b'], 'builtin-ai must still fetch its model, or the checks below prove nothing');

const failures = [];
for (const [provider, left] of Object.entries(MODEL_LEFT)) {
  for (const [label, model] of [['(a) its own', left], ['(b) empty', ''], ['(c) gemma4:e2b', 'gemma4:e2b']]) {
    const { downloads, readyChecks, done } = await finish(provider, model);
    if (downloads.length) failures.push(`${provider} ${label}: asked to download ${JSON.stringify(downloads)}`);
    if (readyChecks.length) failures.push(`${provider} ${label}: asked whether ${JSON.stringify(readyChecks)} is ready`);
    // What (b) and (c) save is #181's out-of-scope configuration; only (a)'s is asserted.
    if (label.startsWith('(a)') && (done?.provider !== provider || done?.model !== left)) {
      failures.push(`${provider} (a): completed as ${JSON.stringify(done)}, not ${JSON.stringify({ provider, model: left })}`);
    }
  }
}
assert.deepEqual(failures, [], `first run asked for an on-device summary model it has no use for:\n  ${failures.join('\n  ')}`);
console.log('ok - only builtin-ai asks for an on-device summary model at the end of first run; every other summariser is completed with the model its option left');

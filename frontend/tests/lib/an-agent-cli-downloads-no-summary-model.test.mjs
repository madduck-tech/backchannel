// Finishing first run with an agent CLI chosen fetches no on-device summary model. (#212 round 2)
//
// Found by #212's adversary, through the real `OnboardingProvider`: `pickAgent` leaves the summary
// model empty, `completeOnboarding` filled it with the recommended one and asked for its download,
// so a person who chose Claude Code got 3651 MiB of Gemma. The agent path was the first on which
// #181 really fetches the file: a cloud provider's model id is one the backend refuses. The same
// guard for every provider that is not on this machine is #181; this holds the two agent CLIs, and
// that `builtin-ai` still downloads, so the guard cannot pass by never downloading anything.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

async function finish(provider, model) {
  const stubs = tauriStubs({
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
  const { OnboardingProvider, useOnboarding } = loadTsx('src/contexts/OnboardingContext.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
  });
  let ctx = null;
  const Probe = () => { ctx = useOnboarding(); return null; };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(OnboardingProvider, null, React.createElement(Probe))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  // What the step's pick() and pickAgent() leave in the context.
  await act(async () => { ctx.setSummaryProvider(provider); ctx.setSelectedSummaryModel(model); });
  stubs.calls.length = 0;
  await act(async () => { await ctx.completeOnboarding(); });
  const downloads = stubs.calls.filter((c) => c.cmd === 'builtin_ai_download_model').map((c) => c.args.modelName);
  const done = stubs.calls.find((c) => c.cmd === 'complete_onboarding')?.args;
  await act(async () => { root.unmount(); });
  container.remove();
  return { downloads, done };
}

// The positive sentinel, in this run: the local summariser still asks for its model.
const local = await finish('builtin-ai', 'gemma4:e2b');
assert.deepEqual(local.downloads, ['gemma4:e2b'], 'builtin-ai must still fetch its model, or the next assertion proves nothing');

for (const agent of ['claude-code', 'codex']) {
  const { downloads, done } = await finish(agent, '');
  assert.deepEqual(downloads, [], `${agent} asked for ${JSON.stringify(downloads)}: an agent CLI uses its own model and needs no weights here`);
  assert.deepEqual(
    { provider: done?.provider, model: done?.model },
    { provider: agent, model: '' },
    `${agent} is completed with the recommended local model written into its configuration`
  );
}
console.log('ok - finishing first run with an agent CLI fetches no summary model, and builtin-ai still does');

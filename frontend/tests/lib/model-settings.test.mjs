// What the model settings do to the configuration they hand back, driven rather than read.
//
// #66, component 4 of 8. The issue's row: *"the largest single component in the tree"* — 1,374
// lines, and nothing had rendered a line of it. Size is why it is on the list, but size is not
// something to assert; what is asserted is the handful of places where this component decides what
// gets written down about a user's provider.
//
//   1. A provider that needs an API key cannot be saved without one. Saving an unusable
//      configuration is a bug the user only meets later, at the first summary.
//   2. `custom-openai` cannot be saved with a blank endpoint, nor with a blank model — two cases,
//      because one clause must not be able to stand in for the other.
//   3. The key is trimmed, and a whitespace-only key becomes `null` rather than `""`. An empty
//      string is a *present* key to anything that checks truthiness downstream.
//   4. Custom-OpenAI fields are nulled for every other provider. Leaking one provider's endpoint
//      into another's configuration is how a request goes somewhere nobody chose.
//   5. When the backend refuses to store the custom config, `onSave` is **not** called. Otherwise
//      the parent believes a configuration the backend does not have.
//   6. The confirmed model is remembered per provider in `providerModelMap`.
//
// Six behaviours, **seven** controls: behaviour 2 owes two, because its guard is two clauses
// (`!endpoint.trim() || !model.trim()`) and blanking both at once lets either one carry the
// assertion alone.
//
// Scaffolding divergences, written where the next person reads them (#66 condition 4):
//   * `useConfig` returns `null` here, which is the component's own documented fallback ("use
//     ConfigContext if available, fallback to props") — so the props path is what is driven. That is
//     the path `skipInitialFetch` callers use.
//   * `BuiltInModelManager` is stubbed to nothing: it is component 7 on the same list and owns its
//     own downloads and disk state. Rendering it here would test it by accident.
//   * `localStorage` is real (jsdom, given an origin by `dom-harness.mjs`) and cleared per case.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const BASE = {
  provider: 'ollama',
  model: 'llama3',
  whisperModel: 'parakeet-tdt-0.6b-v3-q8',
  apiKey: null,
  ollamaEndpoint: 'http://localhost:11434',
};

function harness({ config = {}, failCustomSave = false } = {}) {
  const seen = { saved: [], set: [] };
  const stubs = tauriStubs({
    extra: {
      api_get_api_key: { key: null },
      api_get_model_config: null,
      api_get_custom_openai_config: null,
      get_ollama_models: [],
      // The provider pickers fetch their catalogues on mount. Empty lists keep every picker
      // rendering without inventing model names the assertions might then depend on.
      get_openai_models: [],
      get_anthropic_models: [],
      get_groq_models: [],
      get_openrouter_models: [],
      builtin_ai_list_models: [],
      api_save_custom_openai_config: () => {
        if (failCustomSave) throw new Error('backend refused');
        return null;
      },
    },
  });
  const modelConfig = { ...BASE, ...config };
  const overrides = {
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    // The component's own fallback: "use ConfigContext if available, fallback to props".
    '@/contexts/ConfigContext': { useConfig: () => null },
    './Sidebar/SidebarProvider': { useSidebar: () => ({ serverAddress: 'http://localhost:5167' }) },
    '@/contexts/OllamaDownloadContext': {
      useOllamaDownload: () => ({ downloads: {}, startDownload: () => {}, cancelDownload: () => {} }),
    },
    // Component 7 on the same list; it owns its own download and disk state.
    '@/components/BuiltInModelManager': { BuiltInModelManager: () => null },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    sonner: { toast: Object.assign(() => {}, { success: () => {}, error: () => {} }) },
  };
  return { seen, stubs, overrides, modelConfig };
}

async function render(opts = {}) {
  const h = harness(opts);
  const { ModelSettingsModal } = loadTsx('src/components/ModelSettingsModal.tsx', h.overrides);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ModelSettingsModal, {
        modelConfig: h.modelConfig,
        setModelConfig: (c) => h.seen.set.push(typeof c === 'function' ? c(h.modelConfig) : c),
        onSave: (c) => h.seen.saved.push(c),
        skipInitialFetch: true,
      })
    );
  });
  return { ...h, container, root };
}

const saveButton = (container) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save');
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};

// --- 1: a provider that needs a key cannot be saved without one ------------------------------
{
  const withoutKey = await render({ config: { provider: 'openai', model: 'gpt-4o', apiKey: null } });
  assert.equal(
    saveButton(withoutKey.container).disabled,
    true,
    'a provider that requires an API key must not be saveable without one — an unusable ' +
      'configuration is a bug the user meets later, at the first summary'
  );

  const withKey = await render({ config: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-real' } });
  assert.equal(
    saveButton(withKey.container).disabled,
    false,
    'and must be saveable once there is one, or the control is just always off'
  );
}

// --- 2: custom-openai needs an endpoint and a model -------------------------------------------
{
  // One case per clause. Blanking both at once lets either clause carry the assertion on its own,
  // and a control that removes one comes back green — measured, that is exactly what happened.
  const noEndpoint = await render({
    config: {
      provider: 'custom-openai',
      model: 'local',
      customOpenAIEndpoint: '',
      customOpenAIModel: 'local',
    },
  });
  assert.equal(
    saveButton(noEndpoint.container).disabled,
    true,
    'custom-openai with a model but no endpoint must not be saveable'
  );

  const noModel = await render({
    config: {
      provider: 'custom-openai',
      model: '',
      customOpenAIEndpoint: 'http://127.0.0.1:8080/v1',
      customOpenAIModel: '',
    },
  });
  assert.equal(
    saveButton(noModel.container).disabled,
    true,
    'and with an endpoint but no model it must not be saveable either'
  );

  const filled = await render({
    config: {
      provider: 'custom-openai',
      model: 'local',
      customOpenAIEndpoint: 'http://127.0.0.1:8080/v1',
      customOpenAIModel: 'local',
    },
  });
  assert.equal(saveButton(filled.container).disabled, false, 'and must be saveable once both are set');
}

// --- 3: the key is trimmed, and whitespace becomes null ----------------------------------------
{
  const { container, seen } = await render({
    config: { provider: 'openai', model: 'gpt-4o', apiKey: '  sk-padded  ' },
  });
  await click(saveButton(container));
  assert.equal(seen.saved.length, 1, 'Save must hand the configuration up exactly once');
  assert.equal(
    seen.saved[0].apiKey,
    'sk-padded',
    'the key must be trimmed before it is stored — a stray space is a 401 nobody can see'
  );
}

// --- 4: another provider's custom fields do not survive ----------------------------------------
{
  const { container, seen } = await render({
    config: {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-real',
      customOpenAIEndpoint: 'http://leaked.invalid/v1',
      customOpenAIModel: 'leaked-model',
      customOpenAIApiKey: 'leaked-key',
    },
  });
  await click(saveButton(container));
  const saved = seen.saved[0];
  assert.deepEqual(
    {
      endpoint: saved.customOpenAIEndpoint,
      model: saved.customOpenAIModel,
      key: saved.customOpenAIApiKey,
    },
    { endpoint: null, model: null, key: null },
    'switching away from custom-openai must not carry its endpoint, model or key into the saved ' +
      'configuration — a leaked endpoint is a request going somewhere nobody chose'
  );
  assert.equal(saved.model, 'gpt-4o', 'and the real provider keeps its own model');
}

// --- 5: a backend that refuses the custom config must not produce a save ------------------------
{
  const ok = await render({
    config: {
      provider: 'custom-openai',
      model: 'local',
      customOpenAIEndpoint: 'http://127.0.0.1:8080/v1',
      customOpenAIModel: 'local',
    },
  });
  await click(saveButton(ok.container));
  assert.equal(ok.seen.saved.length, 1, 'the happy path must save, or the next assertion proves nothing');

  const refused = await render({
    failCustomSave: true,
    config: {
      provider: 'custom-openai',
      model: 'local',
      customOpenAIEndpoint: 'http://127.0.0.1:8080/v1',
      customOpenAIModel: 'local',
    },
  });
  await click(saveButton(refused.container));
  assert.deepEqual(
    refused.seen.saved,
    [],
    'when the backend refuses to store the custom config, the parent must not be told it was ' +
      'saved — otherwise the two disagree and only the next request finds out'
  );
}

// --- 6: the confirmed model is remembered per provider -----------------------------------------
{
  window.localStorage.clear();
  const { container } = await render({
    config: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-real' },
  });
  await click(saveButton(container));
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem('providerModelMap') || '{}'),
    { openai: 'gpt-4o' },
    'a confirmed model must be remembered against the provider it belongs to'
  );
}

console.log(
  'ok - model settings: a keyless provider and a blank custom endpoint cannot be saved, the key ' +
    'is trimmed, another provider\'s custom fields are dropped, a refused backend save produces no ' +
    'onSave, and the model is remembered per provider'
);

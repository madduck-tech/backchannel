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
//   7. An agent CLI (#212) is saveable only when found and logged in, and is saved with no key.
//
// Seven behaviours; the first six owe **seven** controls: behaviour 2 owes two, because its guard is two clauses
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
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const BASE = {
  provider: 'ollama',
  model: 'llama3',
  whisperModel: 'parakeet-tdt-0.6b-v3-q8',
  apiKey: null,
  ollamaEndpoint: 'http://localhost:11434',
};

function harness({ config = {}, failCustomSave = false, agents = [] } = {}) {
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
      agent_cli_status: agents,
      api_save_custom_openai_config: () => {
        if (failCustomSave) throw new Error('backend refused');
        return null;
      },
    },
  });
  const modelConfig = { ...BASE, ...config };
  const overrides = {
    ...boundaryStubs().modules,
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

// --- 7: an agent CLI (#212) is saved only when it is found and logged in, and with no key --------
//
// The approved `settings-summariser-agents.html`: the status line under the list says found (with
// the path and the model), not logged in, or not on PATH, and only the first can be saved.
{
  const statusOf = (c) => c.querySelector('[data-agent-status]')?.textContent ?? '';
  const ready = await render({
    agents: [{ id: 'claude-code', found: '~/.local/bin/claude', loggedIn: true }],
    // A key left over from the provider the list was on before: it must not be saved with the agent.
    config: { provider: 'claude-code', model: '', apiKey: 'sk-left-behind' },
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  assert.ok(statusOf(ready.container).includes('Found: ~/.local/bin/claude'), statusOf(ready.container));
  assert.ok(statusOf(ready.container).includes('Model: as set in Claude Code'), statusOf(ready.container));
  assert.ok(statusOf(ready.container).includes('Summaries run with no tools and save no session.'), statusOf(ready.container));
  assert.equal(
    ready.container.querySelector('input[type="password"]'),
    null,
    'an agent CLI uses its own login, so Settings must not ask for a key'
  );
  assert.equal(
    ready.container.querySelectorAll('[role="combobox"]').length,
    1,
    'only the provider list: an agent CLI uses its own default model, so there is no model to pick'
  );
  assert.equal(saveButton(ready.container).disabled, false, 'a found, logged-in CLI can be saved');
  await click(saveButton(ready.container));
  assert.deepEqual(
    { provider: ready.seen.saved[0]?.provider, apiKey: ready.seen.saved[0]?.apiKey },
    { provider: 'claude-code', apiKey: null },
    'the agent is saved as the provider with no key, not with the one the field still held'
  );

  const loggedOut = await render({
    agents: [{ id: 'codex', found: '~/.local/bin/codex', loggedIn: false }],
    config: { provider: 'codex', model: '' },
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  assert.ok(
    statusOf(loggedOut.container).includes('Not logged in. Run codex once in a terminal to log in, then come back here.'),
    statusOf(loggedOut.container)
  );
  assert.equal(saveButton(loggedOut.container).disabled, true, 'a logged-out CLI cannot be saved');

  // The shape `agent_cli_status` sends: both CLIs, always, with `found: null` for one not found.
  const missing = await render({
    agents: [
      { id: 'claude-code', found: null, loggedIn: null },
      { id: 'codex', found: '~/.local/bin/codex', loggedIn: true },
    ],
    config: { provider: 'claude-code', model: '' },
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  assert.ok(
    statusOf(missing.container).includes("Claude Code is not in your shell's PATH. Install claude and log in, then come back here."),
    statusOf(missing.container)
  );
  assert.equal(saveButton(missing.container).disabled, true, 'a CLI that was not found cannot be saved');
}

console.log(
  'ok - model settings: a keyless provider and a blank custom endpoint cannot be saved, the key ' +
    'is trimmed, another provider\'s custom fields are dropped, a refused backend save produces no ' +
    'onSave, the model is remembered per provider, and an agent CLI is saved only when usable and ' +
    'with no key'
);

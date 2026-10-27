// ConfigContext loads a stored agent-CLI config with no model, whatever the store holds. (#226)
//
// #226's condition 1, held by rendering the real ConfigProvider rather than by reading its source.
// The source check this replaces stayed green under `loadedSummaryModel(…) || prev.model`, a one-token
// mutation that puts the defect back: measured by #226's gate adversary, 102 of 102 green with it.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

async function load(stored) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    return cmd === 'api_get_model_config' ? stored : null;
  };
  const { ConfigProvider, useConfig } = loadTsx('src/contexts/ConfigContext.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': { invoke },
    '@tauri-apps/api/event': { listen: async () => () => {}, emit: async () => {} },
  });
  const seen = { cfg: null };
  function Probe() { seen.cfg = useConfig().modelConfig; return null; }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(ConfigProvider, null, React.createElement(Probe))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  root.unmount();
  return { asked: calls.some((c) => c.cmd === 'api_get_model_config'), cfg: seen.cfg };
}

const base = { whisperModel: 'large-v3', ollamaEndpoint: null };
const cells = [
  // [name, stored config, the model it loads as]
  ['Codex, no model', { ...base, provider: 'codex', model: '' }, ''],
  ['Claude Code, no model', { ...base, provider: 'claude-code', model: '' }, ''],
  ['Codex, a stale model from an old build', { ...base, provider: 'codex', model: 'gemma4:e2b' }, ''],
  ['Codex, model null', { ...base, provider: 'codex', model: null }, ''],
  ['Codex, model absent', { ...base, provider: 'codex' }, ''],
  // The fallback the agent CLIs are kept out of is still there for the others.
  ['sentinel: the built-in summariser, no model', { ...base, provider: 'builtin-ai', model: '' }, 'gemma4:e2b'],
  ['sentinel: Claude, its model', { ...base, provider: 'claude', model: 'claude-sonnet-4-5' }, 'claude-sonnet-4-5'],
];

for (const [name, stored, want] of cells) {
  localStorage.clear();
  const { asked, cfg } = await load(stored);
  assert.ok(asked, `${name}: the provider never read the stored config`);
  assert.equal(cfg?.provider, stored.provider, `${name}: loaded as provider ${cfg?.provider}`);
  assert.equal(cfg?.model, want, `${name}: loaded with model ${JSON.stringify(cfg?.model)}`);
}

console.log(`ok - ConfigContext loads an agent CLI with no model; ${cells.length} stored configs, two of them sentinels`);

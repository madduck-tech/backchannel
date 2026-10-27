// Auto-summary after Stop runs on an agent CLI, and never rewrites its choice. (#226)
//
// The meeting page decided "a summariser is configured" by `currentConfig.model`. #226 stores no
// model for Claude Code or Codex, so the page took the branch written for an empty database: it ran
// no summary, and where Ollama held the recommended model it saved `{ provider: 'ollama', model: '' }`
// over the person's choice. Found by #226's gate adversary, rendering this page.
//
// The page is the real one, reached as after Stop (`source=recording`) with auto-summary on. What is
// asserted is what it hands PageContent and what it saves, never what it logs.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const METADATA = { id: 'm1', title: 'Standup', created_at: '', updated_at: '', folder_path: null };
const PAGINATED = {
  metadata: METADATA, segments: [], transcripts: [{ id: 't1', text: 'hello there', timestamp: '' }],
  isLoading: false, isLoadingMore: false, hasMore: false, totalCount: 1, loadedCount: 1,
  loadMore: () => {}, refetch: () => {}, error: null,
};
const LOADING = { ...PAGINATED, metadata: null, transcripts: [], isLoading: true, totalCount: 0, loadedCount: 0 };
const PARAMS = new URLSearchParams('id=m1&source=recording');
// One identity each, as the providers give in the app. A new object per render re-runs every effect
// that depends on it, and the page then renders without end.
const ROUTER = { push: () => {} };
const SIDEBAR = { setCurrentMeeting: () => {}, refetchMeetings: async () => {}, stopSummaryPolling: () => {} };
const CONFIG = { isAutoSummary: true };

async function afterStop(stored, ollamaModels) {
  const calls = [];
  const handed = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'api_get_summary': return { status: 'idle' };
      case 'api_get_model_config': return stored;
      case 'get_ollama_models': return ollamaModels;
      case 'api_save_model_config': return { status: 'success' };
      default: throw new Error(`unstubbed command ${cmd}`);
    }
  };
  const page = loadTsx('src/app/meeting-details/page.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': { invoke },
    'next/navigation': { useSearchParams: () => PARAMS, useRouter: () => ROUTER },
    '@/components/Sidebar/SidebarProvider': { useSidebar: () => SIDEBAR },
    '@/contexts/ConfigContext': { useConfig: () => CONFIG },
    // As in the app: the metadata arrives after the page's reset-on-meetingId effects have run.
    '@/hooks/usePaginatedTranscripts': {
      usePaginatedTranscripts: () => {
        const [v, setV] = React.useState(LOADING);
        React.useEffect(() => { const h = setTimeout(() => setV(PAGINATED), 5); return () => clearTimeout(h); }, []);
        return v;
      },
    },
    './page-content': { __esModule: true, default: (p) => { handed.push(p.shouldAutoGenerate); return null; } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(page.default)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  root.unmount();
  return {
    asked: calls.some((c) => c.cmd === 'api_get_model_config'),
    rendered: handed.length,
    generates: handed.includes(true),
    saves: calls.filter((c) => c.cmd === 'api_save_model_config').map((c) => c.args),
  };
}

const GEMMA = [{ name: 'gemma4:e2b' }];
const cells = [
  // [name, stored config, Ollama's models, generates, saves]
  ['Codex, no model (what #226 stores)', { provider: 'codex', model: '', whisperModel: 'large-v3' }, [], true, 0],
  ['Claude Code, no model, Ollama holds gemma4:e2b', { provider: 'claude-code', model: '', whisperModel: 'large-v3' }, GEMMA, true, 0],
  ['Codex, a stale model from an old build', { provider: 'codex', model: 'gemma4:e2b', whisperModel: 'large-v3' }, [], true, 0],
  ['sentinel: the built-in summariser with its model', { provider: 'builtin-ai', model: 'gemma4:e2b', whisperModel: 'large-v3' }, [], true, 0],
  // The empty-database branch is still reached, and still saves: so a save of none above means something.
  ['sentinel: Ollama with no model, gemma4:e2b pulled', { provider: 'ollama', model: '', whisperModel: 'large-v3' }, GEMMA, true, 1],
  ['sentinel: Ollama with no model and nothing pulled', { provider: 'ollama', model: '', whisperModel: 'large-v3' }, [], false, 0],
];

for (const [name, stored, ollama, generates, saves] of cells) {
  const got = await afterStop(stored, ollama);
  assert.ok(got.asked && got.rendered > 0, `${name}: the page never read the stored config or never rendered`);
  assert.equal(got.generates, generates, `${name}: auto-summary ${generates ? 'did not run' : 'ran'} after Stop`);
  assert.equal(got.saves.length, saves, `${name}: the page saved ${JSON.stringify(got.saves)}`);
}

console.log(`ok - auto-summary runs on an agent CLI and saves nothing over it; ${cells.length} cells, three of them sentinels`);

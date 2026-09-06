// What the import dialog does with a file and with an import already running, driven rather than read.
//
// #66, component 5 of 8. The issue's row: *"a path with its own in-progress state
// (`is_import_in_progress_command`)"*. 464 lines, never rendered. In-progress state is the whole
// reason it is on the list, so that is what most of this asserts.
//
//   1. Import is refused while there is no file. Starting an import of nothing is a failure the
//      user only sees after the dialog has already closed on them.
//   2. **The dialog cannot be dismissed while an import is running.** `handleOpenChange` returns
//      early on `isProcessing`, and losing that means the surface carrying Cancel disappears while
//      the work continues with nowhere to stop it.
//   3. While processing, Import is not offered at all — only Cancel. A screen offering both is the
//      same shape as #15. **Its control does not fail by assertion.** Replacing the guard with
//      `{true && (` — so both footer branches render at once — puts the component into a render
//      loop: measured, that mutation left in the working tree took a test worker to **28 GB** and
//      the kernel OOM-killed the IDE. Under a memory cap the test dies instead of asserting, which
//      is a red state but not a readable one, so it is named here.
//   4. The import is started with the arguments the user actually chose: the file's path, the
//      title, the model's name and its provider.
//   5. An empty title falls back to the filename, rather than importing a meeting called "".
//   6. `auto` becomes `null`, not the string `"auto"`. A language literally named "auto" is not a
//      language any model knows.
//
// Six behaviours, seven mutations: behaviour 5 needs two lines removed at once, because the
// pre-fill and the fallback each guarantee it alone. Behaviour 3's mutation does not fail by
// assertion -- it puts the component into a render loop; see the note there.
//
// Scaffolding divergences, written where the next person reads them (#66 condition 4):
//   * `useImportAudio` and `useTranscriptionModels` are stubbed. They own a Tauri event stream and a
//     model catalogue respectively; stubbing is what makes "idle" and "processing" two renders
//     rather than a race against a real import.
//   * The dialog is Radix and portals to `document.body`, so its contents are queried from there.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const FILE = { path: '/tmp/standup.wav', filename: 'standup.wav', duration: 90, size: 1024 };
const MODELS = [{ key: 'local:parakeet', provider: 'local', name: 'parakeet', label: 'Parakeet' }];

function harness({ fileInfo = FILE, processing = false, modelKey = 'local:parakeet' } = {}) {
  const seen = { started: [], openChanges: [], cancelled: 0 };
  const stubs = tauriStubs();
  const importAudio = {
    status: processing ? 'processing' : fileInfo ? 'ready' : 'idle',
    fileInfo,
    progress: processing ? { percent: 42 } : null,
    error: null,
    isProcessing: processing,
    isBusy: processing,
    selectFile: async () => fileInfo,
    validateFile: async () => fileInfo,
    startImport: async (...args) => { seen.started.push(args); },
    cancelImport: async () => { seen.cancelled += 1; },
    reset: () => {},
  };
  const transcriptionModels = {
    availableModels: MODELS,
    selectedModelKey: modelKey,
    setSelectedModelKey: () => {},
    loadingModels: false,
    fetchModels: async () => {},
    resetSelection: () => {},
  };
  const configContext = { selectedLanguage: 'auto', transcriptModelConfig: null };
  const router = { push: () => {} };
  const sidebarContext = { refetchMeetings: () => {} };

  const overrides = {
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    // **Every hook return here is built once and handed back unchanged.**
    // `ImportAudioDialog.tsx:156` lists `reset, resetSelection, validateFile, fetchModels` in an
    // effect's dependency array. A stub of the shape `useImportAudio: () => ({ reset: () => {} })`
    // mints a new function identity on every render, so the effect re-runs on every render, sets
    // state, and renders again -- forever. Measured before this was fixed: the file reached
    // **22.9 GB** and the kernel OOM-killed the IDE. It was intermittent, which is how it survived
    // being written and passing.
    '@/hooks/useImportAudio': { useImportAudio: () => importAudio },
    '@/hooks/useTranscriptionModels': { useTranscriptionModels: () => transcriptionModels },
    '@/contexts/ConfigContext': { useConfig: () => configContext },
    'next/navigation': { useRouter: () => router },
    '../Sidebar/SidebarProvider': { useSidebar: () => sidebarContext },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    sonner: { toast: Object.assign(() => {}, { success: () => {}, error: () => {}, info: () => {} }) },
  };
  return { seen, stubs, overrides };
}

async function render(opts = {}) {
  const h = harness(opts);
  const mod = loadTsx('src/components/ImportAudio/ImportAudioDialog.tsx', h.overrides);
  const Dialog = mod.ImportAudioDialog ?? mod.default;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(Dialog, {
        open: true,
        onOpenChange: (v) => h.seen.openChanges.push(v),
      })
    );
  });
  mounted.push({ root, container });
  return { ...h, container, root };
}

// Radix portals the dialog to document.body; scope queries there and clean up between cases.
const button = (label) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim().includes(label));
const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};
// Unmount, do not wipe. `document.body.innerHTML = ''` tears the DOM out from under a still-mounted
// React root and from under Radix's portal, and React then walks references to nodes that no longer
// have a document. Measured: this file grew to 22.9 GB and the kernel OOM-killed the IDE. It was
// intermittent — the same file peaked at 43 MB on another run — which is exactly why it survived
// being written and run once.
const mounted = [];
const clearBody = async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
};

// --- 1: no file, no import ---------------------------------------------------------------------
{
  await clearBody();
  await render({ fileInfo: null });
  const importBtn = button('Import');
  assert.ok(importBtn, 'the dialog must offer an Import control');
  assert.equal(
    importBtn.disabled,
    true,
    'with no file chosen, Import must be refused — starting an import of nothing fails after the ' +
      'dialog has already closed on the user'
  );
}

// --- 2 and 3: an import in progress owns the dialog ---------------------------------------------
{
  await clearBody();
  const { seen } = await render({ processing: true });

  assert.equal(
    button('Import'),
    undefined,
    'while an import is running the dialog must not still offer Import — a screen offering both ' +
      'is the shape #15 was about'
  );
  const cancel = button('Cancel');
  assert.ok(cancel, 'and it must offer Cancel, which is the only way to stop the work');

  // Escape is what a user reaches for; the guard is in `handleOpenChange`.
  await act(async () => {
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  });
  assert.deepEqual(
    seen.openChanges.filter((v) => v === false),
    [],
    'the dialog must not close while an import is running — losing the surface takes Cancel with it'
  );

  await click(cancel);
  assert.equal(seen.cancelled, 1, 'and Cancel must actually cancel the import');
}

// --- 4, 5 and 6: what the import is started with -------------------------------------------------
{
  await clearBody();
  const { seen } = await render({});
  await click(button('Import'));
  assert.equal(seen.started.length, 1, 'Import must start exactly one import');
  const [path, title, language, modelName, provider] = seen.started[0];

  assert.equal(path, FILE.path, 'the import must be given the path of the file that was chosen');
  // **Two independent mechanisms guarantee this, and they cover for each other.** The effect at
  // `ImportAudioDialog.tsx:161` pre-fills `title` from the filename, and line 186 falls back with
  // `title || fileInfo.filename`. Removing either one alone leaves the assertion green — both
  // controls were run and both came back green — so the honest control for this row mutates
  // **both**, and only then does it go red. Recorded rather than papered over: a reader who
  // mutates one line and sees green would otherwise conclude this assertion is scaffolding.
  assert.equal(
    title,
    FILE.filename,
    'an untouched dialog must import under the file\'s own name — the title is pre-filled from ' +
      'the filename, so a meeting called "" is never created'
  );
  assert.equal(
    language,
    null,
    '"auto" must reach the backend as null — a language literally named "auto" is not one any ' +
      'model knows'
  );
  assert.equal(modelName, 'parakeet', 'the chosen model name must be passed');
  assert.equal(provider, 'local', 'and its provider with it — the name alone does not identify it');
}

console.log(
  'ok - import dialog: no file means no import, a running import cannot be dismissed and offers ' +
    'only Cancel, and the import carries the path, the filename fallback, a null language for auto, ' +
    'and both halves of the model choice'
);

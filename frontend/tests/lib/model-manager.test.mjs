// What the download manager offers per model state, driven rather than read.
//
// #66, component 7 of 8. The issue's row: *"download and disk state, where a wrong branch strands a
// user mid-download"*. 515 lines, never rendered. It shows a list where every row is in one of five
// states, and the bug it is on the list for is a row offering the wrong control for its state.
//
//   1. **A model already downloading offers Cancel, not Download.** Offering both is the #15 shape,
//      and here pressing Download during a download starts a second one against the same file.
//   2. **The controls act on their own row.** With a list, a name taken from the wrong row cancels
//      or deletes a model the user was not looking at. This is asserted per command, not once.
//   3. **A cancelled download becomes downloadable again.** That is the "stranded" case verbatim: a
//      row stuck showing Cancel for work that stopped is a model the user can never retry.
//   4. **A model that is present offers deletion; one that is not, does not.** Delete on an absent
//      model is a command that can only fail.
//   5. **The first available model is selected when nothing is selected yet**, and a model that is
//      *not* available is never auto-selected — selecting a corrupted model hands the rest of the
//      app a file that will not load.
//
// Six behaviours, six readable controls — and a fourth finding that is not about this component
// alone. **Mutating a state guard so both of its branches render at once does not fail by
// assertion; it exhausts memory.** Three occurrences now, all measured under a 1.5 GB cap:
// `{isNotDownloaded && !modelIsDownloading &&` → `{isNotDownloaded &&` here, the delete guard at
// :445 → `{true &&` here, and `ImportAudioDialog.tsx:429` in #89 — where that same mutation, left
// in the working tree by an unrestored control, took a worker to 28 GB and OOM-killed the IDE six
// times.
//
// So the controls below avoid that shape where a readable one exists: "a downloading row must offer
// Cancel" is controlled by removing the Cancel branch, not by making Download reappear. The
// remaining assertion — that Download is *absent* while downloading — has no such alternative, and
// its control is named here rather than pretended.
//
// Scaffolding divergences, written where the next person reads them (#66 condition 4):
//   * `builtin-ai-download-progress` arrives through `listen`, so the event stub hands back a
//     handle the test can fire. Progress *rendering* is not asserted — it is a percentage in a bar,
//     and asserting it would be asserting markup.
//   * Stubs hand back one object per render; a fresh literal each time re-runs dependency-array
//     effects forever (measured at 28 GB in #89).
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const model = (name, type, over = {}) => ({
  name,
  display_name: name.toUpperCase(),
  status: { type },
  size_mb: 1500,
  context_size: 4096,
  description: `${name} description`,
  gguf_file: `${name}.gguf`,
  ...over,
});

const MODELS = [
  model('gemma4-e2b', 'available'),
  // A second available model: deletion is only offered for one that is not the current selection.
  model('gemma4-spare', 'available'),
  model('gemma4-e4b', 'not_downloaded'),
  model('broken-one', 'corrupted'),
];

function harness({ models = MODELS, selectedModel = 'gemma4-e2b' } = {}) {
  const seen = { selected: [] };
  const stubs = tauriStubs({
    extra: {
      builtin_ai_list_models: models,
      builtin_ai_download_model: null,
      builtin_ai_cancel_download: null,
      builtin_ai_delete_model: null,
    },
  });
  const overrides = {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
  };
  return { seen, stubs, overrides, selectedModel };
}

const mounted = [];
async function render(opts = {}) {
  const h = harness(opts);
  const { BuiltInModelManager } = loadTsx('src/components/BuiltInModelManager.tsx', h.overrides);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(BuiltInModelManager, {
        selectedModel: h.selectedModel,
        onModelSelect: (m) => h.seen.selected.push(m),
      })
    );
  });
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
 * The smallest element that contains both this model's display name **and** its controls.
 * Not simply the smallest element containing the name: that is a text node's parent, with no
 * buttons in it, and a lookup that returns it makes every "must offer X" assertion fail for a
 * reason that has nothing to do with the component.
 */
const rowFor = (container, name) =>
  [...container.querySelectorAll('div')]
    .filter((d) => d.textContent.includes(name.toUpperCase()) && d.querySelector('button'))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
// Matches the button's text, or its `title`/`aria-label` when it has none: the icon-only Delete
// control (`BuiltInModelManager.tsx:445-452`) carries `title="Delete model"` and a `Trash2` glyph,
// and this file stubs `lucide-react` to render nothing, so by text alone it is invisible.
const buttonIn = (row, label) =>
  [...row.querySelectorAll('button')].find((b) => {
    const text = `${b.textContent} ${b.getAttribute('title') ?? ''} ${b.getAttribute('aria-label') ?? ''}`;
    return text.toLowerCase().includes(label.toLowerCase());
  });
const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};
const callsTo = (stubs, cmd) =>
  stubs.calls.filter((c) => c.cmd === cmd).map((c) => JSON.parse(JSON.stringify(c.args ?? null)));

// --- 2 and 4: the controls act on their own row -------------------------------------------------
{
  await clear();
  const { container, stubs } = await render();

  const absent = rowFor(container, 'gemma4-e4b');
  assert.ok(absent, 'a model that is not downloaded must appear in the list');
  const download = buttonIn(absent, 'Download');
  assert.ok(download, 'and it must offer Download');
  await click(download);
  assert.deepEqual(
    callsTo(stubs, 'builtin_ai_download_model'),
    [{ modelName: 'gemma4-e4b' }],
    'Download must name the row it was pressed on — with a list, the wrong name downloads a ' +
      'model the user was not looking at'
  );

  // Deletion is offered for an available model that is **not** the current selection
  // (`BuiltInModelManager.tsx:445`), so this asserts on a second available model rather than on
  // `gemma4-e2b`, which the harness selects. Asserting it on the selected row would have passed for
  // the wrong reason -- the first version of this did exactly that, with a fallback that matched
  // some other button's aria-label.
  const spare = rowFor(container, 'gemma4-spare');
  const del = buttonIn(spare, 'Delete');
  assert.ok(del, 'an available model that is not the current selection must offer deletion');
  await click(del);
  assert.deepEqual(
    callsTo(stubs, 'builtin_ai_delete_model'),
    [{ modelName: 'gemma4-spare' }],
    'and Delete must name its own row'
  );
  assert.equal(
    buttonIn(absent, 'Delete'),
    undefined,
    'a model that is not present must not offer deletion — delete on an absent model can only fail'
  );
}

// --- 1 and 3: a download owns its row, and giving up gives the row back ---------------------------
{
  await clear();
  const { container, stubs } = await render();
  await click(buttonIn(rowFor(container, 'gemma4-e4b'), 'Download'));

  const downloading = rowFor(container, 'gemma4-e4b');
  assert.ok(
    buttonIn(downloading, 'Cancel'),
    'a row that is downloading must offer Cancel'
  );
  assert.equal(
    buttonIn(downloading, 'Download'),
    undefined,
    'and must not still offer Download — pressing it would start a second download of the same file'
  );

  await click(buttonIn(downloading, 'Cancel'));
  assert.deepEqual(
    callsTo(stubs, 'builtin_ai_cancel_download'),
    [{ modelName: 'gemma4-e4b' }],
    'Cancel must name its own row'
  );
  assert.ok(
    buttonIn(rowFor(container, 'gemma4-e4b'), 'Download'),
    'and a cancelled download must leave the model downloadable again — a row stuck showing ' +
      'Cancel for work that stopped is a model the user can never retry'
  );
}

// --- 5: what gets auto-selected, and what never does ---------------------------------------------
{
  await clear();
  const { seen } = await render({ selectedModel: '' });
  assert.deepEqual(
    seen.selected,
    ['gemma4-e2b'],
    'with nothing selected, the first *available* model must be chosen'
  );

  await clear();
  const none = await render({
    selectedModel: '',
    models: [model('broken-one', 'corrupted'), model('gemma4-e4b', 'not_downloaded')],
  });
  assert.deepEqual(
    none.seen.selected,
    [],
    'and when nothing is available, nothing is selected — handing the rest of the app a corrupted ' +
      'or absent model gives it a file that will not load'
  );
}

console.log(
  'ok - model manager: Download, Cancel and Delete each name their own row, a downloading row ' +
    'offers only Cancel, a cancelled download becomes downloadable again, and only an available ' +
    'model is ever auto-selected'
);

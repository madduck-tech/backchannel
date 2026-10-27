// A moonshine_streaming row is labelled as the segment-by-segment rows are. (#200)
//
// moonshine_streaming streams, but one stream holds at most 81.9 s and kept only a meeting's first
// seconds, so the application decodes it in VAD segments. Its rows said "Live, as you speak", "word by
// word" and "one column", none of which is what happens. The product owner decided they read as the
// segment rows do, and that `moonshine-streaming-small-q8` stays in first run's four.
//
// The rows' `streaming` comes from the generated catalogue itself (`config.rs`), read here, so the test
// holds what the application ships, not a value written for it. Three surfaces: Settings' card, first
// run's catalogue, and the first-run model screen. Each asserts the new words and **the absence of the
// old ones** (ADR 0023).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

// The catalogue rows for the family, as `discover_models` would hand them over.
const configRs = fs.readFileSync(new URL('../../src-tauri/src/config.rs', import.meta.url), 'utf8');
const catalogue = configRs.slice(configRs.indexOf('TRANSCRIBE_MODEL_CATALOG'));
const ROWS = [...catalogue.matchAll(/TranscribeModel \{([\s\S]*?)\n    \}/g)]
  .map((m) => m[1])
  .filter((b) => /name: "moonshine-streaming-/.test(b))
  .map((b) => ({
    name: b.match(/name: "([^"]+)"/)[1],
    family: b.match(/family: "([^"]+)"/)[1],
    size_mb: Number(b.match(/size_mb: (\d+)/)[1]),
    streaming: b.match(/streaming: (true|false)/)[1] === 'true',
  }));
assert.equal(ROWS.length, 3, `precondition: the catalogue lists ${ROWS.length} moonshine_streaming rows, expected 3`);

// Settings renders the catalogue in file order (`sortModels('catalog')` returns it unchanged). The
// generator sorted by `streaming`, so relabelling these rows moved them from rows 1-3 to 39-41 of 86, a
// change nobody decided (#200's gate). They keep their place among the natively streaming rows, ahead
// of every batch row; `canary-180m-flash-q8` is the first batch row by name.
const ORDER = [...catalogue.matchAll(/TranscribeModel \{([\s\S]*?)\n    \}/g)].map((m) => m[1].match(/name: "([^"]+)"/)[1]);
// 96 since #175 regenerated the catalogue from upstream's records (86 before).
assert.equal(ORDER.length, 96, `precondition: the catalogue has ${ORDER.length} rows, expected 96`);
const firstBatch = ORDER.indexOf('canary-180m-flash-q8');
assert.ok(firstBatch > 0, 'precondition: canary-180m-flash-q8 is in the catalogue');
for (const row of ROWS) {
  assert.ok(ORDER.indexOf(row.name) < firstBatch, `${row.name} is row ${ORDER.indexOf(row.name) + 1} of ${ORDER.length}, after the first batch row (${firstBatch + 1}): Settings would show it among the batch models`);
}

const model = (r) => ({
  path: `/m/${r.name}.gguf`, accuracy: 'Good', wer: 3, wer_set: 'LibriSpeech test-clean', speed: 'Very Fast', status: 'Missing',
  description: r.family, languages: ['en'], recommended: true, diarizes: false, ...r,
});
const MODELS = [
  ...ROWS.map(model),
  // A streaming row with no cap, so the absences below are about these rows and not the screen.
  model({ name: 'nemotron-3.5-asr-streaming-0.6b-q8', family: 'Nemotron 3.5', size_mb: 716, streaming: true }),
];
const OLD = /word by word|as you speak|one column/i;
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); });

function backend() {
  return tauriStubs({
    extra: {
      transcribe_get_available_models: () => MODELS.map((m) => ({ ...m })),
      get_onboarding_status: null,
      check_first_launch: true,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      builtin_ai_is_model_ready: true,
      check_database_exists: false,
      check_default_legacy_database: false,
      initialize_fresh_database: null,
      transcribe_open_models_folder: null,
    },
  });
}

// --- Settings' card ------------------------------------------------------------------------------------
{
  const s = backend();
  const modules = { ...boundaryStubs().modules, '@tauri-apps/api/core': s.core, '@tauri-apps/api/event': s.event };
  const tooltip = loadTsx('src/components/ui/tooltip.tsx', modules);
  const { default: TranscriptionModelManager } = loadTsx('src/components/TranscriptionModelManager.tsx', { ...modules, '@/components/ui/tooltip': tooltip });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(React.createElement(tooltip.TooltipProvider, null,
      React.createElement(TranscriptionModelManager, { selectedModel: 'parakeet-tdt-0.6b-v3-q8', onModelSelect: () => {} })));
  });
  await settle();
  for (const row of ROWS) {
    // Settings names a row as `getModelLabel` writes it: "moonshine-streaming-small (Q8)".
    const shown = row.name.replace(/-(q4|q8)$/, (_, q) => ` (${q.toUpperCase()})`);
    const label = [...box.querySelectorAll('span.font-medium')].find((e) => e.textContent.trim() === shown);
    const card = label?.closest('div.rounded-lg');
    check(`precondition: Settings shows ${row.name}`, !!card, 'no card');
    if (!card) continue;
    const tag = [...card.querySelectorAll('span.rounded-full')].find((t) => /Live/.test(t.textContent));
    check(`Settings: ${row.name}'s tag reads "Live, per sentence"`, tag?.textContent.trim() === 'Live, per sentence', `it reads "${tag?.textContent.trim()}"`);
    check(`Settings: ${row.name}'s tag takes the segment mode's colour`, !!tag && tag.className.includes('bg-warn-soft') && !tag.className.includes('bg-brand-soft'), `its classes are "${tag?.className}"`);
    check(`Settings: ${row.name}'s card carries none of the old words`, !OLD.test(card.textContent), `it reads "${card.textContent.match(OLD)?.[0]}"`);
  }
  await act(async () => { r.unmount(); });
  box.remove();
}

// --- First run: the model screen and its catalogue -------------------------------------------------------
{
  const s = backend();
  const modules = { ...boundaryStubs().modules, '@tauri-apps/api/core': s.core, '@tauri-apps/api/event': s.event };
  const context = loadTsx('src/contexts/OnboardingContext.tsx', modules);
  const tooltip = loadTsx('src/components/ui/tooltip.tsx', modules);
  const catalogueModule = loadTsx('src/components/onboarding/shared/ModelCatalogue.tsx', modules);
  const { TranscriptionModelStep } = loadTsx('src/components/onboarding/steps/TranscriptionModelStep.tsx', {
    ...modules,
    '@/contexts/OnboardingContext': context,
    '../shared/ModelCatalogue': catalogueModule,
    '@/components/ui/tooltip': tooltip,
    '../OnboardingContainer': {
      OnboardingContainer: ({ children, footer }) => React.createElement('div', null, children, React.createElement('footer', null, footer)),
    },
  });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(React.createElement(tooltip.TooltipProvider, null,
      React.createElement(context.OnboardingProvider, null, React.createElement(TranscriptionModelStep))));
  });
  await settle();

  // The recommended card: its own label element holds the id, the decode it prints, and the copy.
  const card = [...box.querySelectorAll('label')].find((l) => l.querySelector('.readout')?.textContent === 'moonshine-streaming-small-q8');
  check('precondition: first run recommends moonshine-streaming-small-q8', !!card, 'no card');
  if (card) {
    check('first run: the card prints the segment decode', /· batch ·/.test(card.textContent), `it reads "${card.textContent.slice(0, 160)}"`);
    check('first run: the card says text arrives in chunks, in two sides', /chunks/.test(card.textContent) && /two sides/.test(card.textContent), `it reads "${card.textContent.slice(0, 200)}"`);
    check('first run: the card carries none of the old words', !OLD.test(card.textContent), `it reads "${card.textContent.match(OLD)?.[0]}"`);
  }
  // A streaming row with no cap still says so: the old words exist on the screen, just not for these rows.
  const nemotron = [...box.querySelectorAll('label')].find((l) => l.querySelector('.readout')?.textContent === 'nemotron-3.5-asr-streaming-0.6b-q8');
  check('sentinel: the uncapped streaming card still reads "word by word"', !!nemotron && /word by word/.test(nemotron.textContent), `it reads "${nemotron?.textContent.slice(0, 160)}"`);

  const open = [...box.querySelectorAll('button')].find((b) => b.textContent.includes('Browse every model'));
  await act(async () => { open?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await settle();
  const rows = [...box.querySelectorAll('[role="radiogroup"][aria-label="Models"] [role="radio"]')];
  for (const row of ROWS) {
    const el = rows.find((e) => e.querySelector('.readout')?.textContent === row.name);
    check(`precondition: the catalogue lists ${row.name}`, !!el, 'no row');
    if (!el) continue;
    check(`catalogue: ${row.name} reads "in chunks"`, /in chunks/.test(el.textContent), `it reads "${el.textContent.slice(0, 160)}"`);
    check(`catalogue: ${row.name} carries none of the old words`, !OLD.test(el.textContent), `it reads "${el.textContent.match(OLD)?.[0]}"`);
  }
  await act(async () => { r.unmount(); });
  box.remove();
}

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - the moonshine_streaming rows read as segment-by-segment on all three surfaces, with none of the streaming words');

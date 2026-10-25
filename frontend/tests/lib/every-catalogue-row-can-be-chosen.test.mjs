// Every row of first run's catalogue can be chosen, and Settings' card is what it was. (#166)
//
// First run mounted the Settings card with `canDownload={false}`. That card offers `Use` only for a file
// already on disk and `Download` only where downloads are allowed, so on a clean profile all 86 rows
// rendered no control. The 82 models outside the recommended four could not be chosen anywhere in first
// run. `catalogue-offers-one-action.test.mjs:66-80` read only how `canDownload` was declared, and
// nothing rendered a row.
//
// **The real step inside the real `OnboardingProvider`.** A choice is held when the provider's
// `selectedTranscribeModel` moves, not when a stub's setter is called. Only the backend is stubbed, and
// every command the run invokes is recorded, so "choosing fetches nothing" is read from what was asked.
//
// The rows follow the approved prototype `design/prototypes/onboarding-catalogue.html` (`a4`): a radio
// per row, chosen by click, Enter or Space, and a search over the id, the family and the languages.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const model = (over) => ({
  path: '/m/x.gguf', accuracy: 'High', wer: 3, wer_set: 'set', speed: 'Fast', status: 'Missing',
  description: '', streaming: false, languages: ['en'], recommended: false, diarizes: false, ...over,
});
// A clean profile, plus one whole file and one truncated one, so condition 4 sees every row state.
const MODELS = [
  model({ name: 'parakeet-tdt-0.6b-v3-q8', family: 'Parakeet TDT v3', size_mb: 740, languages: ['en', 'de', 'fr', 'ru', 'uk'], recommended: true }),
  model({ name: 'moonshine-tiny-q8', family: 'Moonshine', size_mb: 34, status: 'Available', recommended: true }),
  model({ name: 'gigaam-v3-ctc-q8', family: 'GigaAM', size_mb: 259, languages: ['ru'], description: 'Sber model trained on Russian speech.' }),
  model({ name: 'whisper-tiny-q8', family: 'Whisper', size_mb: 44, languages: ['en', 'ru', 'de', 'ja', 'zh'], description: 'Smallest Whisper: smaller download, lower memory use.' }),
  model({ name: 'granite-speech-4.1-2b-q8', family: 'Granite Speech', size_mb: 2100, languages: ['en', 'fr'] }),
  model({ name: 'canary-180m-flash-q8', family: 'Canary', size_mb: 190, status: { Corrupted: { file_size: 52_000_000, expected_min_size: 179_000_000 } } }),
];

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); });
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

function backend() {
  return tauriStubs({
    extra: {
      transcribe_get_available_models: () => MODELS.map((m) => ({ ...m })),
      get_onboarding_status: null,
      save_onboarding_status: null,
      check_first_launch: true,
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      check_database_exists: false,
      check_default_legacy_database: false,
      initialize_fresh_database: null,
      transcribe_open_models_folder: null,
      // Answered, so a row that starts a download is recorded and caught by condition 3, rather than
      // throwing as an unstubbed command and failing for a reason of its own.
      transcribe_download_model: null,
      builtin_ai_is_model_ready: true,
    },
  });
}

// --- first run --------------------------------------------------------------------------------------
const stubs = backend();
const modules = {
  ...boundaryStubs().modules,
  '@tauri-apps/api/core': stubs.core,
  '@tauri-apps/api/event': stubs.event,
};
const context = loadTsx('src/contexts/OnboardingContext.tsx', modules);
// The application mounts `TooltipProvider` once, in its layout, so it is mounted here too. Without it,
// `main`'s first run, which mounted Settings' card with its tooltips, died on the provider before any
// assertion about choosing could run.
const firstRunTooltip = loadTsx('src/components/ui/tooltip.tsx', modules);
// Loaded by its literal path, so `no-invisible-component.test.mjs` sees that a test renders it, and
// handed to the step as the module it imports, so the step renders this very instance.
const catalogueModule = loadTsx('src/components/onboarding/shared/ModelCatalogue.tsx', modules);
const { TranscriptionModelStep } = loadTsx('src/components/onboarding/steps/TranscriptionModelStep.tsx', {
  ...modules,
  '@/contexts/OnboardingContext': context,
  '../shared/ModelCatalogue': catalogueModule,
  '@/components/ui/tooltip': firstRunTooltip,
  '../OnboardingContainer': { OnboardingContainer: ({ children }) => React.createElement('div', null, children) },
});

let ctx = null;
const Probe = () => { ctx = context.useOnboarding(); return React.createElement(TranscriptionModelStep); };
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(firstRunTooltip.TooltipProvider, null,
    React.createElement(context.OnboardingProvider, null, React.createElement(Probe))));
});
await settle();

const open = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Browse every model'));
assert.ok(open, 'the first-run screen has no "Browse every model" button');
await act(async () => { open.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
await settle();

const group = () => container.querySelector('[role="radiogroup"][aria-label="Models"]');
const rows = () => [...(group()?.querySelectorAll('[role="radio"]') ?? [])];
const rowFor = (name) => rows().find((r) => r.querySelector('.readout')?.textContent === name);
const shownIds = () => rows().map((r) => r.querySelector('.readout')?.textContent);
if (!group()) {
  // Before #166 first run mounted Settings' card. Say what its row for a model not on disk offered.
  const card = [...container.querySelectorAll('div.rounded-lg')].find((c) => c.textContent.includes('gigaam-v3-ctc'));
  const offers = [...(card?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
  assert.fail(`the catalogue renders no radiogroup of its own; the gigaam-v3-ctc-q8 row, not on disk, offers ${JSON.stringify(offers)}, none of which chooses it`);
}
assert.equal(rows().length, MODELS.length, `the catalogue lists ${rows().length} rows of ${MODELS.length}`);

const fetchesBefore = stubs.calls.filter((c) => /download/i.test(c.cmd)).length;
const choose = async (name, how) => {
  const r = rowFor(name);
  if (!r) { failures.push(`no row for ${name}`); return; }
  await act(async () => {
    if (how === 'click') r.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    else r.dispatchEvent(new window.KeyboardEvent('keydown', { key: how, bubbles: true, cancelable: true }));
  });
  await settle();
};
const exactlyChecked = (name) => {
  const on = rows().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.querySelector('.readout').textContent);
  const off = rows().filter((r) => r.getAttribute('aria-checked') === 'false').length;
  return on.length === 1 && on[0] === name && off === rows().length - 1 ? null : `checked: ${JSON.stringify(on)}, unchecked ${off} of ${rows().length}`;
};

// 1a-1d. Each input on a row whose file is not on disk.
for (const [cond, name, how] of [['1a', 'gigaam-v3-ctc-q8', 'click'], ['1b', 'whisper-tiny-q8', 'Enter'], ['1c', 'granite-speech-4.1-2b-q8', ' ']]) {
  await choose(name, how);
  check(`${cond} a row not on disk is chosen by ${how === ' ' ? 'Space' : how}`, ctx.selectedTranscribeModel === name,
    `the provider holds ${ctx.selectedTranscribeModel} after ${JSON.stringify(how)} on ${name}`);
  const d = exactlyChecked(name);
  check(`1d aria-checked marks only ${name}`, d === null, d);
}
// A recommended row in the catalogue makes the same choice the four options above make.
await choose('moonshine-tiny-q8', 'click');
check('1a a recommended row is chosen too', ctx.selectedTranscribeModel === 'moonshine-tiny-q8', `the provider holds ${ctx.selectedTranscribeModel}`);
const radio = [...container.querySelectorAll('input[name="transcription-model"]')].find((i) => i.checked);
check('1d the four options above follow a choice made in the catalogue', radio?.closest('label')?.textContent.includes('moonshine-tiny-q8') === true,
  `the checked option above reads "${radio?.closest('label')?.textContent.slice(0, 60)}"`);
const fetches = stubs.calls.filter((c) => /download/i.test(c.cmd)).slice(fetchesBefore).map((c) => c.cmd);
check('3 choosing fetches nothing', fetches.length === 0, `choosing invoked ${JSON.stringify(fetches)}`);

// 4 and 6, with every row in view: a whole file, a truncated one, and nothing on disk.
const controls = rows().flatMap((r) => [...r.querySelectorAll('button, [data-state], [data-slot="tooltip-trigger"], a, input')]
  .map((el) => `${r.querySelector('.readout').textContent}: <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 30)}"`));
check('4 first run rows carry no controls', controls.length === 0, controls.join('; '));
const catalogueText = group()?.textContent ?? '';
check('4 nothing the product owner removed is back (#138)', !/Sort by|Installed only|word error rate|WER/i.test(catalogueText),
  `the catalogue reads "${catalogueText.match(/Sort by|Installed only|word error rate|WER/i)?.[0]}"`);
const truncated = rowFor('canary-180m-flash-q8')?.textContent ?? '';
check('6 a truncated row says what choosing it does', /Incomplete download/.test(truncated) && /fetches the whole file again/.test(truncated),
  `the truncated row reads "${truncated}"`);
check('6 and names no control it lacks', !/download again|delete|repair|remove/i.test(truncated), `the truncated row reads "${truncated}"`);

// 1e-1f. The search, typed into the field.
const field = container.querySelector('input[type="search"]');
assert.ok(field, 'the catalogue has no search field');
const type = async (text) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { set.call(field, text); field.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await settle();
};
check('1e the field reads as the prototype\'s', field.getAttribute('placeholder') === 'Language or model name', `placeholder "${field.getAttribute('placeholder')}"`);
for (const [query, want, by] of [
  ['gigaam-v3-ctc-q8', ['gigaam-v3-ctc-q8'], 'a full model id'],
  ['Granite Speech', ['granite-speech-4.1-2b-q8'], 'a family, which no id spells'],
  ['Russian', ['gigaam-v3-ctc-q8', 'parakeet-tdt-0.6b-v3-q8', 'whisper-tiny-q8'], 'a language name'],
  ['ru', ['gigaam-v3-ctc-q8', 'parakeet-tdt-0.6b-v3-q8', 'whisper-tiny-q8'], 'a language code'],
]) {
  await type(query);
  const got = shownIds().sort();
  check(`1e ${by} finds its rows`, JSON.stringify(got) === JSON.stringify([...want].sort()), `"${query}" shows ${JSON.stringify(got)}`);
}
await type('memory');
check('1f a word only in a description matches nothing', rows().length === 0 && /Nothing matches/.test(group()?.textContent ?? ''),
  `"memory" shows ${JSON.stringify(shownIds())}; the group reads "${(group()?.textContent ?? '').slice(0, 80)}"`);
await type('');

await act(async () => { root.unmount(); });
container.remove();

// --- Settings: the card is what it was ----------------------------------------------------------------
{
  const s = backend();
  const settingsModules = {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': s.core,
    '@tauri-apps/api/event': s.event,
  };
  // The application mounts `TooltipProvider` once, in its layout. The card's tooltips need it, and it
  // must be the same module instance the card imports, so the card is handed this one.
  const tooltip = loadTsx('src/components/ui/tooltip.tsx', settingsModules);
  const { default: TranscriptionModelManager } = loadTsx('src/components/TranscriptionModelManager.tsx', {
    ...settingsModules,
    '@/components/ui/tooltip': tooltip,
  });
  const picked = [];
  const box = document.createElement('div');
  document.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(React.createElement(tooltip.TooltipProvider, null,
      React.createElement(TranscriptionModelManager, { selectedModel: 'parakeet-tdt-0.6b-v3-q8', onModelSelect: (n) => picked.push(n) })));
  });
  await settle();
  // A card is the bordered block whose text carries the model's label, `gigaam-v3-ctc (Q8)`.
  const cards = [...box.querySelectorAll('div.rounded-lg')];
  const cardFor = (label) => cards.find((c) => c.textContent.includes(label));
  const buttons = (c) => [...(c?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
  const missing = cardFor('gigaam-v3-ctc');
  const onDisk = cardFor('moonshine-tiny');
  check('5a Settings offers Download for a model not on disk', buttons(missing).includes('Download'), `the gigaam card offers ${JSON.stringify(buttons(missing))}`);
  check('5b Settings offers Delete for a model on disk', buttons(onDisk).includes('Delete'), `the moonshine card offers ${JSON.stringify(buttons(onDisk))}`);
  check('5c Settings cannot choose a model not on disk', !buttons(missing).includes('Use'), `the gigaam card offers ${JSON.stringify(buttons(missing))}`);
  await act(async () => { missing?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  check('5c and clicking its card chooses nothing', picked.length === 0, `clicking the gigaam card chose ${JSON.stringify(picked)}`);
  await act(async () => { r.unmount(); });
  box.remove();
}

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - every first-run catalogue row is chosen by click, Enter or Space without fetching, the search finds an id, a family and a language and nothing hidden, rows carry no controls, and Settings keeps Download, Delete and Use-only-on-disk');

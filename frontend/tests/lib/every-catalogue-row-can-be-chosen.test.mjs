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
  // Italian and Estonian too: their names contain "ta" and begin with "es", which are codes no model here carries.
  // Two-word language names, Norwegian Bokmål and Norwegian Nynorsk. Listed before whisper, so `nb` is
  // the first code "norwegian" names, and a row carrying only `no` needs the whole set.
  model({ name: 'kb-whisper-small-q8', family: 'KB Whisper', size_mb: 300, languages: ['nb', 'nn', 'sv'] }),
  // Norwegian as `no`, beside a row naming `nb` and `nn`: "norwegian" names all three codes.
  model({ name: 'whisper-tiny-q8', family: 'Whisper', size_mb: 44, languages: ['en', 'ru', 'de', 'ja', 'zh', 'it', 'et', 'no'], description: 'Smallest Whisper: smaller download, lower memory use.' }),
  // Belarusian: its name contains "rus", which begins Russian.
  model({ name: 'granite-speech-4.1-2b-q8', family: 'Granite Speech', size_mb: 2100, languages: ['en', 'fr', 'be'] }),
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

// The prototype's search field has `autofocus`, and its rows are sorted by family, then size, then id.
const searchField = container.querySelector('input[type="search"]');
check('1e the search is focused when the catalogue opens', document.activeElement === searchField,
  `the focused element is <${document.activeElement?.tagName?.toLowerCase()}>`);
const ORDER = ['canary-180m-flash-q8', 'gigaam-v3-ctc-q8', 'granite-speech-4.1-2b-q8', 'kb-whisper-small-q8', 'moonshine-tiny-q8', 'parakeet-tdt-0.6b-v3-q8', 'whisper-tiny-q8'];
check('1e the rows are in the prototype\'s order', JSON.stringify(shownIds()) === JSON.stringify(ORDER), `the rows read ${JSON.stringify(shownIds())}`);

const fetchesBefore = stubs.calls.filter((c) => /download/i.test(c.cmd)).length;
// Returns whether the event's default went ahead: false means the row prevented it, which for Space is
// what stops the page from scrolling under the person's finger (the prototype's `preventDefault`).
const choose = async (name, how) => {
  const r = rowFor(name);
  if (!r) { failures.push(`no row for ${name}`); return true; }
  let wentAhead = true;
  await act(async () => {
    if (how === 'click') wentAhead = r.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    else wentAhead = r.dispatchEvent(new window.KeyboardEvent('keydown', { key: how, bubbles: true, cancelable: true }));
  });
  await settle();
  return wentAhead;
};
const exactlyChecked = (name) => {
  const on = rows().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.querySelector('.readout').textContent);
  const off = rows().filter((r) => r.getAttribute('aria-checked') === 'false').length;
  return on.length === 1 && on[0] === name && off === rows().length - 1 ? null : `checked: ${JSON.stringify(on)}, unchecked ${off} of ${rows().length}`;
};

// 1a-1d. Each input on a row whose file is not on disk.
for (const [cond, name, how] of [['1a', 'gigaam-v3-ctc-q8', 'click'], ['1b', 'whisper-tiny-q8', 'Enter'], ['1c', 'granite-speech-4.1-2b-q8', ' ']]) {
  const wentAhead = await choose(name, how);
  if (how === ' ') check('1c Space does not scroll the page', wentAhead === false, 'the keydown for Space was not prevented');
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
// The whole catalogue, not only its rows: a control above the radiogroup is still on first run's screen.
// That is where the product owner's #138 instruction applies; `catalogue-offers-one-action.test.mjs`
// holds the same removals on Settings' card.
const catalogue = group()?.parentElement;
const catalogueText = catalogue?.textContent ?? '';
check('4 nothing the product owner removed is back (#138)', !/Sort by|Sort models|Installed only|Show only installed|word error rate|WER/i.test(catalogueText),
  `the catalogue reads "${catalogueText.match(/Sort by|Sort models|Installed only|Show only installed|word error rate|WER/i)?.[0]}"`);
const extraControls = [...(catalogue?.querySelectorAll('button, select, input:not([type="search"])') ?? [])].map((el) => `<${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 30)}"`);
check('4 the search field is the catalogue\'s only control', extraControls.length === 0 && catalogue?.querySelectorAll('input').length === 1, `the catalogue also offers ${extraControls.join(', ')}`);
// And on the whole screen: the instruction is about what first run shows, not about one component.
// The screen's only buttons are Continue and the catalogue's own toggle, and nothing sorts or filters.
const screenButtons = [...container.querySelectorAll('button')].map((b) => b.textContent.trim()).sort();
check('4 the screen offers no sort or filter beside the catalogue', JSON.stringify(screenButtons) === JSON.stringify(['Continue', 'Hide the catalogue'])
  && container.querySelectorAll('select').length === 0 && !/Sort by|Sort models|Installed only|Show only installed/i.test(container.textContent),
  `the screen's buttons read ${JSON.stringify(screenButtons)}`);
const truncated = rowFor('canary-180m-flash-q8')?.textContent ?? '';
check('6 a truncated row says what choosing it does', /Incomplete download/.test(truncated) && /the whole file is fetched again/.test(truncated),
  `the truncated row reads "${truncated}"`);
check('6 and names no control it lacks', !/download again|delete|repair|remove/i.test(truncated), `the truncated row reads "${truncated}"`);
// 52 000 000 bytes is 49.6 MiB, the catalogue's unit: `size_mb` counts MiB (`engine.rs:169`).
check('6 in the catalogue\'s unit', /50 MB of 190 MB/.test(truncated), `the truncated row reads "${truncated}"`);

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
  ['uk', ['parakeet-tdt-0.6b-v3-q8'], 'a two-letter code, matched as a code'],
  ['ta', [], 'a code no model carries, though "Italian" contains it'],
  ['es', [], 'a code no model carries, though "Estonian" begins with it'],
  ['ital', ['whisper-tiny-q8'], 'the start of a language name'],
  ['rus', ['gigaam-v3-ctc-q8', 'parakeet-tdt-0.6b-v3-q8', 'whisper-tiny-q8'], 'the start of a name, not anywhere in one (Belarusian)'],
  ['norwegian bokmål', ['kb-whisper-small-q8'], 'a name of two words'],
  ['bok', ['kb-whisper-small-q8'], 'the start of a second word'],
  ['norwegian', ['kb-whisper-small-q8', 'whisper-tiny-q8'], 'a name several codes share'],
]) {
  await type(query);
  const got = shownIds().sort();
  check(`1e ${by} finds its rows`, JSON.stringify(got) === JSON.stringify([...want].sort()), `"${query}" shows ${JSON.stringify(got)}`);
  // Compared with the name the row itself prints, in the reader's locale, so this holds on any desktop.
  const shown = (code) => new Intl.DisplayNames(undefined, { type: 'language', fallback: 'none' }).of(code);
  if (query === 'ital') {
    const langs = rowFor('whisper-tiny-q8')?.textContent ?? '';
    check('1e a row of many languages names the one searched for', langs.includes(`8 languages, incl. ${shown('it')}`), `the whisper row reads "${langs}"`);
  }
  if (query === 'norwegian') {
    const langs = rowFor('whisper-tiny-q8')?.textContent ?? '';
    check('1e every code a query names counts for "incl."', langs.includes(`8 languages, incl. ${shown('no')}`), `the whisper row reads "${langs}"`);
  }
}
await type('memory');
check('1f a word only in a description matches nothing', rows().length === 0 && /Nothing matches/.test(group()?.textContent ?? ''),
  `"memory" shows ${JSON.stringify(shownIds())}; the group reads "${(group()?.textContent ?? '').slice(0, 80)}"`);
await type('');

await act(async () => { root.unmount(); });
container.remove();

// --- the catalogue's other states: a backend that fails, an empty catalogue, and one still loading -----
for (const [state, answer, expect, forbid] of [
  ['an error', () => { throw new Error('engine not initialised'); }, /Could not read the model catalogue: engine not initialised\. Choose one of the four models above\./, /Nothing matches|Error: /],
  ['an empty catalogue', () => [], /The catalogue is empty, so there is no other model to choose\. Choose one of the four above\./, /Nothing matches/],
  ['loading', () => new Promise(() => {}), null, /Nothing matches|Loading models…/],
]) {
  const st = tauriStubs({ extra: { transcribe_get_available_models: answer } });
  const { ModelCatalogue } = loadTsx('src/components/onboarding/shared/ModelCatalogue.tsx', {
    ...boundaryStubs().modules, '@tauri-apps/api/core': st.core, '@tauri-apps/api/event': st.event,
  });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => { r.render(React.createElement(ModelCatalogue, { selectedModel: '', onModelSelect: () => {} })); });
  await settle();
  const text = box.textContent;
  if (expect) check(`7b ${state} says so`, expect.test(text), `the catalogue reads "${text.slice(0, 120)}"`);
  else check(`7b ${state} is a skeleton`, box.querySelector('[aria-busy="true"]') !== null, `the catalogue reads "${text.slice(0, 120)}"`);
  check(`7b ${state} gives no search advice`, !forbid.test(text), `the catalogue reads "${text.slice(0, 120)}"`);
  await act(async () => { r.unmount(); });
  box.remove();
}

// --- 1e on a desktop in another language ----------------------------------------------------------
//
// The rows print language names in the reader's locale, as Settings does. A desktop in Russian, run in
// a child process because the default locale is fixed when Node starts. The sentinel is the row
// printing "русский": without it, an English-only run would read as a pass.
{
  const lib = new URL('.', import.meta.url).pathname;
  const child = `
    const { setupDom } = await import(${JSON.stringify(lib + 'dom-harness.mjs')});
    const { tauriStubs } = await import(${JSON.stringify(lib + 'tauri-stubs.mjs')});
    const { boundaryStubs } = await import(${JSON.stringify(lib + 'boundary-stubs.mjs')});
    const { React, createRoot, act } = await setupDom();
    const { loadTsx } = await import(${JSON.stringify(lib + 'render-tsx.mjs')});
    const st = tauriStubs({ extra: { transcribe_get_available_models: () => ${JSON.stringify(MODELS)} } });
    const { ModelCatalogue } = loadTsx('src/components/onboarding/shared/ModelCatalogue.tsx', {
      ...boundaryStubs().modules, '@tauri-apps/api/core': st.core, '@tauri-apps/api/event': st.event,
    });
    const box = document.createElement('div'); document.body.appendChild(box);
    await act(async () => { createRoot(box).render(React.createElement(ModelCatalogue, { selectedModel: '', onModelSelect: () => {} })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const field = box.querySelector('input[type="search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { set.call(field, 'Russian'); field.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const rows = [...box.querySelectorAll('[role="radio"]')].map((r) => r.textContent);
    console.log(JSON.stringify({ rows: rows.length, gigaam: rows.find((t) => t.includes('gigaam-v3-ctc-q8')) ?? null }));
    process.exit(0);
  `;
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8' },
  });
  const line = (r.stdout || '').trim().split('\n').pop() || '{}';
  let got = {};
  try { got = JSON.parse(line); } catch { got = { error: (r.stderr || '').slice(0, 200) }; }
  check('1e precondition: the child run is in Russian', /русский/.test(got.gigaam ?? ''), `the gigaam row reads ${JSON.stringify(got.gigaam ?? got)}`);
  check('1e an English name finds its rows on a Russian desktop', got.rows === 3, `"Russian" shows ${got.rows} rows under ru_RU`);
}

// --- 7c: a progress event with no total keeps the catalogue's size --------------------------------
{
  const handlers = new Map();
  const listen = async (name, fn) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; };
  const emit = async (name, payload) => { for (const fn of handlers.get(name) ?? []) await fn({ payload }); };
  const st = tauriStubs({
    extra: {
      transcribe_get_available_models: () => MODELS.map((m) => ({ ...m })),
      transcribe_init: null,
      transcribe_has_available_models: false,
      transcribe_download_model: () => new Promise(() => {}),
      transcribe_list_models: [],
      builtin_ai_download_model: () => new Promise(() => {}),
      builtin_ai_list_models: [],
      builtin_ai_get_recommended_model: 'gemma4:e2b',
      builtin_ai_is_model_ready: true,
      get_onboarding_status: null,
      save_onboarding_status: null,
      check_first_launch: true,
      check_database_exists: false,
      check_default_legacy_database: false,
      initialize_fresh_database: null,
      get_permission_status: {},
    },
  });
  const mods = { ...boundaryStubs().modules, '@tauri-apps/api/core': st.core, '@tauri-apps/api/event': { ...st.event, listen } };
  const onboarding = loadTsx('src/contexts/OnboardingContext.tsx', mods);
  const motion = new Proxy({}, { get: () => (props) => React.createElement('div', null, props?.children) });
  const { DownloadProgressStep } = loadTsx('src/components/onboarding/steps/DownloadProgressStep.tsx', {
    ...mods,
    '@/contexts/OnboardingContext': onboarding,
    '../OnboardingContainer': { OnboardingContainer: ({ children, footer }) => React.createElement('div', null, children, React.createElement('footer', null, footer)) },
    'framer-motion': { motion, AnimatePresence: ({ children }) => children },
  });
  let c = null;
  const Probe = () => { c = onboarding.useOnboarding(); return c.currentStep === 3 ? React.createElement(DownloadProgressStep) : null; };
  const box = document.createElement('div');
  document.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => { r.render(React.createElement(onboarding.OnboardingProvider, null, React.createElement(Probe))); });
  await settle();
  await act(async () => { c.setSelectedTranscribeModel('whisper-tiny-q8'); });
  await settle();
  await act(async () => { c.goToStep(3); });
  await settle();
  const rowText = () => box.querySelector('section[aria-label="whisper-tiny-q8"]')?.textContent ?? '';
  check('7c precondition: the row shows the catalogue\'s size', /0 of 44 MB/.test(rowText()), `the row reads "${rowText().slice(0, 120)}"`);
  await act(async () => { await emit('model-download-progress', { modelName: 'whisper-tiny-q8', progress: 2, downloaded_mb: 1, total_mb: 0 }); });
  await settle();
  check('7c a progress event with no total keeps it', /1 of 44 MB/.test(rowText()), `after a progress event with total_mb 0 the row reads "${rowText().slice(0, 120)}"`);
  await act(async () => { r.unmount(); });
  box.remove();
}

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

// The first run asks two questions before it downloads anything, and each answer reaches the backend.
//
// #111 cycles A and B. Before this, `OnboardingContext.tsx:369` ran `initializeSummaryModelSelection`
// on mount, `:112-115` set a summary model with **no user input**, and
// `DownloadProgressStep.tsx:188-194` fired the moment it was truthy — **3.6 GiB with no button, no
// opt-out and nothing asked**. And on the last step `complete_onboarding` wrote `"builtin-ai"` and
// `DEFAULT_TRANSCRIBE_MODEL` as constants, so any answer the user *had* given was thrown away.
//
// What is held here: the two steps render their choices, a choice that sends transcripts off the
// machine says so on the option itself, a cloud choice asks for the key it needs, and both answers
// travel to `complete_onboarding` rather than being replaced by constants.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 900, height: 700 });
const { loadTsx } = await import('./render-tsx.mjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');  // frontend/

const onboarding = (over = {}) => ({
  goNext: () => {},
  selectedTranscribeModel: 'parakeet-tdt-0.6b-v3-q8',
  setSelectedTranscribeModel: () => {},
  summaryProvider: 'builtin-ai',
  setSummaryProvider: () => {},
  setSelectedSummaryModel: () => {},
  recommendedSummaryModel: 'gemma4:e2b',
  ...over,
});

// Literal paths, not a template. `no-invisible-component.test.mjs` scans this directory for
// `loadTsx('<path>')` to decide which components a test renders, and a computed specifier is
// invisible to it — the component would sit in the backlog while a test drives it.
const STEPS = {
  TranscriptionModelStep: (o) => loadTsx('src/components/onboarding/steps/TranscriptionModelStep.tsx', o),
  SummariserStep: (o) => loadTsx('src/components/onboarding/steps/SummariserStep.tsx', o),
};

async function render(component, ctx, extra = {}) {
  const invoked = [];
  const { [component]: Step } = STEPS[component](
    {
      ...boundaryStubs().modules,
      '@/contexts/OnboardingContext': { useOnboarding: () => ctx },
      '@tauri-apps/api/core': {
        invoke: async (cmd, args) => {
          invoked.push({ cmd, args });
          return null;
        },
      },
      // The container is the step's frame -- progress rail, title, back button -- and it reaches for
      // the onboarding provider itself. Stubbed to its children, because what is under test is the
      // choice, not the chrome around it.
      '../OnboardingContainer': {
        // Renders the footer too: #154 moved the primary control into it, and a children-only
        // passthrough hides the very button the assertions below are about.
        OnboardingContainer: ({ children, footer }) =>
          React.createElement('div', null, children, React.createElement('footer', null, footer)),
      },
      // `__esModule` is not decoration: the picker is a default export, and TypeScript's interop
      // wraps a module without that flag in `{ default: mod }` — so the component would come out as
      // the stub object itself and React would reject it with "Element type is invalid... got:
      // object". Measured while writing this.
      '@/components/TranscriptionModelManager': {
        __esModule: true,
        default: ({ selectedModel }) =>
          React.createElement('div', { 'data-picker': selectedModel ?? '' }),
      },
      ...extra,
    }
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(React.createElement(Step, null)); });
  return { container, invoked };
}

const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};

// --- 1: four options and a button, not a catalogue ------------------------------------------------
{
  const { container } = await render('TranscriptionModelStep', onboarding());
  const options = [...container.querySelectorAll('input[type="radio"]')];
  assert.equal(
    options.length,
    4,
    `the first screen offers four models, not 86. The first version of it mounted the Settings ` +
      `panel whole -- search, sort, an "installed only" toggle and a paragraph about word error ` +
      `rates -- on the first screen a new user meets. Got ${options.length}`
  );

  // Multilingual first. The catalogue's own order puts three English-only Moonshine rows above the
  // multilingual ones, and the picker's "Recommended" sort is `catalog`, which returns the list
  // unchanged -- so a Russian or Japanese speaker's first three options could not transcribe them.
  const text = container.textContent;
  const first = text.indexOf('parakeet-tdt-0.6b-v3-q8');
  const nemotron = text.indexOf('nemotron-3.5-asr-streaming-0.6b-q8');
  const english = text.indexOf('moonshine-streaming-small-q8');
  assert.ok(first >= 0 && nemotron >= 0 && english >= 0, 'all three must be offered');
  assert.ok(
    first < english && nemotron < english,
    'the two multilingual models must come before the English-only ones'
  );

  // The trade is stated in words, not in the term "streaming".
  assert.match(text, /two sides/, 'a batch model must say the transcript has two sides');
  assert.match(text, /one column/, 'and a streaming one must say it does not');

  // The catalogue is reachable, and not on screen until asked for.
  assert.equal(
    container.querySelector('[data-picker]'),
    null,
    'the 86-row picker must not be on the first screen'
  );
  // The assertion that used to stand here required a button labelled with the catalogue's row count,
  // and it was wrong. The product owner's instruction on 2026-09-08 was to remove the catalogue's sort
  // and filter controls; they were moved behind that button instead, and this line then *required* the
  // arrangement that had been rejected. ADR 0023 decision 2: an assertion that conflicts with an
  // instruction is wrong by definition and is deleted when the instruction is recorded, even when the
  // implementation cannot follow yet.
  //
  // What is owed in its place -- that the catalogue offers no sort control -- is red on `6448f5f` and
  // cannot land until the catalogue is redesigned, which needs an approved prototype (ADR 0022
  // decision 5). The debt is #132.

  const go = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Continue'));
  assert.ok(go && !go.disabled, 'with a model chosen the way forward is open');

  const { container: empty } = await render(
    'TranscriptionModelStep',
    onboarding({ selectedTranscribeModel: '' })
  );
  const blocked = [...empty.querySelectorAll('button')].find((b) => b.textContent.includes('Continue'));
  assert.equal(
    blocked.disabled,
    true,
    'and with none chosen it is not — this model is the one the application cannot work without'
  );
}

// --- 2: the summariser step says where the words go, on the option -------------------------------
{
  const { container } = await render('SummariserStep', onboarding());
  const text = container.textContent;

  for (const [provider, destination] of [
    // The verb is the approved prototype's, not this check's invention: `c-inline-scroll` writes
    // "Sends each transcript to {dest}. Needs an API key." on every remote option. This used to
    // pin "sent to Anthropic", the copy before #154, and enforcing that would have made the check
    // require wording the product owner replaced.
    ['Claude', 'Sends each transcript to Anthropic'],
    ['OpenAI', 'Sends each transcript to OpenAI'],
    ['Groq', 'Sends each transcript to Groq'],
    ['OpenRouter', 'Sends each transcript to OpenRouter'],
  ]) {
    assert.ok(text.includes(provider), `${provider} must be offered`);
    assert.ok(
      text.includes(destination),
      `${provider} must name its destination on the option itself, not in a footnote — the first ` +
        'run used to promise "your data never leaves your device" and then let the user pick this ' +
        `with nothing saying so. Missing: ${destination}`
    );
  }
  assert.ok(
    text.includes('Nothing leaves'),
    'and the local options must say that nothing leaves — it is the half of the old claim that survives'
  );
  assert.ok(
    text.includes('3651 MiB'),
    'the local choice must state what it costs to download; the cloud ones cost nothing'
  );
}

// --- 3: a cloud choice cannot continue without the key it needs ----------------------------------
{
  const { container } = await render('SummariserStep', onboarding({ summaryProvider: 'claude' }));
  const key = container.querySelector('input[type="password"]');
  assert.ok(key, 'a provider that needs an API key must ask for one');
  assert.match(
    key.getAttribute('aria-label') ?? '',
    /API key for Claude/,
    'and the field must name which provider it belongs to'
  );
  const go = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Continue'));
  assert.equal(
    go.disabled,
    true,
    'without a key the choice cannot be completed — a cloud summariser with no key fails at the ' +
      'first meeting, long after the user has left this screen'
  );

  // A local choice asks for nothing.
  const { container: local } = await render('SummariserStep', onboarding());
  assert.equal(
    local.querySelector('input[type="password"]'),
    null,
    'a local provider must not ask for a key it has no use for'
  );
}

// --- 4: the choice reaches the backend, with the key ---------------------------------------------
{
  const { container, invoked } = await render('SummariserStep', onboarding());
  const go = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Continue'));
  await click(go);
  const save = invoked.find((c) => c.cmd === 'api_save_model_config');
  assert.ok(
    save,
    'the summariser choice must be saved. `api_save_model_config` already writes the provider, the ' +
      'model and the key together and is registered in `lib.rs` — #111 v3 said no key-writing path ' +
      'existed, and it does'
  );
  assert.equal(save.args.provider, 'builtin-ai');
}

// --- 5: both answers travel to complete_onboarding, instead of being replaced by constants -------
{
  const context = fs.readFileSync(path.join(root, 'src/contexts/OnboardingContext.tsx'), 'utf8');
  const call = context.match(/invoke\('complete_onboarding',\s*\{([\s\S]*?)\}\)/);
  assert.ok(call, "the context must still call `complete_onboarding`");
  for (const field of ['provider', 'transcribeModel']) {
    assert.match(
      call[1],
      new RegExp(`\\b${field}:`),
      `\`${field}\` must be passed. The Rust side used to write "builtin-ai" and ` +
        'DEFAULT_TRANSCRIBE_MODEL as constants, so whatever the user chose was discarded on the ' +
        'last step of the flow it was chosen in'
    );
  }

  const rust = fs.readFileSync(path.join(root, 'src-tauri/src/onboarding.rs'), 'utf8');
  assert.match(
    rust,
    /provider: Option<String>/,
    'and the command must accept it, rather than the frontend sending a field nothing reads'
  );
  assert.ok(
    !/save_model_config\(\s*pool,\s*"builtin-ai"/.test(rust),
    'the hardcoded provider must be gone from the write, not merely shadowed by a parameter'
  );
}

console.log(
  'ok - onboarding choices: transcription is asked first and gates its own Continue, every remote ' +
    'summariser names its destination and asks for its key, the choice is saved, and both answers ' +
    'reach complete_onboarding instead of being replaced by constants'
);

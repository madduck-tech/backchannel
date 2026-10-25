// First run's eighth option: an agent CLI on this machine. (#212)
//
// The approved prototype is `design/prototypes/onboarding-summariser-agents.html`, variant C: one option,
// "An agent on this machine", that opens the CLIs the backend found. Each CLI is in one of three
// states, and only one can be chosen: found and logged in. Continue waits until one is. What is held
// here is the screen against those states, with `agent_cli_status` answering as the backend would and
// the step's own state moving as a person clicks.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 900, height: 700 });
const { loadTsx } = await import('./render-tsx.mjs');

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

async function render(statuses) {
  const invoked = [];
  const ctx = {
    goNext: () => {},
    setSelectedSummaryModel: () => {},
    recommendedSummaryModel: 'gemma4:e2b',
  };
  const { SummariserStep } = loadTsx('src/components/onboarding/steps/SummariserStep.tsx', {
    ...boundaryStubs().modules,
    // State that moves: the step reads and writes `summaryProvider` as the real context lets it.
    '@/contexts/OnboardingContext': {
      SUMMARISER_IDS: ['builtin-ai', 'ollama', 'claude', 'openai', 'groq', 'openrouter', 'custom-openai', 'claude-code', 'codex'],
      useOnboarding: () => {
        const [summaryProvider, setSummaryProvider] = React.useState('builtin-ai');
        return { ...ctx, summaryProvider, setSummaryProvider };
      },
    },
    '@tauri-apps/api/core': {
      invoke: async (cmd, args) => {
        invoked.push({ cmd, args });
        return cmd === 'agent_cli_status' ? statuses : null;
      },
    },
    '../OnboardingContainer': {
      OnboardingContainer: ({ children, footer, description }) =>
        React.createElement('div', null, React.createElement('p', { 'data-description': '' }, description), children, React.createElement('footer', null, footer)),
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(React.createElement(SummariserStep, null)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { container, invoked };
}

const click = async (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const continueOf = (c) => [...c.querySelectorAll('footer button')].find((b) => b.textContent.includes('Continue'));
const readout = (c) => c.querySelector('footer').textContent.replace('Continue', '').trim();
const agentRow = (c) => [...c.querySelectorAll('[role="radio"]')].find((r) => r.textContent.startsWith('An agent on this machine'));
const cliRow = (c, id) => c.querySelector(`[data-agent="${id}"]`);

// --- one found and logged in, one found and logged out ------------------------------------------------
{
  const { container, invoked } = await render([
    { id: 'claude-code', found: '/home/u/.local/bin/claude', loggedIn: true },
    { id: 'codex', found: '/home/u/.local/bin/codex', loggedIn: false },
  ]);
  check('the heading counts eight', container.querySelector('[data-description]').textContent.startsWith('Eight choices.'), container.querySelector('[data-description]').textContent);
  const row = agentRow(container);
  check('the agent option is offered and names its CLIs', !!row && row.textContent.includes('claude · codex'), row?.textContent ?? 'none');
  check('its CLIs are inside it, not on the list', !cliRow(container, 'claude-code'), 'shown before it was opened');

  await click(row);
  check('opened with no CLI chosen, Continue waits', continueOf(container).disabled === true, 'enabled');
  check('and the footer says what is missing', readout(container) === 'Choose which agent writes the summary.', readout(container));
  const claude = cliRow(container, 'claude-code');
  const codex = cliRow(container, 'codex');
  check('a found CLI shows where', claude?.textContent.includes('Found: /home/u/.local/bin/claude'), claude?.textContent);
  check('Claude Code says where the transcript goes', claude?.textContent.includes('The transcript goes to the provider Claude Code is set up for, Anthropic by default.'), claude?.textContent);
  check('a logged-out CLI says so and how to fix it', codex?.textContent.includes('Found, but not logged in. Run codex once in a terminal to log in'), codex?.textContent);
  check("Codex says its settings are not used and that it can read files", codex?.textContent.includes('your own Codex settings are not used') && codex?.textContent.includes('it can read files on this machine'), codex?.textContent);
  check('a logged-out CLI cannot be chosen', codex?.getAttribute('aria-disabled') === 'true', codex?.getAttribute('aria-disabled'));

  await click(codex);
  check('clicking it chooses nothing', continueOf(container).disabled === true && codex.getAttribute('aria-checked') === 'false', `continue disabled ${continueOf(container).disabled}`);

  await click(cliRow(container, 'claude-code'));
  check('a usable CLI is chosen', cliRow(container, 'claude-code').getAttribute('aria-checked') === 'true', 'not checked');
  check('then Continue is enabled', continueOf(container).disabled === false, 'disabled');
  check('and the footer names where it goes', readout(container) === 'Claude Code: transcripts go to the provider Claude Code is set up for.', readout(container));

  await click(continueOf(container));
  const save = invoked.find((c) => c.cmd === 'api_save_model_config');
  check('the choice is saved as the provider, with no model and no key', save?.args?.provider === 'claude-code' && save?.args?.model === '' && save?.args?.apiKey === '', JSON.stringify(save?.args));
}

// --- neither found ------------------------------------------------------------------------------------
{
  const { container } = await render([
    { id: 'claude-code', found: null, loggedIn: null },
    { id: 'codex', found: null, loggedIn: null },
  ]);
  await click(agentRow(container));
  for (const [id, cli] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    const r = cliRow(container, id);
    check(`${cli} not found says so`, r?.textContent.includes(`Not found in your shell's PATH. Install ${cli}, then reopen this step.`), r?.textContent);
    check(`${cli} not found cannot be chosen`, r?.getAttribute('aria-disabled') === 'true', r?.getAttribute('aria-disabled'));
  }
  check('nothing usable: Continue stays disabled', continueOf(container).disabled === true, 'enabled');
}

// --- the backend answered nothing at all (a stub, or a failed command) --------------------------------
{
  const { container } = await render(null);
  await click(agentRow(container));
  check('no answer is "not found", not "looking" for ever', cliRow(container, 'claude-code')?.textContent.includes('Not found in your shell'), cliRow(container, 'claude-code')?.textContent);
}

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - the agent option opens the CLIs found, only a logged-in one can be chosen, and the choice is saved');

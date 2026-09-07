// The first run opens on a decision, not on two screens that ask nothing.
//
// #111 cycle A. Before this, a new user met `WelcomeStep` (a heading, three claims, one button) and
// then `SetupOverviewStep` (113 lines whose only computed value was `totalSteps={isMac ? 4 : 3}`).
// On Linux and Windows that is two clicks through screens that ask nothing before anything happens.
//
// The three claims went with them, and that is the point rather than a loss: "Your data never leaves
// your device" was an absolute the user could falsify a minute later by choosing a cloud summariser,
// with nothing at the point of choice saying so. `ModelSettingsModal` now names each provider's
// destination on the option itself — asserted at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDom } from './dom-harness.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');  // frontend/

/** Which step component the flow chose, for a given persisted step number. */
async function chosen(currentStep) {
  const seen = [];
  const { OnboardingFlow } = loadTsx('src/components/onboarding/OnboardingFlow.tsx', {
    '@/contexts/OnboardingContext': { useOnboarding: () => ({ currentStep }) },
    './steps': {
      TranscriptionModelStep: () => { seen.push('transcription'); return null; },
      SummariserStep: () => { seen.push('summariser'); return null; },
      DownloadProgressStep: () => { seen.push('download'); return null; },
      PermissionsStep: () => { seen.push('permissions'); return null; },
    },
    '@tauri-apps/plugin-os': { platform: () => 'linux' },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(React.createElement(OnboardingFlow, { onComplete: () => {} }));
  });
  return seen;
}

// --- 1: the first screen is a decision, and it is the one that cannot be skipped -----------------
{
  assert.deepEqual(
    await chosen(1),
    ['transcription'],
    'step 1 must ask which model turns speech into text. Two screens that asked nothing used to ' +
      'come first, so a Linux user clicked twice before anything happened — and the download used ' +
      'to begin before either choice was made'
  );
}

// --- 2: every persisted step lands on a screen ----------------------------------------------------
{
  // `currentStep` is persisted (`OnboardingContext.tsx:417-428`), so a profile saved mid-flow must
  // still resolve. The order is: transcription, summariser, download, permissions.
  for (const [step, expected] of [
    [2, 'summariser'],
    [3, 'download'],
  ]) {
    assert.deepEqual(
      await chosen(step),
      [expected],
      `a profile persisted at step ${step} must reach the ${expected} step, not a blank screen`
    );
  }
}

// --- 2b: the download comes after both choices, not before them ----------------------------------
{
  // The order is the point of cycle B: 3.6 GiB used to start downloading on mount, before anyone
  // had been asked anything. Whatever else changes, the download step must not precede either
  // choice.
  const order = [];
  for (const step of [1, 2, 3]) order.push((await chosen(step))[0]);
  assert.deepEqual(order, ['transcription', 'summariser', 'download']);
}

// --- 3: the deleted screens are gone, not merely unrendered --------------------------------------
{
  for (const name of ['WelcomeStep', 'SetupOverviewStep']) {
    assert.equal(
      fs.existsSync(path.join(root, `src/components/onboarding/steps/${name}.tsx`)),
      false,
      `${name}.tsx must be deleted, not left unreferenced — an unrendered component is a thing the ` +
        'next person restores'
    );
  }
}

// --- 4: the claims moved to the choice that can falsify them -------------------------------------
{
  const modal = fs.readFileSync(path.join(root, 'src/components/ModelSettingsModal.tsx'), 'utf8');
  // Five of the seven providers reach a third party. Each must name where the words go, on the
  // option — not in a footnote, and not on a screen the user saw a minute earlier.
  for (const [provider, destination] of [
    ['claude', /sent to Anthropic/],
    ['openai', /sent to OpenAI/],
    ['groq', /sent to Groq/],
    ['openrouter', /sent to OpenRouter/],
    ['custom-openai', /sent to the address you enter/],
  ]) {
    const item = modal.match(new RegExp(`<SelectItem value="${provider}">([\\s\\S]*?)</SelectItem>`));
    assert.ok(item, `the ${provider} option must still be offered`);
    assert.match(
      item[1],
      destination,
      `the ${provider} option must say where the transcript goes, on the option itself`
    );
  }
  for (const local of ['builtin-ai', 'ollama']) {
    const item = modal.match(new RegExp(`<SelectItem value="${local}">([\\s\\S]*?)</SelectItem>`));
    assert.match(
      item[1],
      /nothing leaves/,
      `the ${local} option must say that nothing leaves — it is the half of the claim that survives`
    );
  }
}

console.log(
  'ok - onboarding flow: the first screen is a decision, a persisted step still resumes, the two ' +
    'screens that asked nothing are deleted, and every provider names its own destination'
);

// The first-run screen asks which transcription model to use. This asserts the answer is the one
// that gets downloaded.
//
// **Why this test exists at all.** #130: the four tests shipped with #111 all stub
// `@/contexts/OnboardingContext`, and `first-run-step.test.mjs:65` replaces `startBackgroundDownloads`
// -- the function holding the defect -- with `async () => {}`. The harness that records every command
// was already there; the call under test was removed at the seam before it ran. So this test loads
// the context itself and calls the real function.
//
// **Why a non-default model.** `DEFAULT_TRANSCRIBE_MODEL` is `parakeet-tdt-0.6b-v3-q8`, and the
// download path names that constant directly. A test that accepts the default asserts the single
// value for which the hardcoded path is accidentally correct -- it is green on the defect. The
// choice here is deliberately something else.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

/** Not the default. See the header. */
const CHOSEN = 'nemotron-3.5-asr-streaming-0.6b-q8';
const DEFAULT = 'parakeet-tdt-0.6b-v3-q8';

const mounted = [];

async function mountProvider({ onDisk = [] } = {}) {
  // `tauri-stubs`' `listen` is a no-op, so nothing can reach the provider's download-progress
  // handlers. This one keeps the handlers and lets a case emit into them.
  const handlers = new Map();
  const listen = async (name, fn) => {
    handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    return () => {};
  };
  const emit = async (name, payload) => {
    for (const fn of handlers.get(name) ?? []) await fn({ payload });
  };

  const stubs = tauriStubs({
    extra: {
      transcribe_init: null,
      transcribe_has_available_models: () => onDisk.length > 0,
      transcribe_get_available_models: () => onDisk.map((name) => ({ name, status: 'Available' })),
      transcribe_download_model: null,
      transcribe_list_models: [],
      builtin_ai_download_model: null,
      builtin_ai_list_models: [],
      get_onboarding_status: null,
      save_onboarding_status: null,
      complete_onboarding: null,
      check_database_exists: false,
      get_permission_status: {},
    },
  });

  const { OnboardingProvider, useOnboarding } = loadTsx('src/contexts/OnboardingContext.tsx', {
    ...boundaryStubs().modules,
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': { ...stubs.event, listen },
  });

  // One probe child, so the test drives the same object the application's screens receive.
  let ctx = null;
  const Probe = () => {
    ctx = useOnboarding();
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(OnboardingProvider, null, React.createElement(Probe)));
  });
  mounted.push({ root, container });

  return { stubs, emit, ctx: () => ctx };
}

const clear = async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
};

const downloadsAsked = (stubs) =>
  stubs.calls.filter((c) => c.cmd === 'transcribe_download_model').map((c) => c.args?.modelName);

// --- the chosen model is the downloaded model -----------------------------------------------------
{
  const { stubs, ctx } = await mountProvider({ onDisk: [] });

  await act(async () => { ctx().setSelectedTranscribeModel(CHOSEN); });
  await act(async () => { await ctx().startBackgroundDownloads({ includeParakeet: true, includeSummary: false }); });

  const asked = downloadsAsked(stubs);
  assert.deepEqual(
    asked,
    [CHOSEN],
    `first run asked to download ${JSON.stringify(asked)} after the person chose ${CHOSEN}.\n` +
      `  The screen stores the choice and the download names a constant, so recording then refuses:\n` +
      `  "Transcription model '${CHOSEN}' is not downloaded yet."`
  );
  assert.ok(
    !asked.includes(DEFAULT),
    `the default (${DEFAULT}) was fetched instead of the choice`
  );
  await clear();
}

// --- a different model already on disk does not cancel the chosen one -----------------------------
//
// `parakeetDownloaded` is fed by `transcribe_has_available_models`, which is true when *any* model is
// Available (`transcribe_engine/commands.rs:85`). The gate `includeParakeet && !parakeetDownloaded`
// therefore reads "somebody has some model" and decides "so download nothing" -- while the person is
// looking at a screen that just took their choice. Without this case, a fix that only corrects the
// model name goes green here and leaves a person with any model on disk getting no download at all.
{
  const { stubs, ctx } = await mountProvider({ onDisk: [DEFAULT] });

  // Reached through the state the application itself sets once it has verified the disk
  // (`OnboardingContext.tsx:268, :279, :355, :369`). Measured while writing this: mounting with
  // `transcribe_has_available_models` returning true leaves the flag FALSE, because the provider
  // never issues that command on mount -- so a version of this case that only stubbed the command
  // passed without reaching the gate at all. That is the scaffolding this file's header warns about.
  await act(async () => { ctx().setParakeetDownloaded(true); });
  await act(async () => { ctx().setSelectedTranscribeModel(CHOSEN); });
  await act(async () => { await ctx().startBackgroundDownloads({ includeParakeet: true, includeSummary: false }); });

  assert.deepEqual(
    downloadsAsked(stubs),
    [CHOSEN],
    `another model was on disk, so first run downloaded nothing and kept the person's choice as a\n` +
      `  setting only. "Some model is present" is not "the chosen model is present".`
  );
  await clear();
}

// --- the retry downloads the chosen model too ------------------------------------------------------
{
  const { stubs, ctx } = await mountProvider({ onDisk: [] });
  await act(async () => { ctx().setSelectedTranscribeModel(CHOSEN); });
  await act(async () => { await ctx().retryParakeetDownload(); });

  assert.deepEqual(
    downloadsAsked(stubs),
    [CHOSEN],
    'the retry button fetched a different model from the one the first attempt was for'
  );
  await clear();
}

// --- progress for the chosen model reaches the screen ----------------------------------------------
//
// Three handlers filtered on `DEFAULT_TRANSCRIBE_MODEL`, so a person who chose anything else watched
// a bar that never moved, never turned into "done", and swallowed the error if one came. That is the
// "0.0 MB / 705.3 MB, 0%" the product owner photographed on 2026-09-08.
{
  const { emit, ctx } = await mountProvider({ onDisk: [] });
  await act(async () => { ctx().setSelectedTranscribeModel(CHOSEN); });

  await act(async () => {
    await emit('model-download-progress', {
      modelName: CHOSEN, progress: 42, downloaded_mb: 300, total_mb: 716, speed_mbps: 9,
    });
  });
  assert.equal(ctx().parakeetProgress, 42, 'progress for the chosen model never reached the screen');
  assert.equal(ctx().parakeetProgressInfo?.downloadedMb, 300, 'the byte counter stayed at zero');

  await act(async () => { await emit('model-download-complete', { modelName: CHOSEN }); });
  assert.equal(ctx().parakeetDownloaded, true, 'the chosen model finished and the screen never said so');
  await clear();
}

console.log('ok - first run downloads, retries and reports the transcription model the person chose');

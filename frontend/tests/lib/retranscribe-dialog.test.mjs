// What the destructive dialog does before it destroys anything, driven rather than read.
//
// #66, component 6 of 8. The issue's row: *"rewrites stored transcripts — the destructive one"*.
// 405 lines, never rendered. Everything here is about the moment before the rewrite: which meeting
// it names, whether it can start without the recording it would re-read, and whether the user can
// still stop it.
//
//   1. **The command carries the meeting it was opened for.** A wrong `meetingId` rewrites a
//      *different* meeting's transcript. There is no undo, and the user would find out later, on a
//      meeting they were not even looking at.
//   2. **No folder path, no retranscription.** Without the recording there is nothing to re-read,
//      and starting anyway would replace a transcript with the result of reading nothing.
//   3. `auto` reaches the backend as `null`, not the string `"auto"`.
//   4. **A running rewrite cannot be dismissed.** Losing the dialog takes Cancel with it while the
//      rewrite continues.
//   5. Cancel actually cancels — it calls the command, it does not merely close.
//   6. **A start that fails puts the dialog back.** Without that the user is stuck watching a
//      progress state for work that is not happening.
//
// Six behaviours, six controls in the pull request.
//
// Scaffolding divergences, written where the next person reads them (#66 condition 4):
//   * Every stubbed hook hands back **one object per render**, not a fresh literal. This component's
//     siblings taught that lesson expensively: a stub that mints new identities each render re-runs
//     dependency-array effects forever, and one such test reached 28 GB.
//   * The dialog is Radix and portals to `document.body`, so it is queried from there, and roots are
//     unmounted between cases rather than the body being wiped.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { tauriStubs } from './tauri-stubs.mjs';

const { React, createRoot, act } = await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');

const MEETING = 'meeting-under-test';
const FOLDER = '/home/user/recordings/meeting-under-test';
const MODELS = [{ key: 'local:parakeet', provider: 'local', name: 'parakeet', label: 'Parakeet' }];

function harness({ folder = FOLDER, failStart = false } = {}) {
  const seen = { openChanges: [] };
  const stubs = tauriStubs({
    extra: {
      start_retranscription_command: () => {
        if (failStart) throw new Error('the engine is busy');
        return null;
      },
      cancel_retranscription_command: null,
    },
  });
  // One object per render — see the header.
  const transcriptionModels = {
    availableModels: MODELS,
    selectedModelKey: 'local:parakeet',
    setSelectedModelKey: () => {},
    loadingModels: false,
    fetchModels: async () => {},
    resetSelection: () => {},
  };
  const configContext = { selectedLanguage: 'auto', transcriptModelConfig: null };
  const overrides = {
    '@tauri-apps/api/core': stubs.core,
    '@tauri-apps/api/event': stubs.event,
    '@/contexts/ConfigContext': { useConfig: () => configContext },
    '@/hooks/useTranscriptionModels': { useTranscriptionModels: () => transcriptionModels },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    sonner: { toast: Object.assign(() => {}, { success: () => {}, error: () => {}, info: () => {} }) },
  };
  return { seen, stubs, overrides, folder };
}

const mounted = [];
async function render(opts = {}) {
  const h = harness(opts);
  const mod = loadTsx('src/components/MeetingDetails/RetranscribeDialog.tsx', h.overrides);
  const Dialog = mod.RetranscribeDialog ?? mod.default;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(Dialog, {
        open: true,
        onOpenChange: (v) => h.seen.openChanges.push(v),
        meetingId: MEETING,
        meetingFolderPath: h.folder,
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

const button = (label) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim().includes(label));
const click = async (el) => {
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};
// Normalised through JSON because the arguments come back from a `node:vm` realm, where
// `deepStrictEqual` fails on objects that print identically. `?? null` because a command invoked
// with no arguments has `args === undefined`, and `JSON.stringify(undefined)` is not JSON.
const callsTo = (stubs, cmd) =>
  stubs.calls.filter((c) => c.cmd === cmd).map((c) => JSON.parse(JSON.stringify(c.args ?? null)));

// --- 1 and 3: the rewrite names the meeting it was opened for --------------------------------
{
  await clear();
  const { stubs } = await render();
  const start = button('Start');
  assert.ok(start, 'the dialog must offer a control that starts the rewrite');
  await click(start);

  const calls = callsTo(stubs, 'start_retranscription_command');
  assert.equal(calls.length, 1, 'starting must issue exactly one retranscription');
  assert.equal(
    calls[0].meetingId,
    MEETING,
    'the rewrite must name the meeting the dialog was opened for — a wrong id rewrites a ' +
      'different meeting, there is no undo, and the user finds out later on a meeting they were ' +
      'not looking at'
  );
  assert.equal(
    calls[0].meetingFolderPath,
    FOLDER,
    'and the folder it should re-read'
  );
  assert.equal(
    calls[0].language,
    null,
    '"auto" must reach the backend as null — no model knows a language called "auto"'
  );
}

// --- 2: no recording, no rewrite ---------------------------------------------------------------
{
  await clear();
  const { stubs, container } = await render({ folder: null });
  const start = button('Start');
  assert.equal(
    start.disabled,
    true,
    'without a folder path there is nothing to re-read, so the rewrite must not be offered at all'
  );
  await click(start);
  assert.deepEqual(
    callsTo(stubs, 'start_retranscription_command'),
    [],
    'and pressing it anyway must issue no command — replacing a transcript with the result of ' +
      'reading nothing is the worst outcome this dialog has'
  );
  void container;
}

// --- 4 and 5: a running rewrite owns the dialog -------------------------------------------------
{
  await clear();
  const { stubs, seen } = await render();
  await click(button('Start'));

  await act(async () => {
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.deepEqual(
    seen.openChanges.filter((v) => v === false),
    [],
    'the dialog must not close while a rewrite is running — losing it takes Cancel with it'
  );

  const cancel = button('Cancel');
  assert.ok(cancel, 'a running rewrite must still offer Cancel');
  await click(cancel);
  assert.equal(
    callsTo(stubs, 'cancel_retranscription_command').length,
    1,
    'Cancel must actually cancel the rewrite, not merely close the dialog over it'
  );
}

// --- 6: a start that fails puts the dialog back -------------------------------------------------
{
  await clear();
  const { stubs, seen } = await render({ failStart: true });
  await click(button('Start'));
  assert.equal(
    callsTo(stubs, 'start_retranscription_command').length,
    1,
    'the failing start must have been attempted'
  );
  // The footer has three branches; a failed start lands in the error one, which offers `Close` and
  // `Try Again` rather than `Start`. Both steps are asserted: being offered a way back, and that
  // way back actually working.
  assert.equal(
    button('Start Retranscription'),
    undefined,
    'a failed start must not leave the Start control as if nothing had happened'
  );
  const retry = button('Try Again');
  assert.ok(
    retry,
    'after a failed start the dialog must offer a way back — leaving it in the running state ' +
      'strands the user watching progress for work that is not happening'
  );
  await click(retry);
  assert.ok(
    button('Start Retranscription'),
    'and Try Again must actually restore the start control, not just clear the message'
  );
  void seen;
}

console.log(
  'ok - retranscribe dialog: the rewrite names its own meeting and folder, auto becomes null, a ' +
    'missing recording blocks it entirely, a running rewrite cannot be dismissed and Cancel really ' +
    'cancels, and a failed start gives the dialog back'
);

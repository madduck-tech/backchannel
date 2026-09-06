// The must-NOT-flag side of the control runner's oracle, and the only part of it nobody can tune.
//
// #94. A fixture set made only of broken controls the runner must catch is satisfied by `exit 1`,
// which scores a perfect catch rate — the same shape as the defect the runner exists to close. So the
// oracle needs a second side: sound controls the runner must **pass**. Written alongside the runner
// by the same author, those prove little; the author picks both the fixture and the expected verdict.
//
// These do not have that problem. Every control below was **declared in a pull request body on
// 2026-09-06, before this runner existed** — #83, #84, #85, #90, #91, #93 — each with its line
// number and its expected result of RED, published as part of a merged change. The tables cannot
// have been tuned to the runner because they predate it.
//
// What they cost: these mutate real source files and run real component tests, so this file is the
// slow one in the suite. That is the price of a side of the oracle the author did not choose.
//
// **What they do not prove**, stated because it would be easy to imply otherwise: replaying a
// *corrected* table confirms the corrected mutation is red. Two of the 2026-09-06 rows — the import
// dialog's title and the retranscribe no-folder guard — were published only after their single-line
// versions came back green, so what is replayed here is the fix, not the failure. The runner's value
// against that shape is as a live net for the next naive declaration, not as a guarantee.
//
// The subset is those rows whose mutation is mechanically derivable from the published prose. Rows
// that say "drop the guard" over a four-line block, or "a hole at index 3 in the window", need a
// mutation authored by hand and are therefore no better than a fixture written today; they are left
// out rather than dressed up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControls, VERDICT } from './control-runner.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// **Run against a copy, never the working tree.**
//
// `pnpm test` runs test files concurrently. The first version of this file mutated
// `src/components/Sidebar/index.tsx` in place while `sidebar.test.mjs` was reading it in another
// process, and the sidebar test failed on an assertion that had nothing wrong with it — a red that
// says nothing, which is the same class of defect as a green that proves nothing.
//
// The runner restores what it mutates, so this is not about leaving the tree dirty; it is about the
// window in between. A copy removes the window entirely, and it also means `gopnik.json` stage 2's
// `git status --porcelain` guard can never be tripped by this file.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'published-controls-'));
for (const dir of ['src', 'tests']) {
  fs.cpSync(path.join(root, dir), path.join(sandbox, dir), { recursive: true });
}
for (const file of ['package.json', 'tsconfig.json']) {
  const from = path.join(root, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(sandbox, file));
}
// Symlinked rather than copied: it is the one thing here that is large, and nothing mutates it.
fs.symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');

/** Each entry cites the pull request that published it, before this runner existed. */
const PUBLISHED = [
  {
    id: '#83 sidebar: deleting the current meeting resets it',
    file: 'src/components/Sidebar/index.tsx',
    line: 206,
    anchor: 'if (currentMeeting?.id === itemId) {',
    replace: '      if (false) {',
    check: ['node', 'tests/lib/sidebar.test.mjs'],
  },
  {
    id: '#84 transcript: the virtualiser is told one row fewer',
    file: 'src/components/VirtualizedTranscriptView.tsx',
    line: 226,
    anchor: 'count: segments.length,',
    replace: '        count: segments.length - 1,',
    check: ['node', 'tests/lib/transcript-view.test.mjs'],
  },
  {
    id: '#85 model settings: a refused backend save no longer stops onSave',
    file: 'src/components/ModelSettingsModal.tsx',
    line: 616,
    anchor: 'return;',
    replace: '        // return;',
    check: ['node', 'tests/lib/model-settings.test.mjs'],
  },
  {
    id: '#90 retranscribe: the dialog may be dismissed mid-rewrite',
    file: 'src/components/MeetingDetails/RetranscribeDialog.tsx',
    line: 230,
    anchor: 'if (!newOpen && isProcessing) {',
    replace: '    if (false) {',
    check: ['node', 'tests/lib/retranscribe-dialog.test.mjs'],
  },
  {
    id: '#91 model manager: auto-select stops requiring availability',
    file: 'src/components/BuiltInModelManager.tsx',
    line: 60,
    anchor: "data.find((m) => m.status.type === 'available')",
    replace: '        const firstAvailable = data[0];',
    check: ['node', 'tests/lib/model-manager.test.mjs'],
  },
  {
    id: '#93 first run: Continue stops asking the backend',
    file: 'src/components/onboarding/steps/DownloadProgressStep.tsx',
    line: 335,
    anchor: "invoke<boolean>('transcribe_has_available_models')",
    replace: '      const actuallyAvailable = true;',
    check: ['node', 'tests/lib/first-run-step.test.mjs'],
  },
];

const results = runControls(PUBLISHED, sandbox, { timeoutMs: 120_000 });
const bad = results.filter((r) => r.verdict !== VERDICT.ok);

assert.deepEqual(
  bad.map((r) => `${r.id}: ${r.verdict}\n      ${r.detail}`),
  [],
  'a control published before this runner existed no longer holds. Either the assertion it guards ' +
    'stopped depending on that line, or the line moved, or the runner is wrong about it — and the ' +
    'third is why these are here: they are the side of the oracle nobody could tune to the ' +
    'instrument, because they predate it.'
);

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(
  `ok - ${PUBLISHED.length} controls published on 2026-09-06, before this runner existed, all still ` +
    'red on the line they name'
);

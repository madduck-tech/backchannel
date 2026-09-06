// The control on the control runner.
//
// #94. This repository's rule is that a control which does nothing is indistinguishable from a check
// that passes. A runner that reports a failure for *everything* is indistinguishable from one that
// works — so an oracle made only of "these broken controls must be caught" is satisfied by
// `exit 1`, and proves nothing. The fixture set below therefore has two sides, and the second is the
// point:
//
//   * **must-catch** — a broken control the runner has to name, one per verdict.
//   * **must-NOT-flag** — a sound control, genuinely red, correctly restored, which the runner has
//     to pass. Without these, `exit 1` scores 100%.
//
// Fixtures are built in a temp directory rather than committed. Two reasons, both learned here:
// anything under `tests/` that is not `*.test.mjs` has to be listed as a helper
// (`ignored-tests-are-run.test.mjs` holds that, both directions), and a committed fixture check is a
// file that looks exactly like a test in review while being run by nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runControls, VERDICT } from './control-runner.mjs';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'control-fixtures-'));
const write = (rel, body) => {
  const p = path.join(work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return rel;
};

// --- the subject: a "component" with a guard, and a check that holds it ------------------------
write(
  'src/guard.mjs',
  [
    'export function canProceed(state) {',
    '  if (!state.ready) return false;',
    '  return true;',
    '}',
  ].join('\n')
);

// A check that genuinely depends on line 2.
write(
  'check-ok.mjs',
  [
    "import assert from 'node:assert/strict';",
    "const { canProceed } = await import('./src/guard.mjs');",
    "assert.equal(canProceed({ ready: false }), false, 'a state that is not ready must not proceed');",
    "console.log('ok');",
  ].join('\n')
);

// A check that does NOT depend on line 2 — it only ever asks about the ready case, so removing the
// guard leaves it green. This is the 2026-09-06 shape: an assertion held by something else.
write(
  'check-vacuous.mjs',
  [
    "import assert from 'node:assert/strict';",
    "const { canProceed } = await import('./src/guard.mjs');",
    "assert.equal(canProceed({ ready: true }), true, 'a ready state proceeds');",
    "console.log('ok');",
  ].join('\n')
);

// A check that allocates without bound: red, but it never reaches an assertion.
write(
  'check-explodes.mjs',
  ["const held = [];", 'for (;;) held.push(new Array(1_000_000).fill(7));'].join('\n')
);

// A second source, and a check with a side effect on it. This is the realistic shape of an
// unrestored mutation: the runner always puts back the file *it* mutated, so the danger is a check
// that writes somewhere else. On 2026-09-06 a mutation left in the tree cost six OOM kills before
// anyone noticed it was still there.
write('src/other.mjs', ['export const LIMIT = 10;'].join('\n'));
write(
  'check-touches-other.mjs',
  [
    "import fs from 'node:fs';",
    "fs.writeFileSync('src/other.mjs', 'export const LIMIT = 999;\\n');",
    'process.exit(1);',
  ].join('\n')
);

const guardControl = (over = {}) => ({
  id: 'guard/not-ready-cannot-proceed',
  file: 'src/guard.mjs',
  line: 2,
  anchor: 'if (!state.ready) return false;',
  replace: '  if (false) return false;',
  check: ['node', 'check-ok.mjs'],
  ...over,
});

const verdictOf = (results, id) => results.find((r) => r.id === id)?.verdict;

// Every verdict this file has actually *observed*, collected as the fixtures run.
//
// The first version of the coverage check at the bottom compared a hardcoded literal set against
// `Object.values(VERDICT)`. That is a self-report wearing the costume of verification: deleting an
// entire must-catch fixture left the suite green and the summary line still claiming "6 verdicts,
// each exercised" — measured. This issue's own thesis, reproduced inside the instrument built to
// close it. The set is now built from what came back, so a deleted fixture removes a verdict from it.
const observed = new Set();
const record = (results) => {
  for (const r of results) observed.add(r.verdict);
  return results;
};
const only = (control, options) =>
  record(runControls([control], work, { timeoutMs: 20_000, ...options }));

// --- must-NOT-flag: a sound control comes back ok ------------------------------------------------
{
  const results = only(guardControl());
  assert.equal(
    verdictOf(results, 'guard/not-ready-cannot-proceed'),
    VERDICT.ok,
    'a control that lands, turns its check red and restores cleanly must pass. Without this side ' +
      'of the oracle a runner implemented as `exit 1` scores a perfect catch rate'
  );
  assert.equal(
    fs.readFileSync(path.join(work, 'src/guard.mjs'), 'utf8').split('\n')[1],
    '  if (!state.ready) return false;',
    'and the file must be back exactly as it was'
  );
}

// --- must-catch 1: the check stayed green --------------------------------------------------------
{
  const results = only(guardControl({ id: 'vacuous', check: ['node', 'check-vacuous.mjs'] }));
  assert.equal(
    verdictOf(results, 'vacuous'),
    VERDICT.checkStayedGreen,
    'a check that passes with the line mutated must be reported, not counted as a control. This is ' +
      'the shape that came back green four times on 2026-09-06'
  );
}

// --- must-catch 2: the mutation never landed -----------------------------------------------------
{
  // The replacement is byte-identical to the line it replaces — the control writes, and changes
  // nothing. Two string replacements cancelling out is the recorded 2026-09-04 instance.
  const results = only(guardControl({ id: 'no-op', replace: '  if (!state.ready) return false;' }));
  assert.equal(
    verdictOf(results, 'no-op'),
    VERDICT.mutationDidNotLand,
    'a mutation that leaves the file byte-identical must be reported. A control that does nothing ' +
      'is indistinguishable from a check that passes — unless something says so'
  );
}

// --- must-catch 3: the anchor no longer matches the line ------------------------------------------
{
  const results = only(guardControl({ id: 'drifted', line: 3 }));
  assert.equal(
    verdictOf(results, 'drifted'),
    VERDICT.anchorDrift,
    'a line that no longer contains what the table says must stop the control before anything is ' +
      'written. Mutating a line that moved produces a confident red for a change nobody meant'
  );
  assert.match(
    results[0].detail,
    /return true;/,
    'and the report must show what was actually on the line'
  );
}

// --- must-catch 4: red, but it never asserted -----------------------------------------------------
{
  const results = only(guardControl({ id: 'explodes', check: ['node', 'check-explodes.mjs'] }), {
    heapMb: 96,
  });
  assert.equal(
    verdictOf(results, 'explodes'),
    VERDICT.diedWithoutAsserting,
    'a check that dies rather than asserting is red and proves nothing, and must be reported ' +
      'separately from a control that worked. Three components already have a mutation like this'
  );
}

// --- must-catch 5: a check with a side effect leaves the tree changed --------------------------------
{
  // Two controls in one batch. The first is sound and touches `src/other.mjs`; the second runs a
  // check that writes to that same file. The runner restores what each control mutated, so only the
  // batch-wide comparison can see it — which is why restoration is asserted over every touched file
  // at the end rather than trusted per control.
  const results = record(runControls(
    [
      {
        id: 'other/limit',
        file: 'src/other.mjs',
        line: 1,
        anchor: 'export const LIMIT = 10;',
        replace: 'export const LIMIT = 11;',
        check: ['node', 'check-ok.mjs'],
      },
      guardControl({ id: 'side-effect', check: ['node', 'check-touches-other.mjs'] }),
    ],
    work,
    { timeoutMs: 20_000 }
  ));
  assert.ok(
    results.some((r) => r.verdict === VERDICT.notRestored),
    'a check with a side effect on another source must be reported as leaving the tree changed. An ' +
      'unrestored mutation is silent until something else trips over it'
  );
  assert.equal(
    verdictOf(results, 'other/limit'),
    VERDICT.checkStayedGreen,
    'and the sound-looking first control is still judged on its own merits'
  );
  // Put the fixtures back for anything that runs after this block.
  write('src/other.mjs', 'export const LIMIT = 10;');
  write(
    'src/guard.mjs',
    ['export function canProceed(state) {', '  if (!state.ready) return false;', '  return true;', '}'].join('\n')
  );
}

// --- every verdict the runner can produce is exercised ---------------------------------------------
{
  assert.deepEqual(
    [...observed].sort(),
    Object.values(VERDICT).sort(),
    'the verdicts this run actually produced are not the verdicts the runner can produce.\n' +
      '  observed: ' + [...observed].sort().join(', ') + '\n' +
      '  declared: ' + Object.values(VERDICT).sort().join(', ') + '\n\n' +
      '  Either the runner grew a verdict with no fixture — a failure mode nobody has seen work — ' +
      'or a fixture was deleted and stopped producing one. Both are the same defect: a claim about ' +
      'coverage that nothing measured.'
  );
}

fs.rmSync(work, { recursive: true, force: true });
console.log(
  `ok - control runner: ${observed.size} verdicts observed of ${Object.values(VERDICT).length} declared; one sound ` +
    'control passes and five broken ones are named'
);

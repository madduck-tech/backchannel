// Every step the flow renders can actually be reached. (#157 measure A)
//
// **A flow check already existed and was looking at the wrong thing.** `onboarding-flow.test.mjs:78`
// asserts `['transcription', 'summariser', 'download', 'audio']` — which component each step number
// renders — and its next block reasons about unreachability, for step 5:
//
//     step 5 is macOS-only, and this harness reports linux — nothing renders, rather than a blank
//     screen with a step number nobody reaches
//
// It asked *does this step number render something* and never *does anything set this step number*.
// The map without the edges. `AudioCheckStep` — 227 lines, its own test file — was rendered at step 4
// and reached by nobody off macOS for as long as `DownloadProgressStep` kept its `goNext()` inside
// `if (isMac)`. The product owner asked where the microphone check was.
//
// This file holds the edges. Two kinds, because the audio check failed the first and writing this
// found a second failing the other:
//
//   1. **an inbound caller** — some step, or the flow itself, moves to it;
//   2. **an arithmetic that can produce it** — `goNext` clamps, and a step past the clamp is
//      unreachable no matter who calls it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

// --- what the flow renders, and under what condition -------------------------------------------
const flow = strip(read('src/components/onboarding/OnboardingFlow.tsx'));
const rendered = [...flow.matchAll(/currentStep === (\d+)\s*&&\s*(?:(\w+)\s*&&\s*)?<(\w+)/g)].map(
  ([, n, guard, component]) => ({ step: Number(n), guard: guard || null, component })
);
assert.ok(
  rendered.length >= 4,
  `only ${rendered.length} steps parsed out of OnboardingFlow.tsx; this check has gone stale`
);

// --- the arithmetic that moves it ----------------------------------------------------------------
const ctx = strip(read('src/contexts/OnboardingContext.tsx'));
// The ceiling may be a literal or a named constant; both are resolved, so naming it does not make
// this check stale and leaving it a magic number does not hide it.
const consts = Object.fromEntries(
  [...ctx.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(\d+)\s*;/g)].map(([, k, v]) => [k, Number(v)])
);
const ceilingOf = (fn, arg) => {
  const m = new RegExp(`${fn}[\\s\\S]{0,400}?Math\\.min\\(\\s*${arg}\\s*,\\s*([A-Za-z0-9_]+)\\s*\\)`).exec(ctx);
  assert.ok(m, `${fn} no longer clamps with Math.min(${arg}, …); this check has gone stale`);
  const v = /^\d+$/.test(m[1]) ? Number(m[1]) : consts[m[1]];
  assert.ok(
    Number.isFinite(v),
    `${fn} clamps with \`${m[1]}\`, which this check could not resolve to a number`
  );
  return v;
};

const highest = Math.max(...rendered.map((r) => r.step));
const reachableCeiling = Math.max(ceilingOf('goNext', 'next'), ceilingOf('goToStep', 'step'));

assert.ok(
  reachableCeiling >= highest,
  `the flow renders a step at ${highest} and nothing can set a step above ${reachableCeiling}.\n` +
    `  ${rendered.find((r) => r.step === highest).component} is rendered by ` +
    'OnboardingFlow.tsx and reachable by no arithmetic in this application, on any platform.\n' +
    `  \`goNext\` returns Math.min(prev + 1, ${reachableCeiling}), so pressing Continue on the step\n` +
    '  before it leaves the person exactly where they were.'
);

// --- and every step past the first has someone who moves to it ------------------------------------
//
// `goNext` from the step before is the ordinary edge; `goToStep` is the strip's. A step with neither
// is what #154's strip promised and the flow did not deliver.
const steps = fs
  .readdirSync(path.join(root, 'src/components/onboarding/steps'))
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.stories.tsx'));

/**
 * Whether a step advances, **and on which platforms**.
 *
 * The condition is the whole point, and the first version of this check missed it: it asked only
 * whether a file mentioned `goNext` in a callable position, so putting the call back inside
 * `if (isMac)` — the original defect, verbatim — left it green. A control that reproduces the bug
 * and does not go red is a check that would not have caught it.
 *
 * Three shapes count as an edge, and a destructure alone is none of them: a call `goNext()`, a
 * handler passed by name `onClick={goNext}`, and an arrow that calls it. `TranscriptionModelStep`
 * uses the second — demanding parentheses reported step 2 unreachable, which was the check being
 * wrong rather than the flow.
 */
function edgeFrom(src) {
  const shapes = [/goNext\s*\(\s*\)/g, /=\s*\{\s*goNext\s*\}/g, /=>\s*goNext\b/g];
  const at = [];
  for (const re of shapes) for (const m of src.matchAll(re)) at.push(m.index);
  if (!at.length) return null;

  // Unconditional if any occurrence sits outside a mac-only branch. The window is the 200 characters
  // before it: `if (isMac) { goNext(); }` and `isMac ? goNext() : …` both live well inside that, and
  // a guard further away than that is not guarding this call.
  const macOnly = (i) => /\bisMac\b[^;{}]{0,40}[?{)]\s*$|\bif\s*\(\s*isMac\s*\)\s*\{?[^;{}]{0,60}$/.test(
    src.slice(Math.max(0, i - 200), i)
  );
  return at.some((i) => !macOnly(i)) ? 'always' : 'macos';
}

const advances = new Map();
for (const f of steps) {
  const e = edgeFrom(strip(read(`src/components/onboarding/steps/${f}`)));
  if (e) advances.set(f.replace('.tsx', ''), e);
}
assert.ok(advances.size >= 3, `only ${advances.size} steps advance; this check has gone stale`);

const unreachable = rendered
  .filter((r) => r.step > 1)
  .flatMap((r) => {
    const before = rendered.find((x) => x.step === r.step - 1);
    if (!before) return [`step ${r.step} (${r.component}) — no step renders before it`];
    const edge = advances.get(before.component);
    if (!edge) return [`step ${r.step} (${r.component}) — ${before.component} never advances`];
    // A step rendered without a platform guard needs an edge that fires without one.
    if (edge === 'macos' && !r.guard) {
      return [
        `step ${r.step} (${r.component}) — ${before.component} only advances inside a macOS branch, ` +
          'and this step is rendered on every platform',
      ];
    }
    return [];
  });

assert.deepEqual(
  unreachable, [],
  'a step the flow renders cannot be reached. It will never be seen, however complete it is:\n' +
    '  the audio check was 227 lines with its own test file, rendered at step 4 on every platform,\n' +
    '  and advanced into only inside `if (isMac)`. The product owner asked where it was.'
);

// --- and the strip names as many steps as the flow has ---------------------------------------------
//
// The product owner counted them: the first two screens said four and the download screen said three,
// because `totalSteps={isMac ? 4 : 3}` was left over from when the flow ended there. A strip that
// promises a step the flow does not deliver is the same defect as a step nothing routes to, seen from
// the other end — and it is the one a person notices first.
const container = strip(read('src/components/onboarding/OnboardingContainer.tsx'));
const stripNames = /const STEPS = \[([^\]]+)\]/.exec(container);
assert.ok(stripNames, 'OnboardingContainer no longer names its steps; this check has gone stale');
const named = stripNames[1].split(',').filter((x) => x.trim()).length;

const promised = new Map();
for (const f of steps) {
  const src = strip(read(`src/components/onboarding/steps/${f}`));
  // A step that hides the strip promises nothing: macOS's permissions step passes `hideProgress`.
  if (/hideProgress\s*=\s*\{?\s*true/.test(src)) continue;
  for (const m of src.matchAll(/totalSteps=\{([^}]+)\}/g)) promised.set(f, m[1].trim());
}

const disagree = [...promised].filter(([, v]) => v !== String(named));
assert.deepEqual(
  disagree.map(([f, v]) => `${f} promises ${v} steps; the strip names ${named}`), [],
  'a screen tells the person a different number of steps from the one the strip has.\n' +
    '  Every screen of one flow shows the same strip, so they either agree or one of them is lying.'
);
assert.ok(
  named === Math.max(...rendered.filter((r) => !r.guard).map((r) => r.step)),
  `the strip names ${named} steps and the flow renders ${Math.max(...rendered.filter((r) => !r.guard).map((r) => r.step))} ` +
    'without a platform guard. A named step the flow never shows is a promise; an unnamed one it does ' +
    'show is a surprise.'
);

console.log(
  `ok - ${rendered.length} onboarding steps, every one below the ${reachableCeiling}-step ceiling ` +
    `and every one past the first advanced into by the step before it`
);

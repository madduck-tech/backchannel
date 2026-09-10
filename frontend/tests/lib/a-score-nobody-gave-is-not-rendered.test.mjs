// A confidence nobody computed must not be drawn as a confidence of zero. (#162)
//
// Measured 2026-09-10, against the built AppImage, on this machine's real models. With
// `gigaam-v3-ctc-q8` — the transcription model the product owner had chosen — every line of the
// transcript carried a red badge reading **0%**, *Low confidence*, for the whole recording
// (17 of 18 badges in one gate run; the eighteenth read 31%):
//
//     core-probe: confidence badges on screen: "0% 0% 0% 0% 0%"   (10 rows, 10 badges)
//
// The same audio and build with `parakeet-tdt-0.6b-v3-q8`:
//
//     core-probe: confidence badges on screen: "45%"              (9 rows, 1 badge)
//
// **What the producer was doing, measured rather than assumed.** The first diagnosis for this was
// NaN, and it was wrong. `what_a_family_puts_in_token_p` (an ignored instrument in `engine.rs`) ran
// each family over the same sample:
//
//     gigaam-v3-ctc-q8   91 tokens, 0 NaN, 91 exactly 0.0     -> mean 0.0
//     parakeet-…-q8      38 tokens, real values 0.92 … 1.0    -> mean 0.9936
//     moonshine-tiny-q8   0 tokens                            -> 1.0, the empty-token guard
//
// So the absence is encoded **inside the valid range**: `transcribe.h`'s zero-init rule leaves `p`
// at 0.0f for a family that fills none, and `Some(0.0)` is a perfectly finite number. That is fixed
// in Rust by `scored_confidence`, which reads all-zero across present rows as "nobody filled these
// in".
//
// This file is the other half, and it is not redundant: the same header documents `p` as **NaN when
// the architecture produces none**, `serde_json` cannot write a non-finite float, and `null !==
// undefined` is true — so a guard written as `confidence !== undefined` is wrong on its own terms
// whatever the backend does. The payload is JSON; `number | undefined` is not what can arrive.
//
// **A real zero is still a score.** The distinction this file holds is between *nothing scored it*
// and *it scored badly* — collapsing them in the safe direction would silence the warning the badge
// exists for. That is the assertion at the end, and it is the one a careless fix breaks.
//
// ## Two layers, and what this can and cannot fail
//
// The fix has two: `isScored` at each of `VirtualizedTranscriptView`'s three call sites — the tooltip
// at `:156`, the virtualised row at `:181`, the plain row at `:234` — and the same predicate inside
// `ConfidenceIndicator` itself. Measured while writing this: **reverting all three call sites alone
// leaves this file green**, because the indicator refuses again. So the call-site guard has no
// observable effect on the badge, and a control that reverts only it does nothing — which is
// indistinguishable from a check that passes.
//
// So the layers are held separately below: the indicator is rendered directly, and the view is
// rendered with both layers in play. The control table reverts them together and each alone, and
// says which of the three did nothing.
//
// **Undriven here, and named rather than implied:** the tooltip at `:156`. Its content decides
// between *"Decode confidence"* and *"Position in recording"* on the same predicate, and a Radix
// tooltip does not open under jsdom — measured: dispatching `focus` on the trigger with
// `delayDuration={0}` leaves the content unmounted. Nothing in this repository drives it.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';
import { boundaryStubs } from './boundary-stubs.mjs';

const { React, createRoot, act } = await setupDom();
globalThis.giveJsdomALayout({ width: 800, height: 600 });
const { loadTsx } = await import('./render-tsx.mjs');

const overrides = {
  ...boundaryStubs().modules,
  '@/contexts/RecordingStateContext': { useRecordingState: () => ({ captureArmed: true }) },
};

const { VirtualizedTranscriptView } = loadTsx(
  'src/components/VirtualizedTranscriptView.tsx',
  overrides
);
const { ConfidenceIndicator } = loadTsx('src/components/ConfidenceIndicator.tsx', overrides);
const { TooltipProvider } = loadTsx('src/components/ui/tooltip.tsx');

/** Render one transcript row carrying whatever the payload said about its confidence. */
async function rowWith(confidence) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(VirtualizedTranscriptView, {
          segments: [
            {
              id: 'g0',
              timestamp: 0,
              endTime: 8,
              text: 'ask not what your country can do for you',
              speaker: 'SPEAKER_00',
              confidence,
            },
          ],
        })
      )
    );
  });
  return container;
}

/**
 * Every percentage badge on screen, as written.
 *
 * Scoped to `span.readout` — the badge's own innermost element. Matching every `<span>` counts the
 * badge twice, because its wrapper carries the same `textContent`, and a first draft of this file
 * read `0% 0%` and took it for two call sites. The timestamp is also a `.readout`, and reads `00:00`,
 * so the pattern is what separates them.
 */
const badges = (container) =>
  Array.from(container.querySelectorAll('span.readout'))
    .map((s) => s.textContent.trim())
    .filter((t) => /^-?\d+(\.\d+)?%$|^NaN%$/.test(t));

// --- what cannot be a score renders nothing --------------------------------------------------
for (const [name, value] of [
  ['null, which is what serde_json writes for a NaN', null],
  ['undefined, the key absent from the payload', undefined],
  ['NaN, if it ever crosses as a JS number', NaN],
]) {
  const shown = badges(await rowWith(value));
  assert.deepEqual(
    shown,
    [],
    `confidence ${name} was drawn as ${shown.join(' ')} — a number nobody computed`
  );
  // The text itself must still be there: this is about the badge, not about hiding the transcript.
  const container = await rowWith(value);
  assert.match(container.textContent, /ask not what your country/);
}

// --- a real score still renders, and still warns ----------------------------------------------
assert.deepEqual(
  badges(await rowWith(0.45)),
  ['45%'],
  'a real low confidence must still be shown; that is what the badge is for'
);

assert.deepEqual(
  badges(await rowWith(0.92)),
  [],
  'a confident line carries no marker — decorating every line is the noise this avoids'
);

// --- the one a careless fix breaks -------------------------------------------------------------
// `!confidence`, `confidence || ...`, or a truthiness check anywhere on this path turns a model
// that is genuinely certain it heard nothing into a model that said nothing at all.
assert.deepEqual(
  badges(await rowWith(0)),
  ['0%'],
  'a genuine zero is a score and must still warn: "nothing scored it" and "it scored zero" are ' +
    'different facts, and only one of them is silence'
);

// --- the indicator's own guard, driven directly ------------------------------------------------
// The layer above cannot fail this one: the view's guard makes the indicator unreachable for an
// unscored value, so without this the indicator could go back to painting `0%` and nothing would say.
async function indicatorWith(confidence) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(
      React.createElement(ConfidenceIndicator, { confidence, showIndicator: true })
    );
  });
  return container;
}

for (const [name, value] of [
  ['null', null],
  ['undefined', undefined],
  ['NaN', NaN],
]) {
  const c = await indicatorWith(value);
  assert.equal(
    c.textContent.trim(),
    '',
    `ConfidenceIndicator drew "${c.textContent.trim()}" for a confidence of ${name}`
  );
}
assert.equal((await indicatorWith(0.45)).textContent.trim(), '45%');
assert.equal(
  (await indicatorWith(0)).textContent.trim(),
  '0%',
  'the indicator must still warn on a genuine zero'
);

console.log(
  'ok - null, undefined and NaN render no confidence badge, in the view and in the indicator; ' +
    '0.45 renders 45%; a genuine 0 still warns'
);

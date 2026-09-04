// The level meter's mapping is not the identity, and a test that assumes it is fails.
//
// `AudioLevelMeter` is the component behind the meter a user actually sees while recording
// (`RecordingControls.tsx:534`, fed by the backend's real `mic-level` RMS). It applies a
// clamp and then a log curve, because loudness is perceived logarithmically:
//
//     n = clamp(level, 0, 1);  percent = round(log10(n * 9 + 1) * 100)
//
// so 0.25 shows as 51%, not 25%. Both halves are pinned here: an earlier draft of #19
// asserted "the meter renders the value it is given", which is false on this code, and the
// clamp is what stops a level above 1 rendering past full scale.
//
// No DOM, no test runner, no @testing-library: the component is pure and effect-free, so
// static markup carries everything asserted. Interaction tests need a real DOM; this does
// not, and it should not wait on that decision.
import assert from 'node:assert/strict';
import React from 'react';
import { loadTsx, renderStatic, attr } from './render-tsx.mjs';

// `cn` is clsx + tailwind-merge, both pure string work. Loaded for real, through the same
// transpile-and-run path as the component: the assertions below read class names, and
// tailwind-merge collapses conflicting ones, so a stubbed join would assert on strings the
// application never produces.

const { AudioLevelMeter, CompactAudioLevelMeter } = loadTsx('src/components/AudioLevelMeter.tsx');

const percentOf = (level, extra = {}) =>
  Number(attr(renderStatic(React.createElement(AudioLevelMeter, { rmsLevel: level, deviceName: 'Probe', ...extra })), 'aria-valuenow'));

// --- the curve --------------------------------------------------------------------------
assert.equal(percentOf(0), 0, 'silence must read 0');
assert.equal(percentOf(0.25), 51, 'the log curve maps 0.25 to 51; 25 would mean the curve is gone');
assert.equal(percentOf(0.5), 74, 'the log curve maps 0.5 to 74');
assert.equal(percentOf(1), 100, 'full scale must read 100');

// --- the clamp --------------------------------------------------------------------------
assert.equal(percentOf(1.7), 100, 'a level above 1 must clamp, not render past full scale');
assert.equal(percentOf(-0.5), 0, 'a negative level must clamp to 0');

// --- the active dot ---------------------------------------------------------------------
const active = renderStatic(React.createElement(AudioLevelMeter, { rmsLevel: 0.5, deviceName: 'Probe', isActive: true }));
const silent = renderStatic(React.createElement(AudioLevelMeter, { rmsLevel: 0, deviceName: 'Probe', isActive: false }));
assert.match(active, /Probe — active/, 'an active meter must say so');
assert.match(silent, /Probe — silent/, 'an inactive meter must say so');
assert.notEqual(active, silent, 'active and silent must not render identically');

// --- the compact variant shares the mapping ---------------------------------------------
const compact = renderStatic(React.createElement(CompactAudioLevelMeter, { rmsLevel: 0.25 }));
assert.equal(attr(compact, 'aria-valuenow'), '51', 'the compact meter must use the same curve');
assert.match(compact, /width:\s*51%/, 'the compact bar width must follow the mapped percentage');

console.log('ok - audio level meter: log curve and clamp pinned, active state distinguishable');

// An approved prototype has a committed baseline, and drift is red. (#132 conditions 1, 2 and 5)
//
// A file in `design/prototypes/` is an approved decision — ADR 0022 decision 5 says a screen with no
// committed prototype is not implemented. Nothing checked those files until now, and it cost a defect
// the product owner found by hand: removing the language chips from the catalogue collapsed the gap
// below the search field from 106px to 1px, and its focus ring, which draws 4px outside its box,
// landed on the table header. The removal had been verified by checking the element was gone.
//
// **This is not a pixel diff, deliberately.** Node has no PNG decoder, and adding one would be a new
// dependency in a repository that refused a second test runner today for less. Byte-comparing
// Chrome's PNG output fails on another machine's antialiasing, which turns CI red for the renderer
// rather than for the design.
//
// So the baseline is the computed state: every element's box, its own text, and a fixed set of
// properties, at the three widths the design has to survive. It is deterministic, it survives a
// different machine, and its diff says *what* moved. What it cannot see is named in #132:
// rasterisation, antialiasing, shadows, and images.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import {
  capture, diff, servePrototypes, prototypeNames, PROTOTYPES, WIDTHS,
} from './design-baseline.mjs';

const baselineOf = (name) => join(PROTOTYPES, `${name}.baseline.json`);

// --- condition 2: a baseline exists only where a prototype does -----------------------------------
//
// A baseline over a screen nobody approved pins the implementer's guess rather than a decision, and
// calling that "matches the design" is the failure this issue is about, one level up.
{
  const prototypes = new Set(prototypeNames());
  const orphans = fs.readdirSync(PROTOTYPES)
    .filter((f) => f.endsWith('.baseline.json'))
    .map((f) => f.replace(/\.baseline\.json$/, ''))
    .filter((n) => !prototypes.has(n))
    .sort();
  assert.deepEqual(
    orphans, [],
    'these baselines have no prototype beside them:\n    ' + orphans.join('\n    ') +
      '\n\n  A baseline over a screen nobody approved pins a guess, not a decision. Delete it, or\n' +
      '  commit the prototype it was taken from.'
  );
}

// --- every prototype has one ----------------------------------------------------------------------
{
  const missing = prototypeNames().filter((n) => !fs.existsSync(baselineOf(n)));
  assert.deepEqual(
    missing, [],
    'these prototypes have no baseline:\n    ' + missing.join('\n    ') +
      '\n\n  Take one with `node --input-type=module -e "…capture…"`, or the file is a reference\n' +
      '  rather than an approved screen and does not belong in this directory.'
  );
}

// --- condition 1: and it still renders the way it was approved ------------------------------------
const sb = await servePrototypes();
const drift = [];
for (const name of prototypeNames()) {
  const expected = JSON.parse(fs.readFileSync(baselineOf(name), 'utf8'));
  const actual = await capture(`${sb.origin}/${name}.html`);
  const problems = diff(expected, actual);
  if (problems.length) {
    drift.push(`${name}.html — ${problems.length} difference(s):\n      ` +
      problems.slice(0, 8).join('\n      ') +
      (problems.length > 8 ? `\n      … and ${problems.length - 8} more` : ''));
  }
}
await sb.stop();

assert.deepEqual(
  drift, [],
  'a committed prototype no longer renders the way it was approved:\n\n    ' + drift.join('\n\n    ') +
    '\n\n  Either the change is wrong, or the design changed and the product owner approved it —\n' +
    '  in which case retake the baseline in the same commit.'
);

console.log(
  `ok - ${prototypeNames().length} approved prototypes render as approved, ` +
    `at ${WIDTHS.join('/')}px`
);

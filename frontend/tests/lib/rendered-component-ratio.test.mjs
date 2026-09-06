// How much of the component tree a test has ever rendered.
//
// #66 condition 3. The issue's finding was a ratio, not a list: two components of 86 were ever
// rendered, 369 lines of 17,223. A list of covered components answers "is this one covered"; it
// does not answer "how much is not", and the second question is the one that goes quiet. So this
// check holds both numbers and fails when either moves, which is what makes adding a component a
// visible act rather than a silent dilution.
//
// **Why the exact pair and not a floor.** A ratchet (`rendered >= N`) would let the denominator
// grow without anyone noticing — add fifty components, cover none, stay green. The issue names that
// failure directly: "a check hardcoding `rendered = 2` passes the first control alone." Both
// numbers are therefore asserted, and both controls below go red.
//
// **What counts as rendered.** The component a test passes to `loadTsx(...)` — the one the test is
// *about*. Children that render as a side effect are deliberately NOT counted: nothing asserts
// anything about them, and counting them would inflate the numerator with components no test would
// notice breaking. That is a divergence from "executed at least once", and it is written here
// because #66 condition 4 says scaffolding divergences get written down where the next person reads
// them.
//
// **The denominator.** `.tsx` under `src/components/`, excluding `src/components/ui/**` by the same
// rule as `component-reachability.test.mjs` (vendored shadcn, generated not written). The five
// `index.ts` barrel files under `src/components/` are excluded by the `.tsx` filter: a file that
// only re-exports has nothing to render.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles, rel, root } from './reachability-shared.mjs';

const VENDORED = /^src\/components\/ui\//;

/** Every component a test could render. */
const components = new Set(
  sourceFiles()
    .map(rel)
    .filter((f) => f.startsWith('src/components/') && f.endsWith('.tsx') && !VENDORED.test(f))
);

/** Every component some test actually hands to `loadTsx`. */
const testDir = path.join(root, 'tests');
const testFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.mjs') ? [full] : [];
  });
})(testDir).filter((f) => !f.endsWith('render-tsx.mjs'));

const rendered = new Set();
for (const file of testFiles) {
  // Comments are stripped first. Without this, a comment *mentioning* `loadTsx('...')` — this
  // file's own header is one — inflates the numerator, and the check would credit coverage to
  // prose. Crude but sufficient: these are test files, not a parser benchmark.
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const m of text.matchAll(/loadTsx\(\s*['"]([^'"]+)['"]/g)) {
    if (components.has(m[1])) rendered.add(m[1]);
  }
}

// The recorded state. Both numbers move on purpose, never by accident.
//
// Raising `RENDERED`: a component gained a test that renders it. Good — raise it.
// Raising `TOTAL`: a component was added. That is not automatically bad, but it dilutes the ratio,
// and the point of failing here is that the dilution is acknowledged rather than absorbed.
const RENDERED = 8;
const TOTAL = 75;

const ratio = ((rendered.size / components.size) * 100).toFixed(1);
const unrendered = [...components].filter((c) => !rendered.has(c)).sort();

assert.deepEqual(
  { rendered: rendered.size, total: components.size },
  { rendered: RENDERED, total: TOTAL },
  `the rendered-vs-total ratio moved: ${rendered.size}/${components.size} (${ratio}%), ` +
    `recorded ${RENDERED}/${TOTAL}.\n\n` +
    `  Rendered by a test: ${[...rendered].sort().join(', ') || '(none)'}\n` +
    `  ${unrendered.length} not rendered by any test.\n\n` +
    `  If you added a test that renders a component, raise RENDERED.\n` +
    `  If you added a component, raise TOTAL — and note that the ratio just fell.\n` +
    `  If a number fell, a test stopped rendering something and that is the finding.`
);

console.log(
  `ok - ${rendered.size} of ${components.size} components (${ratio}%) are rendered by a test; ` +
    `${unrendered.length} are not`
);

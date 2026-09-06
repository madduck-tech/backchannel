// The gallery describes the tree under test, and it mounts the way the tests mount.
//
// #107. Split deliberately: this file holds everything that can be checked **without rendering**,
// because building all 78 cards takes 96 s against this suite's 12 s and `test.yml` is the only
// required status check on `main`. Making the required check nine times slower to produce a picture
// that asserts nothing is the wrong trade. The rendering half -- the drawn-set pin and the
// zero-cards guard -- runs in `stage2-artifact.yml`, which already builds the frontend for its
// stylesheets and is deliberately not required.
//
// What is held here:
//   1. the denominator is the *same* rule `no-invisible-component.test.mjs` uses, imported;
//   2. the provider wrapper matches what `src/app/layout.tsx` actually mounts;
//   3. the gallery uses the shared stub layers and mounts, rather than server-rendering;
//   4. every kind a card can have is reachable and named.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentFiles, root } from './reachability-shared.mjs';
import { PROVIDERS, providersMountedInLayout, KIND, compiledStylesheets } from './gallery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'gallery.mjs'), 'utf8');

// --- 1: one denominator, imported rather than copied ----------------------------------------------
//
// Two copies of a scope rule drift, and then the gallery draws a tree that is not the one under
// test. Both consumers call `componentFiles()`; neither owns a rule of its own.
{
  const files = componentFiles();
  assert.ok(files.length > 0, 'the denominator is empty — the scope rule matches nothing');
  for (const consumer of ['no-invisible-component.test.mjs', 'gallery.mjs']) {
    const body = fs.readFileSync(path.join(here, consumer), 'utf8');
    assert.ok(
      /componentFiles|isComponentFile/.test(body),
      `${consumer} does not use the shared component scope rule, so it has a private denominator. ` +
        'That is how the gallery starts describing a different tree from the one under test.'
    );
    assert.doesNotMatch(
      body.replace(/^\s*\/\/.*$/gm, ''),
      /COMPONENT_ROOTS\s*=|VENDORED\s*=/,
      `${consumer} declares its own scope constants alongside the shared rule`
    );
  }
}

// --- 2: the provider wrapper is what the application mounts ---------------------------------------
//
// Hand-listed in `gallery.mjs` because deriving an order from JSX nested inside a conditional is more
// fragile than this check. Adding a provider to the application without adding it here draws a
// product that does not exist, so it is red.
{
  const mounted = providersMountedInLayout();
  const wrapped = PROVIDERS.map(([n]) => n);
  const missing = mounted.filter((p) => !wrapped.includes(p));
  const extra = wrapped.filter((p) => !mounted.includes(p));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'the gallery wraps a different provider stack than src/app/layout.tsx mounts.\n' +
      `  layout mounts : ${mounted.join(', ')}\n` +
      `  gallery wraps : ${wrapped.join(', ')}\n\n` +
      '  A component drawn outside a provider the application always supplies is a picture of a ' +
      'product that does not exist. Add it to PROVIDERS in gallery.mjs with its import path.'
  );
}

// --- 3: it mounts the way the tests mount, with the shared stubs ----------------------------------
//
// The renderer matters. `renderStatic` is server rendering — no effects, no refs — and 10 of this
// repository's 11 component test files use `createRoot`. A gallery on the other one shows a state no
// test asserts. And `.modules` matters: #102's first published table was measured with the boundary
// layer inert because it passed `boundaryStubs()` — the wrapper — where the loader wants the map.
{
  const stripped = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [needle, why] of [
    ['createRoot', 'the gallery must mount, not server-render'],
    ['boundaryStubs().modules', 'the boundary layer must be applied, not passed as its wrapper'],
    ['tauriStubs(', 'the Tauri boundary must come from the shared layer'],
  ]) {
    assert.ok(stripped.includes(needle), `gallery.mjs no longer uses \`${needle}\`: ${why}`);
  }
  assert.doesNotMatch(
    stripped,
    /renderStatic\s*\(/,
    'gallery.mjs server-renders. That is the renderer 1 of 11 component test files uses, so the ' +
      'gallery would show a state the tests do not assert — the defect #100 was blocked on.'
  );
}

// --- 4: every kind is named, and the taxonomy has no silent bucket --------------------------------
//
// `failed-asynchronously` has **no members today** and is kept deliberately. Three components threw
// from a passive effect before the Tauri boundary was wired in, where no error boundary sees it, and
// a single-process builder exits 1 after the first one. The kind is what stops such a card being
// silently counted as drawn if that returns.
{
  const kinds = Object.values(KIND);
  assert.deepEqual(
    [...new Set(kinds)].sort(),
    ['blank', 'drawn', 'failed-asynchronously', 'failed-on-mount', 'no-component-export', 'will-not-load'],
    'the card taxonomy changed. Every component gets a card of some kind; a missing card is the ' +
      'failure mode this whole series exists to prevent.'
  );
  assert.ok(
    source.includes('execFileSync'),
    'the builder no longer isolates per component. An asynchronous throw would then end the run ' +
      'rather than one card — measured: `CARD 1 About.tsx 2467` then `exit=1`, never reaching card 3.'
  );
}

console.log(
  `ok - gallery: ${componentFiles().length} components in one shared denominator, ` +
    `${PROVIDERS.length} providers matching layout.tsx, mounted with the shared stubs, ` +
    `${Object.keys(KIND).length} card kinds, ${compiledStylesheets().length} stylesheet(s) available`
);

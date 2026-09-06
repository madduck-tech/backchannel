// The boundary layer covers what the application actually calls, and nothing rebuilds it locally.
//
// #96. Six hand-written `sonner` stubs approximated a surface nobody derived, and **all six** were
// missing `warning`, `dismiss` and `custom` — while `toast.warning` is called from six files. The
// hole was not that one copy diverged; it was that six people guessed at a list that can be read.
//
// Two things are held here, and only one of them can ever fail:
//
//   * **`sonner`'s surface is derived.** The layer's members come from `grep`ping `src/`, so a
//     component that starts calling `toast.loading` moves this check, not a runtime TypeError three
//     tests later. Falsifiable: delete a member and it names the callers.
//   * **`lucide-react` has no surface to check.** Its stub is `new Proxy({}, { get: () => () => null })`,
//     total by construction. Section 3 runs over it anyway, and says so: the value of doing that is
//     not catching a missing icon (impossible) but proving the *predicate* works, because the two
//     obvious predicates do not.
//
// #104 added section 3, and the reason is that sections 1 and 2 measured a proxy for the thing.
// Section 1 derives `toast.<member>` **call sites**; nothing read which **names** the source binds.
// So `import { Toaster } from 'sonner'` (`AppToaster.tsx:3`) was uncovered while the check whose
// stated job is completeness reported completeness. Measured: `AppToaster` loaded fine and died only
// on render, with `Element type is invalid ... got: undefined`.
//
// The two derivations are orthogonal and both are kept. Knowing `toast` is bound says nothing about
// which members are invoked; knowing the members says nothing about `Toaster`.
//
// **Default and namespace imports are out of scope, and this is the reason.** `grep` over `src/`
// finds zero of either from either covered module, so an assertion would have no subject. And the
// failure they would cause is not the loud one: the loader transpiles with `esModuleInterop`, so
// `import Foo from 'sonner'` binds `__importDefault(stub)` — the whole stub object, not `undefined` —
// and `import Lucide from 'lucide-react'` binds the Proxy itself. Both bind silently wrong values
// rather than throwing, which is worth a sentence here and not worth a check with no subject.
//
// And the deduplication itself: no test may build its own stub for a module the layer covers.
// Deliberately narrow — `next/navigation` and the context hooks are *not* covered, because those
// stubs carry per-test values that assertions observe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { boundaryStubs, toastMembersCalledInSource, namedImportsFromSource } from './boundary-stubs.mjs';
import { loadTsx, renderStatic } from './render-tsx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

// --- 1: the derived surface is pinned, so a new member is a visible act ---------------------------
//
// **Not "the layer offers what the derivation found".** That was the first version and it is a
// tautology: the layer's surface *is* the derivation, so the comparison is `A === A` and can never
// fail. Measured — mutating the derivation to drop `warning` left this check green with five
// members instead of six, because both sides shrank together. Same shape as the coverage check #94
// shipped and had to fix.
//
// What is held instead is the derived set against a **pinned** one. Derivation is what makes the
// stub correct; the pin is what makes a change to it something a person sees.
const DERIVED_TOAST_MEMBERS = ['custom', 'dismiss', 'error', 'info', 'success', 'warning'];

{
  const { modules } = boundaryStubs();
  const derived = [...toastMembersCalledInSource()].sort();

  assert.deepEqual(
    derived,
    DERIVED_TOAST_MEMBERS,
    'the set of toast members this application calls has moved.\n' +
      '  now: ' + derived.join(', ') + '\n' +
      '  pinned: ' + DERIVED_TOAST_MEMBERS.join(', ') + '\n\n' +
      '  A new member means the layer just grew a stub for something nobody reviewed; a lost one ' +
      'means a call site went away. Either is worth a second of attention — update the pin ' +
      'deliberately.\n  Callers of each: ' +
      derived.map((m) => `${m} → ${callersOf(m).length}`).join(', ')
  );

  const offered = new Set(Object.keys(modules.sonner.toast));
  assert.deepEqual(
    DERIVED_TOAST_MEMBERS.filter((m) => !offered.has(m)),
    [],
    'the layer does not offer a pinned member — the derivation and the stub have come apart'
  );
  assert.ok(
    typeof modules.sonner.toast === 'function',
    'toast is also callable bare — UpdateNotification.tsx does that'
  );
}

/** Which files call `toast.<member>`, for the failure message. */
function callersOf(member) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && new RegExp(`\\btoast\\.${member}\\s*\\(`).test(fs.readFileSync(full, 'utf8')))
        hits.push(path.relative(root, full));
    }
  };
  walk(path.join(root, 'src'));
  return hits;
}

// --- 2: nothing rebuilds a module the layer covers -----------------------------------------------
{
  const covered = boundaryStubs().covered;
  const offenders = [];
  for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs'))) {
    if (file === 'boundary-is-complete.test.mjs') continue;
    const body = fs
      .readFileSync(path.join(here, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const module of covered) {
      // A local override is `'<module>':` or `<bareword>:` as a key in an overrides object.
      const key = /^[a-z][\w-]*$/.test(module) ? `(?:'${module}'|${module})` : `'${module}'`;
      if (new RegExp(`^\\s*${key}\\s*:`, 'm').test(body)) offenders.push(`${file} rebuilds ${module}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these tests build their own stub for a module the boundary layer already covers:\n    ' +
      offenders.join('\n    ') +
      '\n\n  Pass `extra` to `boundaryStubs()` if this test needs something different — that is ' +
      'what the escape hatch is for, and it keeps the difference visible instead of forking the ' +
      'stub. Modules that carry per-test values (next/navigation, the context hooks) are ' +
      'deliberately not covered and stay where they are.'
  );
}

// --- 3: every name the source *binds* is offered, for every covered module -----------------------
//
// The predicate is **property access**, and that is not a stylistic choice. `lucide-react`'s stub is
// a `Proxy` with a `get` trap and no `has` trap, so `Object.keys(stub)` is `[]` and `'Camera' in stub`
// is `false`, while `stub.Camera !== undefined` is `true`. A check written either of the first two
// ways reports all 67 lucide names as missing — it would fail loudly for the wrong reason, which is
// the better of the two bad outcomes, but it would also be rewritten to "skip the Proxy" and the
// coverage would quietly vanish.
{
  const { modules, covered } = boundaryStubs();
  const missing = [];
  for (const module of covered) {
    for (const name of [...namedImportsFromSource(module)].sort()) {
      if (modules[module][name] === undefined) missing.push(`${module} does not offer ${name}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'the application binds a name the boundary layer does not offer:\n    ' +
      missing.join('\n    ') +
      '\n\n  A component importing this name cannot render through the layer at all — it fails with ' +
      '"Element type is invalid ... got: undefined", three frames from anything that names the ' +
      'cause. Add it to the stub in boundary-stubs.mjs.'
  );
}

// --- 4: the file the hole was observable on renders through the layer -----------------------------
//
// Section 3 is a set comparison and a set comparison can be satisfied by a stub that is present and
// useless. This renders the real component through the real layer, which is the thing section 3 is a
// proxy for. `AppToaster.tsx` is the one file in the tree that imports a non-`toast` name from a
// covered module, so it is the whole subject of the defect.
{
  const { AppToaster } = loadTsx('src/components/AppToaster.tsx', boundaryStubs().modules);
  const markup = renderStatic(createElement(AppToaster));
  assert.match(
    markup,
    /data-toaster="yes"/,
    'AppToaster did not render through the boundary layer. Before #104 this threw ' +
      '"Element type is invalid ... got: undefined" because the layer offered no `Toaster`.\n' +
      `  got: ${markup}`
  );
}

console.log(
  `ok - boundary layer: ${[...toastMembersCalledInSource()].sort().join(', ')} derived from src/, ` +
    `${namedImportsFromSource('sonner').size} sonner + ${namedImportsFromSource('lucide-react').size} ` +
    'lucide names bound in src/ and all offered, and no test rebuilds a covered module'
);

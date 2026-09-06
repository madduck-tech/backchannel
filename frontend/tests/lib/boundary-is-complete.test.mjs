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
//     total by construction, so a completeness check over it is decoration and is not written. Said
//     here rather than silently omitted.
//
// And the deduplication itself: no test may build its own stub for a module the layer covers.
// Deliberately narrow — `next/navigation` and the context hooks are *not* covered, because those
// stubs carry per-test values that assertions observe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundaryStubs, toastMembersCalledInSource } from './boundary-stubs.mjs';

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

console.log(
  `ok - boundary layer: ${[...toastMembersCalledInSource()].sort().join(', ')} derived from src/, ` +
    'and no test rebuilds a covered module'
);

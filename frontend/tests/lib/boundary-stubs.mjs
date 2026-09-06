// The boundary modules that are constants, in one place.
//
// #96. Ten component tests each wrote their own picture of the boundary. `lucide-react` was ten
// copies of one line; `sonner` was six hand-written approximations of a surface nobody derived, and
// **all six were missing `warning`, `dismiss` and `custom`** while `toast.warning` is called from six
// files under `src/`.
//
// **Only the constants live here.** `next/navigation` and the context hooks deliberately do not:
// those stubs are *instruments*, not scaffolding. `sidebar.test.mjs` asserts on `useRouter().push`,
// and `model-settings.test.mjs` returns `useConfig: () => null` on purpose to drive the component's
// props path. A layer that supplied a complete `ConfigContext` would turn six of that file's
// assertions green for a reason their author did not choose. The line is drawn at "does any test
// need a different value here", and it is drawn per module rather than per category.
//
// A **factory, not an object**, from the start — the shape `tauri-stubs.mjs` already uses. `sonner`
// is a constant only while nothing observes a toast, which is true today (`grep -n "toast"
// tests/lib/*.test.mjs | grep -v "sonner:"` → empty) and is exactly the kind of fact that stops being
// true. When an assertion needs to see `toast.error` called, it passes `extra` rather than editing
// this file.
import { createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every `toast.<member>` this application calls, read from `src/` rather than from what a test
 * happened to need. This is the derivation, and `boundary-is-complete.test.mjs` is the check that
 * the layer covers all of it — the condition that catches the four holes the hand-written stubs had.
 */
export function toastMembersCalledInSource(dir = path.join(root, 'src')) {
  const members = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) {
        const body = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const m of body.matchAll(/\btoast\.([a-zA-Z]+)\s*\(/g)) members.add(m[1]);
      }
    }
  };
  walk(dir);
  return members;
}

/**
 * Every name bound by `import { … } from '<module>'` across `src/`, read from the source rather than
 * from what a test happened to need. Companion to `toastMembersCalledInSource`, and a *different*
 * question: that one asks which members are invoked on `toast`, this one asks which names the
 * application binds at all. Knowing `toast` is imported says nothing about `toast.warning`, and
 * knowing the members says nothing about `Toaster` — which is exactly the hole this closes (#104).
 *
 * Three things the obvious version gets wrong, all present in this tree:
 *   * **Multi-line statements.** A line-based reader misses `lucide-react`'s two multi-line imports
 *     and the 23 names they carry. Hence the `s` flag and no per-line loop.
 *   * **Aliases.** `import { Database as DatabaseIcon }` requires the module to offer **`Database`**;
 *     the local name is the importer's business. The part before `as` is what is taken.
 *   * **Type-only bindings.** `import { type Foo }` needs no runtime value. None exist for these two
 *     modules today, and dropping them keeps that true if one appears.
 */
export function namedImportsFromSource(module, dir = path.join(root, 'src')) {
  const names = new Set();
  const pattern = new RegExp(
    String.raw`import\s*\{([^}]*)\}\s*from\s*['"]` +
      module.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) +
      String.raw`['"]`,
    'gs'
  );
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) {
        const body = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const m of body.matchAll(pattern)) {
          for (const raw of m[1].split(',')) {
            const part = raw.trim();
            if (!part || part.startsWith('type ')) continue;
            names.add(part.split(/\s+as\s+/)[0].trim());
          }
        }
      }
    }
  };
  walk(dir);
  return names;
}

/** Icons render as SVG and no assertion in this repository looks at one. */
const lucide = () => new Proxy({}, { get: () => () => null });

/**
 * `toast` is callable *and* has members — `UpdateNotification.tsx:24` calls it bare. Every member
 * the source calls is present, and each records its calls so a test that wants to observe one can,
 * without this file changing shape.
 */
function sonner() {
  const calls = [];
  const toast = Object.assign(
    (...args) => calls.push({ member: null, args }),
    Object.fromEntries(
      [...toastMembersCalledInSource()].map((m) => [m, (...args) => calls.push({ member: m, args })])
    )
  );
  // `Toaster` is the container, imported by `AppToaster.tsx` and offered by nothing until #104.
  // It renders a marker rather than `null` for the same reason `toast` records its calls: the props
  // that matter here are `theme` and `position`, and the component exists *because* bottom-center is
  // the recording transport's slot. A test that wants to assert that should not have to fork this
  // stub. Icons get a Proxy of `() => null` because 69 markers would be noise; this is one component
  // with two meaningful props, which is a different case and is decided differently.
  const Toaster = (props = {}) =>
    createElement('div', {
      'data-toaster': 'yes',
      'data-theme': props.theme ?? '',
      'data-position': props.position ?? '',
    });
  return { module: { toast, Toaster }, calls };
}

/**
 * @param {object} [options]
 * @param {object} [options.extra]  per-test additions or replacements, the `tauri-stubs.mjs` shape
 * @returns {{ modules: object, covered: string[], toasts: Array }}
 */
export function boundaryStubs({ extra = {} } = {}) {
  const { module: sonnerModule, calls } = sonner();
  const modules = {
    'lucide-react': lucide(),
    sonner: sonnerModule,
    ...extra,
  };
  return { modules, covered: Object.keys(modules), toasts: calls };
}

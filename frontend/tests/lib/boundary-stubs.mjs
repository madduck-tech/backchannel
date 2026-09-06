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
  return { module: { toast }, calls };
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

// Load a .ts/.tsx module and its local imports, with nothing this repository does not
// already have: `typescript` (a pinned devDependency), React, and node:vm. Same
// transpile-and-run technique as blocknote-markdown.test.mjs, extended to JSX and to
// following relative and `@/` imports.
//
// Deliberately not a bundler. It resolves exactly two kinds of specifier — local files, by
// the same rules tsconfig declares, and bare package names, through Node's own resolver —
// and it lets the caller override any of them.
//
// This header used to claim that a component growing an unaccounted dependency "fails loudly
// here". It did not, and #66 condition 2 rested on that claim. A bare specifier that resolves in
// `node_modules` — which is every dependency the application actually has — was loaded silently by
// `nodeRequire`; only a package that does not exist ever threw. Measured: adding a *used*
// `import { getVersion } from '@tauri-apps/api/app'` to a component under test changed nothing.
//
// So the promise is made true a different way: pass a `Set` as the third argument and every bare
// package the load reached is recorded into it. A test then holds that set, and a new dependency
// moves it. Loudness by set equality in the caller, not by an exception here — the same idiom the
// reachability checks use.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nodeRequire = createRequire(import.meta.url);
const srcDir = path.join(root, 'src');

function resolveLocal(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = path.join(srcDir, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * @param entry     path relative to the frontend package
 * @param overrides map of specifier -> module object, consulted before anything else
 */
export function loadTsx(entry, overrides = {}, barePackages = null) {
  const cache = new Map();

  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const module = { exports: {} };
    cache.set(file, module.exports);
    vm.runInNewContext(compiled, {
      exports: module.exports,
      module,
      require: (spec) => {
        if (Object.prototype.hasOwnProperty.call(overrides, spec)) return overrides[spec];
        const local = resolveLocal(spec, file);
        if (local) return load(local);
        // A bare package. Recorded before it is loaded, so the caller can hold the set.
        if (barePackages) barePackages.add(spec);
        return nodeRequire(spec);
      },
      console,
      globalThis,
      window: globalThis.window,
      document: globalThis.document,
      React,
      // The vm context has its own globals, so a browser API the harness defines on the outer
      // `globalThis` is invisible here. `RecordingControls.tsx:62` calls `alert()` on its
      // initialisation-failure path and died with `ReferenceError: alert is not defined` three
      // frames deep in a React passive effect, where the message says nothing about the cause.
      // Passed through rather than stubbed locally: `dom-harness.mjs` captures the calls, so a
      // component that starts alerting on a path it should not shows up as a recorded call.
      alert: globalThis.alert,
      confirm: globalThis.confirm,
      prompt: globalThis.prompt,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    cache.set(file, module.exports);
    return module.exports;
  }

  return load(path.join(root, entry));
}

export const renderStatic = (element) => renderToStaticMarkup(element);

/** Attribute value of the first element carrying `name`, or null. */
export function attr(markup, name) {
  const m = markup.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

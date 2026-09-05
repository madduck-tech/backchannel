// Flat config in the shape Next 16 documents
// (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md`).
//
// What was here before was a `FlatCompat` bridge from the Next 15 era that imported
// `@eslint/eslintrc` — a package this repository never installed, so the file threw on
// import before reaching a single rule. It was not a linter that was switched off; it was
// a configuration that could not run, sitting in the tree looking like a guarantee. That
// is the defect #35 is about, and the reason `lint-step-is-enforced.test.mjs` now asserts
// every specifier here resolves.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    // ---------------------------------------------------------------------------------
    // The baseline, and why it is a baseline rather than a fix.
    //
    // eslint had never run on this tree. Its first run reported **279 findings across 171
    // files** (164 errors, 115 warnings) — measured with
    // `eslint src --format json`, counted by `ruleId` and severity. Fixing that in the same
    // change that installs the linter would be a two-hundred-file diff in which the wiring
    // is invisible, which is what #35's own "not in scope" section forbids for prettier and
    // what the critic split #31 into three issues to avoid.
    //
    // So every rule this tree currently violates is off, each with its count and its reason,
    // and the sweep is #38 (filed 2026-09-05). Everything eslint checks that this tree does NOT currently
    // violate stays on — which is most of `core-web-vitals` and `typescript`, and is the
    // value this change buys today: a new violation of any of those fails a pull request.
    //
    // Turning one of these back on is the unit of work in #38. Do it one rule at a time,
    // with the count as the before-number.
    // ---------------------------------------------------------------------------------
    rules: {
      // 85. Mostly Tauri command payloads and event bodies that were never typed. Typing
      // them is real work with real risk of getting a shape wrong; it is not a lint fix.
      '@typescript-eslint/no-explicit-any': 'off',

      // 78. Dead bindings. Individually trivial, collectively a large diff across files
      // this change does not otherwise touch — and some are function parameters where
      // deleting changes a signature.
      '@typescript-eslint/no-unused-vars': 'off',

      // 43 + 36 + 8 + 6 + 2 + 1 + 1 + 1 = 98 across the react-hooks rules, and these are
      // the ones that are NOT style. `set-state-in-effect` is extra renders and possible
      // loops; `exhaustive-deps` is stale closures reading old state. Every one is a
      // behaviour change to verify by hand, in a UI this repository can only test through
      // WebDriver. They are the most valuable rules here and the most expensive to adopt,
      // which is exactly why they get their own issue rather than a rushed pass.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/use-memo': 'off',

      // 16. Apostrophes and quotes in JSX text. Mechanical, but sixteen hand edits to
      // rendered copy belong with the rest of the sweep rather than smuggled in here.
      'react/no-unescaped-entities': 'off',
    },
  },
  globalIgnores([
    // eslint-config-next's own defaults, restated because overriding `ignores` replaces
    // them rather than adding to them.
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Not application source: Rust, the Tauri bundle, and the node test suite, which is
    // plain ESM checked by `node --test` rather than by Next's React rules.
    'src-tauri/**',
    'tests/**',
    'scripts/**',
  ]),
]);

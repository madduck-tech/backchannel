# test-runner fixtures (#268)

Files that never exit, in each shape `scripts/test-runner.mjs` must bound, and one that passes. They
live outside `tests/`, so `pnpm test` never globs them; `tests/lib/test-runner-bounds-each-file.test.mjs`
runs them through the runner with a short bound.

Each `sleep` takes its argument from the environment (`BC_HANG_MARK_A`, `_C`, `_D`, `_E`), and d writes
its `sleep`'s pid to `BC_HANG_STAMP_D`. A fixture started without its variable exits before it spawns
anything, so no run can fall back to a marker another run uses.

| file | shape |
|---|---|
| `a-blocks-in-spawnsync.mjs` | no `node:test`; the top level blocks in `spawnSync` (the `tone-graph` shape) |
| `b-awaits-forever.mjs` | a `test()` awaiting a promise that never settles, a timer keeping the loop alive |
| `c-detached-child.mjs` | a `test()` that starts a detached `sleep`, keeps it ref'ed and awaits forever (`browser.mjs`'s shape) |
| `d-holds-the-output.mjs` | no `node:test`; a `sleep` holding the file's output, `unref()`'d, then the file returns |
| `e-leaves-a-process.mjs` | no `node:test`; a detached `sleep` with no stdio, `unref()`'d, then the file returns |
| `passes.mjs` | ends by itself after about a second |

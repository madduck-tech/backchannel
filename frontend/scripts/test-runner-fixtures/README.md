# test-runner fixtures (#268)

Files that never exit, in each shape `scripts/test-runner.mjs` must bound, and one that passes. They
live outside `tests/`, so `pnpm test` never globs them; `tests/lib/test-runner-bounds-each-file.test.mjs`
runs them through the runner with a short bound.

Each `sleep` takes its argument from the environment (`BC_HANG_MARK_A`, `_C`, `_D`, `_E`, `_F`, `_H`), and d writes
its `sleep`'s pid to `BC_HANG_STAMP_D`. A fixture started without its variable exits before it spawns
anything, so no run can fall back to a marker another run uses.

| file | shape |
|---|---|
| `a-blocks-in-spawnsync.mjs` | no `node:test`; the top level blocks in `spawnSync` (the `tone-graph` shape) |
| `b-awaits-forever.mjs` | a `test()` awaiting a promise that never settles, a timer keeping the loop alive |
| `c-detached-child.mjs` | a `test()` that starts a detached `sleep`, keeps it ref'ed and awaits forever (`browser.mjs`'s shape) |
| `d-holds-the-output.mjs` | no `node:test`; a `sleep` holding the file's output, `unref()`'d, then the file returns |
| `e-leaves-a-process.mjs` | no `node:test`; `sh -c 'sleep … &'` orphans a `sleep` at once, then the file returns. Only its marker finds it |
| `f-hides-its-marker.mjs` | a `test()` that starts a detached `sleep` under `env -i`, so no marker, and awaits forever (Chrome's shape). Only the process tree finds it |
| `g-ends-its-child-soon.mjs` | no `node:test`; a child that outlives the file by 0.5 s, inside the runner's grace, so the file passes |
| `h-orphans-a-hidden-child.mjs` | a `test()` whose helper starts a marker-less `sleep` and exits 1.2 s later, writing `BC_HANG_STAMP_H`, then awaits forever. Only the runner's poll of the tree finds it |
| `i-kills-its-runner.mjs` | no `node:test`; ends its own `node --test` with SIGKILL, then exits 0. The watchdog reports 137 |
| `j-prints-a-lot.mjs` | no `node:test`; 20 MiB of output, past the runner's 16 MiB cap |
| `k-passes-late.mjs` | no `node:test`; passes once the test writes `BC_HANG_RELEASE_K`, after its sample has seen h's orphan, so its report is written once that orphan exists (3 s without the variable, 20 s if never released) |
| `passes.mjs` | ends by itself after about a second |
| `l-prints-then-hangs.mjs` | no `node:test`; 400 KiB of output, then a hang, so an abort's write meets a full pipe. Once its write is out it writes `BC_HANG_STAMP_L` |

`close-the-terminal.py` and `read-slowly-on-a-terminal.py` are not fixtures: they run a command on a pseudo-terminal, the first closing it when it receives SIGUSR1, the second draining it slowly, for the test's terminal cases. `read-slowly-on-a-pipe.py` is the second's counterpart on a pipe.

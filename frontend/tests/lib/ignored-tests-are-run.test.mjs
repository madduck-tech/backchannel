// A test nothing runs is not a test.
//
// This repository has already been bitten twice. `gopnik.json`'s own note records the first:
// `cpal_capture_round_trip` "was written, ignored, and therefore did not catch #9". The
// second was #13, whose two new tests were written, marked `#[ignore]`, and selected by no
// gate command — found only when a critic compared the config against the source.
//
// `#[ignore]` is the right marker for a test that needs real hardware, so the answer is not
// to forbid it. The answer is that every ignored test must be either **named in a gate
// command** or **listed here with a reason**, and that the two lists must match exactly. A
// new ignored test then fails this check until somebody decides which it is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = path.join(root, '..');

// Ignored, and deliberately not run by any gate command. One line of reason each.
// Keyed by `<path>::<fn>`, not by the bare name: keying on the name alone let a new test that
// happened to share one silently inherit an existing excuse.
// An excuse is one of two kinds, and the difference matters: a blocker is a fact about the
// world with nothing to hold, while a substitution is a *claim that another test covers this
// one* — the exact shape of claim this file exists to stop going unchecked. A substitution
// must name its covering test, whose existence is then held below, so deleting that test
// makes the excuse leaning on it go stale.
const NOT_RUN_BY_THE_GATE = new Map([
  ['frontend/src-tauri/src/audio/capture/core_audio.rs::test_core_audio_capture',
   { blocker: 'macOS-only (ScreenCaptureKit); no macOS machine is reachable — ADR 0005' }],
  ['frontend/src-tauri/src/audio/system_detector.rs::test_system_audio_detector',
   { coveredBy: 'system_audio_monitor_round_trip',
     why: 'probes the host audio stack for its own sake; what the application does with it is asserted there' }],
  ['frontend/src-tauri/src/audio/import.rs::test_import_pipeline_decode_vad',
   { coveredBy: 'test_chunked_resample_matches_single_pass',
     why: 'needs a media file and a loaded model, minutes per run; the decode arithmetic is asserted there' }],
]);

function rustSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.name === 'target' || e.name === 'node_modules') return [];
    if (e.isDirectory()) return rustSources(full);
    return e.name.endsWith('.rs') ? [full] : [];
  });
}

// `#[ignore]` and `#[ignore = "reason"]` are the same attribute, and Rust documents the
// second — which is where an author told "an ignored test carries a reason" will naturally
// put it. An earlier version of this check matched only the bare form and was defeated by
// the documented one in a single line. Not anchored to the line start either, so
// `#[test] #[ignore]` on one line is seen.
const IGNORE_ATTR = /#\[\s*ignore\s*(?:=\s*"[^"]*"\s*)?\]/;  // bare and `= "reason"` forms alike

// Keyed on file + name: two tests may share a bare name in different modules, and keying on
// the name alone let a new one silently inherit an existing excuse.
const ignored = new Map();
// Every crate `cargo test --workspace` builds, read from the workspace manifest rather than
// listed here: a hardcoded list is how the llama-helper crate went unscanned in the first
// place, and it fails open — a renamed crate simply disappears. A member whose src/ is
// missing is a failure, not a skip, because it means this list is stale.
const workspaceMembers = [
  ...fs.readFileSync(path.join(repo, 'Cargo.toml'), 'utf8')
    .match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/)[1]
    .matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
assert.ok(workspaceMembers.length > 0, 'no workspace members parsed from Cargo.toml');
// `src/` and `tests/`. The second was missing (#53) and the gap is exactly where a
// parameterised contract suite would live: Rust's conventional home for integration tests is
// `<member>/tests/`, and an `#[ignore]` there was held by nothing — not required to be named
// in gopnik.json, not required to carry an excuse, not reported as unaccounted. This check
// exists because `cpal_capture_round_trip` "was written, ignored, and therefore did not catch
// #9"; moving that test into a directory the check cannot see would have undone it silently.
//
// `src/` missing is a failure (it means this list is stale); `tests/` missing is normal — no
// member has one today, and demanding it would fail on every crate in the workspace.
const memberDirs = (member) =>
  [
    { dir: path.join(repo, member, 'src'), required: true },
    { dir: path.join(repo, member, 'tests'), required: false },
  ].filter(({ dir, required }) => {
    const there = fs.existsSync(dir);
    assert.ok(there || !required, `workspace member ${member} has no src/ — this scan is stale`);
    return there;
  });

for (const member of workspaceMembers) {
  for (const file of memberDirs(member).flatMap(({ dir }) => rustSources(dir))) {
    // Comments and string literals are blanked first. Without that, a comment mentioning
    // `#[ignore]` produces a phantom entry named after the next `fn` in the file, and the
    // cheapest way to green that is to paste a fictional name into the excuse map -- the
    // same forge-the-record pressure this file exists to remove.
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*/g, '').replace(/"(?:[^"\\\\]|\\\\.)*"/g, '""'));
    lines.forEach((line, i) => {
      if (!IGNORE_ATTR.test(line)) return;
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        const m = lines[j].match(/\bfn\s+([A-Za-z0-9_]+)/);
        if (m) { ignored.set(`${path.relative(repo, file)}::${m[1]}`, m[1]); return; }
      }
      assert.fail(`an #[ignore] at ${path.relative(repo, file)}:${i + 1} is not followed by a fn within five lines`);
    });
  }
}

assert.ok(ignored.size > 0, 'no #[ignore]d tests found — the parse target moved');

const stage1 = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification.stage1;
// `cargo test <filter>` matches by substring, so a gate line may name a prefix rather than
// the whole function. Take the filter — the last token before the `--` separator — and ask
// whether it selects each test the way cargo would, instead of demanding an exact name.
// This emulates `cargo test <filter>`, which matches by substring, rather than asking cargo.
// The emulation cannot model `--exact` or `--skip`, and a line carrying either would be
// certified as covering a test it does not run — so such a line is rejected outright rather
// than trusted. `cargo test … -- --ignored --list` is the ground truth if this ever needs to
// be exact.
const selected = new Set();
// The walk is deliberately in both directions. Ignored -> stage 1 catches a test nothing
// runs. Stage 1 -> ignored catches the opposite and quieter failure: a gate line whose
// filter selects *nothing* — a renamed test, a typo, or an `#[ignore]` removed while the
// line stayed. `cargo test <filter> -- --ignored` exits 0 having run zero tests, so such a
// line is green forever and certifies a test that is not being run. Found by review, not by
// a failure: before this loop existed, only the first direction was checked.
const selectsNothing = [];
for (const cmd of stage1) {
  if (!cmd.includes('--ignored')) continue;
  assert.ok(
    !/--exact\b/.test(cmd) && !/--skip\b/.test(cmd),
    `this stage1 line uses --exact or --skip, which this check cannot model and which can ` +
      `silently select nothing:\n    ${cmd}\n  Use a plain substring filter, or replace this ` +
      `emulation with \`cargo test … -- --ignored --list\`.`
  );
  const before = cmd.split(' -- ')[0].trim().split(/\s+/);
  const filter = before[before.length - 1];
  if (!filter || filter.startsWith('-')) continue;
  let hit = 0;
  for (const [key, name] of ignored) {
    if (name.includes(filter)) {
      selected.add(key);
      hit += 1;
    }
  }
  if (hit === 0) selectsNothing.push({ cmd, filter });
}

assert.deepEqual(
  selectsNothing.map((s) => s.filter),
  [],
  'these gopnik.json stage1 lines pass `--ignored` a filter that matches no #[ignore]d test, ' +
    'so cargo runs zero tests and the line is green forever:\n  ' +
    selectsNothing.map((s) => `${s.filter}  <-  ${s.cmd}`).join('\n  ') +
    '\n\n  Either the test was renamed, or its #[ignore] was removed and the gate line should go.'
);

const nameOf = (key) => ignored.get(key);
const unaccounted = [...ignored.keys()].filter((k) => !selected.has(k) && !NOT_RUN_BY_THE_GATE.has(k));
assert.deepEqual(
  unaccounted,
  [],
  'these #[ignore]d tests are run by nothing and excused by nothing:\n  ' +
    unaccounted.join('\n  ') +
    '\n\n  Add a `cargo test … <name> -- --ignored` line to gopnik.json stage1, or list it in ' +
    'NOT_RUN_BY_THE_GATE with a reason. A test nothing runs is not a test.'
);

const staleExcuses = [...NOT_RUN_BY_THE_GATE.keys()].filter((k) => !ignored.has(k));
assert.deepEqual(
  staleExcuses,
  [],
  `excused but no longer an ignored test: ${staleExcuses.join(', ')} — remove the excuse`
);

// Every substitution's covering test must exist somewhere in the workspace.
const allRustFns = new Set();
for (const member of workspaceMembers) {
  const dir = path.join(repo, member, 'src');
  for (const f of rustSources(dir)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bfn\s+([A-Za-z0-9_]+)/g)) allRustFns.add(m[1]);
  }
}
for (const [key, excuse] of NOT_RUN_BY_THE_GATE) {
  assert.ok(
    excuse.blocker || excuse.coveredBy,
    `the excuse for ${key} is neither a blocker nor a substitution; say which it is`
  );
  if (excuse.coveredBy) {
    assert.ok(
      allRustFns.has(excuse.coveredBy),
      `${key} is excused because ${excuse.coveredBy} covers it, and no such test exists any more`
    );
  }
}

const excusedButRun = [...NOT_RUN_BY_THE_GATE.keys()].filter((k) => selected.has(k));
assert.deepEqual(
  excusedButRun,
  [],
  `both excused and selected by the gate: ${excusedButRun.join(', ')} — pick one`
);

// --- the same principle, on this side of the boundary ------------------------------------
// `pnpm test` is `node --test 'tests/**/*.test.mjs'`. A file under tests/ that asserts but is
// not named `*.test.mjs` is never run, and looks exactly like a test in review. Shared
// helpers are the legitimate exception, and they are named here rather than guessed at.
// Paths, not basenames: a basename match exempts any file anywhere under tests/ with that
// name. Symlinked directories are deliberately not followed — cycle risk for a case nobody
// has hit — so a test hidden behind one would be missed; recorded rather than closed.
const HELPERS = new Set([
  'lib/reachability-shared.mjs',
  'lib/render-tsx.mjs',
  'lib/dom-harness.mjs',
  'lib/tauri-stubs.mjs',
  // The workflow reader `lint-step-is-enforced.test.mjs` uses. A helper, and unusually a
  // helper with its own test file (`workflow-yaml.test.mjs`) — because it is hand-rolled
  // rather than a dependency, and a hand-rolled parser nobody tests is worse than the
  // substring matching it replaces.
  'lib/workflow-yaml.mjs',
  // The control runner (#94). Like `workflow-yaml.mjs` above it is a helper with its own test file
  // (`controls-are-real.test.mjs`) — and for a sharper reason: it is the thing that runs controls,
  // so a control on it is not ceremony, it is the only reason to believe it. Its fixture set is
  // two-sided on purpose: an oracle made only of broken controls it must catch is satisfied by
  // `exit 1`, which is the same shape as the defect the runner exists to close.
  'lib/control-runner.mjs',
]);

function testDirFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return testDirFiles(full);
    return /\.(?:[cm]?[jt]sx?)$/.test(e.name) ? [full] : [];
  });
}

const testScript = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;
assert.match(
  testScript,
  /tests\/\*\*\/\*\.test\.mjs/,
  `the test script no longer globs tests/**/*.test.mjs (${testScript}); this check's assumption moved`
);

const unrunnable = testDirFiles(path.join(root, 'tests'))
  .map((f) => path.relative(path.join(root, 'tests'), f))
  .filter((f) => !f.endsWith('.test.mjs'))
  .filter((f) => !HELPERS.has(f.replace(/\\/g, '/')));

assert.deepEqual(
  unrunnable,
  [],
  'these files sit under tests/ and are run by nothing, because the runner globs ' +
    `'${testScript.match(/'([^']+)'/)?.[1] ?? testScript}':\n  ` + unrunnable.join('\n  ') +
    '\n\n  Rename to *.test.mjs, or add it to HELPERS if it is a shared helper.'
);

// --- the numbers in the prose, held here so they cannot drift -----------------------------
// Two numbers drifted inside a single review round, both in documents about not letting
// numbers drift. A count lives in one place and is held; the other documents link to it.
const workflowDoc = fs.readFileSync(path.join(repo, 'docs/development-workflow.md'), 'utf8');
for (const [, named] of workflowDoc.matchAll(/`([a-z-]+\.test\.mjs)`/g)) {
  assert.ok(
    fs.existsSync(path.join(root, 'tests', 'lib', named)),
    `docs/development-workflow.md names ${named} and no such test exists`
  );
}
const testFileCount = testDirFiles(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).length;
assert.ok(
  workflowDoc.includes(`which has ${testFileCount} test files`),
  `docs/development-workflow.md's file count has drifted: the suite has ${testFileCount} *.test.mjs files`
);

console.log(
  `ok - ${ignored.size} ignored Rust tests: ${selected.size} run by the gate, ` +
    `${NOT_RUN_BY_THE_GATE.size} excused; ${testFileCount} JS test files, none unrunnable, ` +
    `and the workflow doc's names and count match`
);

// Commands registered in Rust and never invoked from the frontend, and the reverse.
//
// 37 of 161 registered commands are invoked from nowhere. Most were never wired at any
// point in this repository's history -- an entire notification subsystem among them -- so
// the allowlist below is a deletion backlog, not a set of decisions. It is written down so
// that an unreferenced command is a decision instead of a silence (#17).
//
// Set equality, not containment. Containment cannot fail on today's evidence: all 37 go on
// the list and the check is green the day it lands. With equality, wiring an allowlisted
// command up, deleting one, or adding a new unwired one all force an edit here.
//
// The reverse direction needs no allowlist and is the cheaper half: an invoke naming a
// command that does not exist rejects at runtime. It found `builtin_ai_get_models_directory`
// (src/lib/builtin-ai.ts:96), which exists nowhere in the repository -- dead code with a
// broken call inside it, invisible to every Rust-to-frontend check.
import assert from 'node:assert/strict';
import {
  registeredCommandNames,
  invokedCommandNames,
  invokeSites,
  assertSetEquals,
  commandsAbsentFromShippedBuilds,
} from './reachability-shared.mjs';
import {
  absentFromEveryShippedBuild,
  handlerEntries,
  innerCfgs,
  moduleDeclarations,
} from './cfg-gates.mjs';

// Registered but never invoked. One line each; the reason is the point of the list.
const NEVER_INVOKED = new Set([
  // NOT permanent — pending a measurement (#87). `#[cfg(debug_assertions)]`, invoked from the
  // devtools console by hand, so no frontend source can ever reference it and this check cannot
  // see it any other way.
  //
  // The previous comment here said "this entry can never leave the list" and cited the probe's
  // own header as saying so. That header says the opposite: the probe "exists to produce the one
  // number nobody in this repo has, and then to be deleted or kept as an instrument", with an
  // exit criterion written before the body. That number has still not been taken -- it is not in
  // `docs/milestones/`, which measures the decode half, not capture start -- so this entry
  // records an open question, not a settled exception. It leaves the list when #87 closes.
  'dictation_probe',

  // NOT permanent — #145. Its only caller was `deleteOllamaModel` in `ModelSettingsModal.tsx`: a
  // complete function that invoked this command, showed a toast and refreshed the list, and that no
  // UI element ever called. #38 turned `no-unused-vars` back on, the function was reported as never
  // used and removed with the rest of the sweep, and this command lost its last consumer.
  //
  // Nothing a person could observe changed: the path was already unreachable from the interface.
  // #145 decides whether the feature gets a button or the command is deleted; this entry leaves the
  // list either way.
  'delete_ollama_model',
]);

const registered = registeredCommandNames();
const invoked = invokedCommandNames();

assert.ok(registered.size > 100, `only ${registered.size} commands parsed out of generate_handler!`);
assert.ok(invoked.size > 100, `only ${invoked.size} invoke literals found`);

// --- Rust -> frontend -------------------------------------------------------------------
assertSetEquals(
  new Set([...registered].filter((n) => !invoked.has(n))),
  NEVER_INVOKED,
  'registered commands never invoked from the frontend',
  'Wired one up? Remove it here. Added one nothing calls? Add it with a reason, or wire it. ' +
    'Deleted one? Remove it here too.'
);

// --- frontend -> Rust -------------------------------------------------------------------
// No allowlist on purpose: an invoke naming a command that is not registered is always a
// defect. A command registered only under a #[cfg(target_os = ...)] counts as registered
// here -- a source-text check cannot tell which target a build is for, so a call guarded by
// a runtime platform check is out of this test's reach.
const sites = invokeSites();
const unregistered = [...invoked].filter((n) => !registered.has(n)).sort();
assert.deepEqual(
  unregistered,
  [],
  'these commands are invoked but registered nowhere; each rejects at runtime:\n  ' +
    unregistered.map((n) => `${n}  (${(sites.get(n) ?? []).join(', ')})`).join('\n  ')
);

// --- what a shipped build leaves out (#167) --------------------------------------------------
// The two checks above count a command gated on `debug_assertions` as registered, and a person never
// runs a debug build. `bfa8d3a` inserted the first-run audio check between an existing
// `#[cfg(debug_assertions)]` and the item it gated, in `audio/mod.rs` and in `generate_handler!`, so
// every release build answered `Command check_capture_device not found` while this file was green.
//
// Set equality, so a stray gate on a product command and a lost gate on the probe are both red. An
// intersection with the invoked set could not see the second.
const ABSENT_FROM_SHIPPED_BUILDS = new Set([
  // A measurement whose own header says it cannot ship (#87). It is gated in both places, the
  // module and the handler entry; removing one gate alone is not held here, see #167.
  'dictation_probe',
]);
assertSetEquals(
  commandsAbsentFromShippedBuilds(),
  ABSENT_FROM_SHIPPED_BUILDS,
  'commands no shipped build registers',
  'A product command here answers "not found" in every release. An attribute applies to the item ' +
    'after it: check which line it is on. A measurement missing here now ships.'
);

// The evaluator's own input domain. Atoms other than `debug_assertions` and `test` are free, so each
// row is "is this gate false in every artifact a person could run".
const MUST_COUNT = [
  'debug_assertions',
  'test',
  'all(debug_assertions, target_os = "linux")',
  'any(debug_assertions, test)',
  'all(debug_assertions, not(test))',
  'false',
  'all(false, unix)',
  'not(true)',
  'doc',
];
const MUST_NOT_COUNT = [
  'not(debug_assertions)',
  'any(debug_assertions, target_os = "linux")',
  'all(target_os = "linux", not(debug_assertions))',
  'not(test)',
  'target_os = "macos"',
  'unix',
  'feature = "metal"',
  'true',
  'any(false, unix)',
];
for (const p of MUST_COUNT) {
  assert.equal(absentFromEveryShippedBuild([p]), true, `cfg(${p}) is false in every shipped build`);
}
for (const p of MUST_NOT_COUNT) {
  assert.equal(absentFromEveryShippedBuild([p]), false, `cfg(${p}) ships somewhere`);
}
// Gates on one path are a conjunction: a module on Linux and a handler under `test` ship nowhere.
assert.equal(absentFromEveryShippedBuild(['target_os = "linux"', 'test']), true, 'a conjunction is evaluated whole');
assert.throws(() => absentFromEveryShippedBuild(['debug_assertions,']), /cfg:/, 'a gate it cannot read must throw');

// The readers that place the gates. Each fixture is the shape the tree uses, or the one #167 had.
assert.deepEqual(
  innerCfgs('//! A module.\n#![cfg(test)]\n#![allow(dead_code)]\nuse x;\n'),
  ['test'],
  'an inner #![cfg] at the top of a module file gates the whole module'
);
assert.deepEqual(innerCfgs('#![cfg(target_os = "macos")]\nfn f() {}\n'), ['target_os = "macos"']);
assert.equal(absentFromEveryShippedBuild(innerCfgs('#![cfg(test)]\nuse x;\n')), true, 'a test-only module ships nowhere');
assert.equal(absentFromEveryShippedBuild(innerCfgs('#![cfg(target_os = "macos")]\n')), false, 'a macOS module ships on macOS');
assert.deepEqual(innerCfgs('use x;\n#![cfg(test)]\n'), [], 'an inner attribute counts only before the first item');
const decls = moduleDeclarations(
  '// Capture-start measurement. Debug builds only.\n#[cfg(debug_assertions)]\npub mod device_check;\n' +
    'pub mod dictation_probe;\n' +
    '#[cfg(not(any(\n    target_os = "windows",\n    target_os = "macos"\n)))]\nmod linux_only;\n' +
    'let s = "#[cfg(test)]"; mod after_string;\n'
);
assert.deepEqual(decls.get('device_check'), ['debug_assertions'], 'the gate applies to the item after it');
assert.deepEqual(decls.get('dictation_probe'), [], '#167: the module after a gated one is not gated');
assert.deepEqual(
  decls.get('linux_only').map((p) => p.replace(/\s+/g, ' ')),
  ['not(any( target_os = "windows", target_os = "macos" ))'],
  'an attribute over several lines is read whole (the sidecar.rs:141 shape)'
);
assert.equal(decls.has('after_string'), false, 'a `#[` inside a line of code opens no attribute');
// Comments between a gate and its item. Each shape keeps the gate, and each was shown to be dropped
// by a reader that treated it as an item (found by the gate's adversary on #167).
const commented = moduleDeclarations(
  '#[cfg(debug_assertions)]\n// a line comment\npub mod a;\n' +
    '#[cfg(debug_assertions)]\n/// a doc line\npub(crate) mod b;\n' +
    '#[cfg(debug_assertions)]\n/** a block doc\n    comment */\npub mod c;\n' +
    '#[cfg(debug_assertions)] pub mod d;\n'
);
for (const m of ['a', 'b', 'c', 'd']) {
  assert.deepEqual(commented.get(m), ['debug_assertions'], `a comment between the gate and \`mod ${m}\` keeps the gate`);
}
// `cfg_attr` applies its `cfg` only when its condition holds, and a nested block comment is one comment.
const more = moduleDeclarations(
  '#[cfg_attr(not(debug_assertions), cfg(false))]\npub mod e;\n' +
    '#[cfg_attr(feature = "metal", cfg(false))]\npub mod g;\n' +
    '#[cfg_attr(test, allow(dead_code))]\npub mod h;\n' +
    '#[cfg(debug_assertions)]\n/* a /* nested */ comment */\npub mod f;\n'
);
assert.equal(absentFromEveryShippedBuild(more.get('e')), true, 'cfg_attr(not(debug_assertions), cfg(false)) is out of every release');
assert.equal(absentFromEveryShippedBuild(more.get('g')), false, 'cfg_attr(feature = "metal", cfg(false)) ships without the feature');
assert.deepEqual(more.get('h'), [], 'a cfg_attr that applies no cfg gates nothing');
assert.deepEqual(more.get('f'), ['debug_assertions'], 'a nested block comment keeps the gate above it');
assert.deepEqual(
  handlerEntries('\n  #[cfg(debug_assertions)]\n  // why it is gated\n  a::one,\n'),
  [{ path: 'a::one', cfgs: ['debug_assertions'] }],
  'and a comment between a gate and its handler entry keeps it too'
);
assert.deepEqual(
  handlerEntries(
    '\n  a::one,\n  // a comment, with a comma\n  #[cfg(any(target_os = "macos", windows))]\n  b::two,\n' +
      '  #[cfg(debug_assertions)]\n  c::three,\n  d::four,\n'
  ),
  [
    { path: 'a::one', cfgs: [] },
    { path: 'b::two', cfgs: ['any(target_os = "macos", windows)'] },
    { path: 'c::three', cfgs: ['debug_assertions'] },
    { path: 'd::four', cfgs: [] },
  ],
  'a handler entry carries exactly the gates above it, and a comma inside a gate splits nothing'
);

console.log(
  `ok - ${registered.size} commands registered, ${invoked.size} invoked; ` +
    `${NEVER_INVOKED.size} allowlisted as never invoked, 0 invoked-but-unregistered; ` +
    `absent from every shipped build: ${[...ABSENT_FROM_SHIPPED_BUILDS].join(', ')}, by an evaluator ` +
    `held to ${MUST_COUNT.length + MUST_NOT_COUNT.length + 1} predicate fixtures`
);

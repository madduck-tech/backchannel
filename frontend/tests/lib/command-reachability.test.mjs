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
} from './reachability-shared.mjs';

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

console.log(
  `ok - ${registered.size} commands registered, ${invoked.size} invoked; ` +
    `${NEVER_INVOKED.size} allowlisted as never invoked, 0 invoked-but-unregistered`
);

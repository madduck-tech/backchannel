// A click the driver refused must not report success — in every pass, not in one of them.
//
// `.claude/rules/testing.md`: *"A call that returns success is not evidence it did anything."* This is
// that rule one level down -- `stage2-record-check.sh`'s `click_labelled` discarded the click's exit
// status entirely (`>/dev/null 2>&1`) and then printed `clicked '<label>'`, so a refused click and a
// delivered one were the same event to every caller. Measured on 2026-09-08 (#130).
//
// **This executes the function, it does not read it.** The repository's other script checks assert
// over source text, which is right where the script cannot be run. This one can be: the function is
// extracted, given a fake driver, and called. A regex saying `if !` appears somewhere would pass
// against a script that still swallowed the status.
//
// ## What this file got wrong, and #160 measured
//
// It fixed one function in one script and its denominator stayed at one script. The four passes that
// drive WebDriver each carried
//
//     click() { curl -s -m 20 -X POST "$BASE/element/$1/click" ... >/dev/null; }
//
// -- the identical defect, in the identical shape, on the same day, untouched. Two days later
// `stage2-two-channel-check.sh` failed both modes with
//
//     stage2-two-channel: recording
//     stage2-two-channel: the app opened microphone: '<none>'
//     stage2-two-channel: the application never created a microphone stream
//
// because the Element Click on the settings screen's Back control and the one on `Start recording`
// after it had both answered `{"value":{"error":"element not interactable"}}`, and nothing looked. A
// day went into hunting an application defect that did not exist.
//
// So this file now holds a **census**: every Stage 2 pass that clicks anything clicks through a
// helper exercised below. Two examples are two examples; the census is what makes them a denominator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SCRIPTS = path.join(repo, 'scripts');
const script = fs.readFileSync(path.join(SCRIPTS, 'stage2-record-check.sh'), 'utf8');

/** Lift one shell function out by brace depth. Loud if the anchor moved. */
function shellFunction(src, name, where) {
  const start = src.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name}() is no longer in ${where} under that name`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${name}() has no closing brace`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-click-'));
fs.writeFileSync(path.join(tmp, 'pid'), '1\n');

// =================================================================================================
// The accessibility-tree click (`stage2-record-check.sh`)
// =================================================================================================

/**
 * Run `click_labelled` against a fake driver.
 * `clickExit` is what the driver returns for `computer click`; `label` is what its tree offers.
 */
function clickLabelled({ want, clickExit = 0, label = 'Start recording', timeout = 2 }) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'orca-ide'),
    `#!/usr/bin/env bash\n` +
      `case "$2" in\n` +
      `  get-app-state) printf '{"result":{"snapshot":{"treeText":"    7 push button ${label}\\\\n"}}}\\n' ;;\n` +
      `  click) exit ${clickExit} ;;\n` +
      `esac\n`,
    { mode: 0o755 }
  );
  const harness =
    `set -uo pipefail\n` +
    `PIDFILE="${path.join(tmp, 'pid')}"\n` +
    `say() { printf 'say: %s\\n' "$*"; }\n` +
    `die() { printf 'die: %s\\n' "$*" >&2; exit 1; }\n` +
    `${shellFunction(script, 'tree', 'stage2-record-check.sh')}\n` +
    `${shellFunction(script, 'click_labelled', 'stage2-record-check.sh')}\n` +
    `click_labelled ${JSON.stringify(want)} ${timeout}; echo "STATUS=$?"\n`;
  const out = execFileSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { status: Number(/STATUS=(\d+)/.exec(out)[1]), out };
}

// --- a delivered click succeeds -------------------------------------------------------------------
{
  const { status } = clickLabelled({ want: 'Start recording', clickExit: 0 });
  assert.equal(status, 0, 'a label that is present and a click that lands must succeed');
}

// --- a refused click is a failure -----------------------------------------------------------------
{
  const { status, out } = clickLabelled({ want: 'Start recording', clickExit: 1 });
  assert.notEqual(
    status, 0,
    'the driver refused the click and click_labelled reported success. Output was:\n' + out
  );
  assert.doesNotMatch(
    out, /^say: clicked/m,
    'it printed "clicked" for a click that never landed'
  );
}

// --- a label that is not there is a failure, and a distinguishable one -----------------------------
{
  const { status } = clickLabelled({ want: 'Get Started', label: 'Start recording' });
  assert.equal(status, 1, 'a missing label must be its own status, not the same one as a refused click');
}

// =================================================================================================
// The WebDriver click (`scripts/lib/webdriver.sh`, sourced by the four passes that drive a browser)
// =================================================================================================

const HELPER = path.join(SCRIPTS, 'lib', 'webdriver.sh');
assert.ok(fs.existsSync(HELPER), 'scripts/lib/webdriver.sh does not exist');

const OK = '{"value":null}';
const NOT_INTERACTABLE = '{"value":{"error":"element not interactable","message":"","stacktrace":""}}';
const INTERCEPTED = '{"value":{"error":"element click intercepted","message":"","stacktrace":""}}';
const NO_SUCH_ELEMENT = '{"value":{"error":"no such element","message":"","stacktrace":""}}';

/**
 * A driver that answers Element Click with these bodies in order, the last one repeating.
 * `/execute/sync` is the helper asking the page *why* it refused, and is counted separately: a click
 * and a question are not the same request, and conflating them would make the attempt counts below
 * measure the wrong thing.
 */
const WHY = 'The page says: the control is disabled.';
function stubDriver(bodies) {
  let n = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/execute/sync')) return res.end(JSON.stringify({ value: WHY }));
    res.end(bodies[Math.min(n++, bodies.length - 1)]);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, attempts: () => n })
    );
  });
}

/** Source the helper and press one element, with a caller's `die`, exactly as a pass does. */
function press(port, budget) {
  const harness =
    `set -uo pipefail\n` +
    `die() { printf 'die: %s\\n' "$*" >&2; exit 1; }\n` +
    `BASE="http://127.0.0.1:${port}/session/stub"\n` +
    `WD_CLICK_BUDGET=${budget}\n` +
    `. ${JSON.stringify(HELPER)}\n` +
    `click abcdef "the Back control"\n` +
    `echo CLICK-RETURNED\n`;
  const started = Date.now();
  return new Promise((resolve) => {
    execFile('bash', ['-c', harness], { timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr, ms: Date.now() - started });
    });
  });
}

async function against(bodies, budget, check) {
  const d = await stubDriver(bodies);
  try {
    await check(await press(d.port, budget), d);
  } finally {
    d.server.close();
  }
}

// --- a click the driver performed returns, silently, once ------------------------------------------
await against([OK], 1, (r, d) => {
  assert.equal(r.status, 0, `a clean click failed:\n${r.stderr}`);
  assert.match(r.stdout, /CLICK-RETURNED/);
  assert.equal(d.attempts(), 1, `a clean click was sent ${d.attempts()} times`);
});

// --- a refusal that ends is waited out ---------------------------------------------------------
// This is the cell a naive "die on any error" gets wrong, and it is not rare: Radix takes
// `pointer-events` off `document.body` for the length of a Select's close animation, and every pass
// here clicks through one. Measured at the Back control on 2026-09-10, one second apart, with the
// element's rect, visibility and opacity unchanged: `pointer-events: none`, `elementFromPoint`
// returning `HTML`; then `pointer-events: auto`, `elementFromPoint` returning the icon in the button.
for (const transient of [NOT_INTERACTABLE, INTERCEPTED]) {
  await against([transient, transient, OK], 10, (r, d) => {
    assert.equal(r.status, 0, `the pass died on a refusal that ended:\n${r.stderr}`);
    assert.match(r.stdout, /CLICK-RETURNED/);
    assert.equal(d.attempts(), 3, `expected three attempts, the driver saw ${d.attempts()}`);
  });
}

// --- a refusal that does not end kills the pass, naming the error and the control -----------------
for (const forever of [NOT_INTERACTABLE, INTERCEPTED]) {
  await against([forever], 1, (r) => {
    assert.notEqual(r.status, 0, `the pass walked past a click that never landed:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /CLICK-RETURNED/);
    assert.match(r.stderr, /element (not interactable|click intercepted)/);
    assert.match(r.stderr, /the Back control/, 'the message does not say which control');
    // A control the application disabled answers with these same three words: `disabled:pointer-events-none`
    // is on every Button variant. Without the read-back the pass waits one out and then blames the
    // driver for the other -- the one thing the retry can hide.
    assert.match(r.stderr, /the control is disabled/, 'the message does not say what the page reported');
  });
}

// --- an error that is not a state dies at once, rather than being waited out -----------------------
// `no such element` does not improve. Retrying it would turn a real regression into a pause followed
// by the same wrong sentence, ten seconds later.
await against([NO_SUCH_ELEMENT], 20, (r, d) => {
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no such element/);
  assert.equal(d.attempts(), 1, `a missing element was retried ${d.attempts()} times`);
  assert.ok(r.ms < 10_000, `dying on 'no such element' took ${r.ms}ms; it was waited out`);
});

// --- an unreadable answer is a failure, not a success ----------------------------------------------
// curl returns the empty string on a timeout, and a proxy returns HTML. Neither is a click.
for (const junk of ['<html>502 Bad Gateway</html>', '']) {
  await against([junk], 1, (r) => {
    assert.notEqual(r.status, 0, `an unreadable driver answer was read as a click that landed`);
    assert.doesNotMatch(r.stdout, /CLICK-RETURNED/);
  });
}

// =================================================================================================
// The census: no pass owns a click this file has not exercised
// =================================================================================================

const passes = fs
  .readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('stage2-') && f.endsWith('.sh'))
  .map((f) => ({ name: f, src: fs.readFileSync(path.join(SCRIPTS, f), 'utf8') }));

assert.ok(passes.length >= 5, `only ${passes.length} stage2 passes found; this census has gone stale`);

// Three rules, and each one can fire. An earlier draft asked "of the passes that drive WebDriver,
// which fail to source the helper" -- and a pass left the set the moment it stopped clicking, so that
// question had no answer that was not already covered. A detector defined by the thing being removed
// measures its own removal.
const ELEMENT_CLICK = /\/element\/[^"'\s]*\/click/;
const SOURCES_HELPER = /lib\/webdriver\.sh/;

// 1. Nobody posts an Element Click of their own. This is the exact regression: four passes did, on
//    2026-09-10, and none of them could report a refusal.
const owning = [];
for (const { name, src } of passes) {
  const own = src
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => ELEMENT_CLICK.test(line) && /curl/.test(line))
    .map(([n]) => n);
  if (own.length) owning.push(`${name}:${own.join(',')}`);
}
assert.deepEqual(
  owning,
  [],
  `these passes post their own Element Click: ${owning.join('  ')}\n` +
    `Nothing in this file exercises those clicks, so nothing knows whether they report a refusal. ` +
    `Source scripts/lib/webdriver.sh instead.`
);

// 2. The helper is still what the passes use. Without this the check above is satisfied by a harness
//    that stopped driving a browser at all, which is how a census goes quietly to zero.
const sourcing = passes.filter((p) => SOURCES_HELPER.test(p.src)).map((p) => p.name);
assert.ok(
  sourcing.length >= 4,
  `only ${sourcing.length} passes source scripts/lib/webdriver.sh (${sourcing.join(', ') || 'none'}); ` +
    `four did on 2026-09-10, so either a pass was dropped or this census has gone stale`
);

// 3. Nobody redefines `click` after sourcing the helper. Rules 1 and 2 are both satisfied by a script
//    that sources `lib/webdriver.sh` and then declares its own `click() { ... }` over the top, and
//    ordering is the only thing that makes the current tree correct.
const shadowing = passes
  .filter((p) => /^\s*click\s*\(\)\s*\{/m.test(p.src))
  .map((p) => p.name);
assert.deepEqual(
  shadowing,
  [],
  `these passes define their own click(), shadowing the helper this file exercises: ${shadowing.join(', ')}`
);

// The accessibility-tree side of the same census: exactly one pass drives `orca-ide computer click`,
// and it is the one whose `click_labelled` is exercised above. A second would be a second unexamined
// click.
const atspi = passes.filter((p) => /orca-ide computer click/.test(p.src)).map((p) => p.name);
assert.deepEqual(
  atspi,
  ['stage2-record-check.sh'],
  `these passes click through the accessibility driver and this file exercises only ` +
    `stage2-record-check.sh's click_labelled: ${atspi.join(', ')}`
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  `ok - a refused click is a failure in the accessibility driver and in WebDriver, and ` +
    `${sourcing.length + 1} of ${passes.length} Stage 2 passes click through a helper this file runs`
);

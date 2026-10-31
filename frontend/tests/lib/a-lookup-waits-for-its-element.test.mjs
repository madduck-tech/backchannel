// A Stage 2 pass looks an element up only once the page holds it, or says why it need not (#296).
//
// Entry 13 looked for the system-audio picker once, the moment the Recordings tab read active. The
// picker renders only after `get_audio_devices` settles, so on one artifact the lookup lost 3 of 3
// times, and died with "no #system-selection trigger", which reads like the picker being gone. This
// holds every `find_el` and `by_text` call in every `scripts/stage2-*.sh` (the denominator
// `gate-click-failure-is-a-failure.test.mjs` uses) to one of three things:
//
//   (a) the last wait before it, with no click or keystroke between, tests that element by its own
//       selector or label, positively: no `=== null`, no leading `!`. `await_present '<selector>'` is
//       such a wait, and `lib/webdriver.sh` is read to hold that it is one;
//   (b) it is retried itself, in a bounded loop that sleeps and breaks on its own non-empty result;
//   (c) it is listed below, with its reason, keyed by file, call text and ordinal, not by line.
//
// A site neither held nor listed is red, and so is a listed site that now holds: a stale excuse.
// Where the picker is looked up at all is held too: three passes, and no other.
//
// What this reads is the source, not a run. Whether a listed element really renders with what its
// previous wait tested is the reason's claim, read from the frontend by the census on #296.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const passes = fs
  .readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('stage2-') && f.endsWith('.sh'))
  .sort()
  .map((f) => ({ name: f, lines: fs.readFileSync(path.join(SCRIPTS, f), 'utf8').split('\n') }));
assert.ok(passes.length >= 5, `only ${passes.length} stage2 passes found; this census has gone stale`);
// The passes' shared helpers make lookups too (`lib/audio-check.sh`'s press). `lib/webdriver.sh` only
// defines them, and its own lookups are diagnostics inside a `die` (held below).
const LIBS = fs
  .readdirSync(path.join(SCRIPTS, 'lib'))
  .filter((f) => f.endsWith('.sh') && f !== 'webdriver.sh')
  .sort()
  .map((f) => ({ name: `lib/${f}`, lines: fs.readFileSync(path.join(SCRIPTS, 'lib', f), 'utf8').split('\n') }));
const WEBDRIVER = fs.readFileSync(path.join(SCRIPTS, 'lib', 'webdriver.sh'), 'utf8');

// ---- `await_present` is a wait on the element, positively -----------------------------------------
const helper = /\nawait_present\(\) \{\n([\s\S]*?)\n\}\n/.exec(WEBDRIVER)?.[1] ?? '';
assert.ok(helper, 'lib/webdriver.sh defines no await_present');
assert.match(helper, /"return !!document\.querySelector\(" \+ json\.dumps\(sys\.argv\[1\]\) \+ "\)"/, "await_present does not poll `!!document.querySelector(<its selector>)`, so its call sites are not waits on their element");
assert.match(helper, /\[ "\$v" = "true" \] && break/, 'await_present does not stop on a true reading');

const comment = (l) => /^\s*#/.test(l);
const isClick = (l) => !comment(l) && /(^|[\s;(&|])(click|type_into|audio_check_press)\s/.test(l);
const unescape = (s) => s.replace(/\\(["\\])/g, '$1');

/** Every wait in a pass, with the line it ends on and its condition, as the page reads it. */
function waits(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (comment(l)) return;
    let m = /^\s*await\s+"((?:[^"\\]|\\.)*)"/.exec(l);
    if (m) return out.push({ end: i, cond: unescape(m[1]) });
    m = /^\s*await_present\s+'([^']+)'/.exec(l);
    if (m) return out.push({ end: i, cond: `!!document.querySelector('${m[1]}')` });
  });
  // A hand-rolled bounded poll: a loop that sleeps. Its condition is its whole body.
  for (let i = 0; i < lines.length; i++) {
    if (comment(lines[i]) || !/^\s*(for|while)\b.*\bdo\s*$/.test(lines[i])) continue;
    const indent = /^\s*/.exec(lines[i])[0];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^${indent}done\\b`).test(lines[j])) j++;
    const body = lines.slice(i, j + 1);
    if (body.some((b) => /\bsleep\b/.test(b))) out.push({ end: j, start: i, cond: unescape(body.join('\n')), loop: true });
  }
  return out.sort((a, b) => a.end - b.end);
}

/** What a call looks up, as something a condition can test for. */
function target(kind, arg) {
  if (kind === 'by_text') {
    const m = /^"([^"$]*)"$/.exec(arg);
    return m ? { label: m[1] } : {};
  }
  const s = unescape(arg.replace(/^'|'$/g, '').replace(/^"|"$/g, ''));
  let m = /"using":"css selector","value":"([^"]+)"/.exec(s);
  if (m) return { css: m[1] };
  m = /"using":"xpath","value":"\/\/\*\[@id=\\?"([^"\\]+)\\?"\]"/.exec(s);
  if (m) return { css: `#${m[1]}` };
  m = /"using":"xpath","value":"\/\/button\[@aria-label=\\?"([^"\\]+)\\?"\]"/.exec(s);
  if (m) return { aria: m[1] };
  return {};
}

/** Whether a wait's condition tests the target, positively. */
function tests(cond, t) {
  const c = cond.trim();
  if (/^!(?!!)/.test(c)) return false;
  const q = `['"]`;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A selector is tested only by a conjunct that says it is present, in one of two spellings and
  // nothing else: `… == null`, `… || true`, `(!…)` and `true && !…` all name the selector and test its
  // absence or nothing (#296's gate adversary, M2).
  if (t.css) {
    const present = new RegExp(`^(?:!!document\\.querySelector\\(${q}${esc(t.css)}${q}\\)|document\\.querySelector\\(${q}${esc(t.css)}${q}\\)\\s*!==\\s*null)$`);
    return c.split('&&').map((x) => x.trim()).some((x) => present.test(x));
  }
  if (t.aria) return new RegExp(`getAttribute\\(${q}aria-label${q}\\)\\s*===\\s*${q}${esc(t.aria)}${q}`).test(c);
  if (t.label) return new RegExp(`===\\s*${q}${esc(t.label)}${q}`).test(c);
  return false;
}

/** Every call site, by the census's rule: whole-word calls, no comment lines, no definitions. */
function sites(pass) {
  const out = [];
  const seen = new Map();
  pass.lines.forEach((l, i) => {
    if (comment(l) || /^\s*(find_el|by_text)\(\)\s*\{/.test(l)) return;
    for (const m of l.matchAll(/\b(find_el|by_text)\b\s*('[^']*'|"(?:[^"\\]|\\.)*"|\S+)?/g)) {
      const call = `${m[1]} ${m[2] ?? ''}`.trim();
      const ord = (seen.get(call) ?? 0) + 1;
      seen.set(call, ord);
      out.push({ file: pass.name, line: i, call, ord, kind: m[1], arg: m[2] ?? '' });
    }
  });
  return out;
}

/** (a) or (b), or why not. */
function held(pass, site, ws) {
  const t = target(site.kind, site.arg);
  // (b): the lookup sits in a bounded loop that sleeps and breaks on the lookup's own result.
  const assigned = new RegExp(`(\\w+)=\\$\\(${site.kind}\\b`).exec(pass.lines[site.line])?.[1];
  const loop = ws.find((w) => w.loop && w.start < site.line && site.line < w.end);
  if (loop && assigned && new RegExp(`\\[ -n "\\$${assigned}" \\] && break`).test(loop.cond) && /seq 1 ([2-9]|\d{2,})/.test(pass.lines[loop.start])) return 'b';
  // (a): the last wait that ends before the site, with no click or keystroke between them.
  const last = ws.filter((w) => w.end < site.line).pop();
  if (!last) return null;
  for (let k = last.end + 1; k < site.line; k++) if (isClick(pass.lines[k])) return null;
  return tests(last.cond, t) ? 'a' : null;
}

// ---- the listed sites: each with why it may be looked up without a wait on itself -----------------
// The census on #296, at c1232f8, read each from the frontend. "Same commit" means the element is drawn
// by the render the previous wait tested, and nothing removes it before the lookup.
const SAME = 'drawn in the same render as what its previous wait tested';
const LISTED = [
  ['stage2-ui-check.sh', 'by_text "Settings"', 1, `${SAME}: the app's first buttons, waited for as a button count`],
  ['stage2-ui-check.sh', 'by_text "Recordings"', 1, `${SAME}: the settings tabs, waited for as a tab count`],
  ['stage2-ui-check.sh', `find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role=\\\\\\"option\\\\\\"][normalize-space()=\\\\\\"$FIRST\\\\\\"]\\"}"`, 1, `${SAME}: the open dropdown's options, waited for as an option count`],
  ['stage2-ui-record-check.sh', 'by_text "Settings"', 1, `${SAME}: the app's first buttons`],
  ['stage2-ui-record-check.sh', 'by_text "Recordings"', 1, `${SAME}: the settings tabs`],
  ['stage2-ui-record-check.sh', `find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role=\\\\\\"option\\\\\\"][normalize-space()=\\\\\\"$PICK\\\\\\"]\\"}"`, 1, `${SAME}: the open dropdown's options`],
  ['stage2-ui-record-check.sh', `find_el '{"using":"xpath","value":"//button[@aria-label=\\"Back\\"]"}'`, 1, 'the settings header is drawn with the tabs, before the stored preference this waits on'],
  ['stage2-ui-record-check.sh', `find_el '{"using":"xpath","value":"//button[@aria-label=\\"Stop recording\\"]"}'`, 1, 'the recording controls are drawn once recording starts, waited for at Start; the transcript poll between never removes them'],
  ['stage2-two-channel-check.sh', 'by_text "Settings"', 1, `${SAME}: the app's first buttons`],
  ['stage2-two-channel-check.sh', 'by_text "Recordings"', 1, `${SAME}: the settings tabs`],
  ['stage2-two-channel-check.sh', `find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role=\\\\\\"option\\\\\\"][normalize-space()=\\\\\\"$PICK\\\\\\"]\\"}"`, 1, `${SAME}: the open dropdown's options`],
  ['stage2-two-channel-check.sh', `find_el '{"using":"xpath","value":"//button[@aria-label=\\"Back\\"]"}'`, 1, 'the settings header is drawn with the tabs, before the stored preference this waits on'],
];
// The two passes with a site list too long to key by hand get theirs from one table each, below.
for (const [file, rows] of Object.entries({
  'stage2-core-check.sh': [
    ['by_text "Browse every model"', 1, `${SAME}: first run's model step, waited for by its heading`],
    [`find_el '{"using":"css selector","value":"input[type=search]"}'`, 1, `${SAME}: the catalogue, waited for as a row count`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radiogroup'][@aria-label='Models']//*[@role='radio'][.//text()[.='$MODEL_ID']]\\"}"`, 1, 'held by a wait on the row by its id, in a form this rule does not parse'],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//label[.//text()[contains(.,\\\\\\"$MATCH\\\\\\")]]\\"}"`, 1, `${SAME}: the recommended rows, one of three one-shot fallbacks`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radio'][.//text()[contains(.,\\\\\\"$MATCH\\\\\\")]]\\"}"`, 1, `${SAME}: one of three one-shot fallbacks`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//button[.//text()[contains(.,\\\\\\"$MATCH\\\\\\")]]\\"}"`, 1, `${SAME}: one of three one-shot fallbacks`],
    ['by_text "Continue"', 1, `${SAME}: the step's footer, drawn with the row its previous wait checked`],
    ['by_text "Continue"', 2, `${SAME}: the summary step, waited for by its heading`],
    [`find_el '{"using":"xpath","value":"//button[@aria-label=\\"Microphone\\"]"}'`, 1, `${SAME}: the audio check step, waited for by its heading`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='option'][contains(normalize-space(),\\\\\\"$HARNESS_DESC\\\\\\")]\\"}"`, 1, `${SAME}: the open dropdown's options`],
    [`find_el '{"using":"xpath","value":"//button[@aria-label=\\"The other side is heard through\\"]"}'`, 1, 'the audio check step stays drawn through the microphone check its press waited on'],
    [`find_el '{"using":"xpath","value":"//*[@role=\\"option\\"][contains(normalize-space(),\\"Backchannel tone sink\\")]"}'`, 1, `${SAME}: the open dropdown's options`],
    ['by_text "Continue"', 4, 'one of three fallbacks; the step stays drawn through the check its press waited on'],
    ['by_text "Finish"', 1, 'one of three fallbacks, as Continue'],
    ['by_text "Done"', 1, 'one of three fallbacks, as Continue'],
    ['by_text "Generate Summary"', 1, 'held as a pair by a wait whose regex names both spellings, which this rule does not parse'],
    ['by_text "Generate summary"', 1, 'held as a pair, as Generate Summary'],
  ],
  'lib/audio-check.sh': [
    [String.raw`find_el "{\"using\":\"xpath\",\"value\":\"//button[normalize-space()=\\\"$action\\\"]\"}"`, 1, 'the line before reads the same row from the DOM (`audio_check_read`): found, enabled, and labelled with this action; a read of the render the press is looked up in, not a wait'],
  ],
  'stage2-onboarding-check.sh': [
    ['by_text "Browse every model"', 1, `${SAME}: first run's model step, drawn before the window resize its wait reads`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radiogroup'][@aria-label='Models']//*[@role='radio'][.//text()[.='whisper-tiny-q8']]\\"}"`, 1, `${SAME}: the catalogue, waited for by its search field`],
    ['by_text "Hide the catalogue"', 1, `${SAME}: the catalogue, waited for by a row's state`],
    ['by_text "Browse every model"', 2, `${SAME}: the model step, waited for by its rows`],
    [`find_el '{"using":"css selector","value":"input[type=search]"}'`, 1, `${SAME}: the catalogue, waited for as a row count`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"$ROW_XPATH\\"}"`, 1, 'held by a wait on the row by its id, in a form this rule does not parse'],
    ['by_text "Continue"', 1, `${SAME}: the step's footer, drawn with the row its previous wait checked`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//label[.//text()[contains(.,\\\\\\"$CHOSEN_ID\\\\\\")]]\\"}"`, 1, `${SAME}: the recommended rows`],
    ['by_text "Continue"', 2, `${SAME}: the step's footer`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radio'][starts-with(normalize-space(.),'An agent on this machine')]\\"}"`, 1, `${SAME}: the summary step, waited for by its heading`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radio'][.//text()[contains(.,'claude')]]\\"}"`, 1, `${SAME}: the agent rows, waited for by their data-agent attributes`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radio'][.//text()[contains(.,'claude')]]\\"}"`, 2, `${SAME}: the summary step`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='radio'][.//text()[contains(.,'builtin-ai')]]\\"}"`, 1, `${SAME}: the summary step`],
    ['by_text "Continue"', 3, `${SAME}: the step's footer`],
    [`find_el '{"using":"xpath","value":"//button[@aria-label=\\"Microphone\\"]"}'`, 1, `${SAME}: the audio check step, waited for by its heading`],
    [`find_el "{\\"using\\":\\"xpath\\",\\"value\\":\\"//*[@role='option'][contains(normalize-space(),\\\\\\"$HARNESS_DESC\\\\\\")]\\"}"`, 1, `${SAME}: the open dropdown's options`],
    ['by_text "Continue"', 5, 'one of three fallbacks; the step stays drawn through the check its press waited on'],
    ['by_text "Finish"', 1, 'one of three fallbacks, as Continue'],
    ['by_text "Done"', 1, 'one of three fallbacks, as Continue'],
    ['by_text "Continue"', 6, 'one of three fallbacks, as Continue'],
    ['by_text "Finish"', 2, 'one of three fallbacks, as Continue'],
    ['by_text "Done"', 2, 'one of three fallbacks, as Continue'],
  ],
})) {
  for (const [call, ord, why] of rows) LISTED.push([file, call, ord, why]);
}

const key = (file, call, ord) => `${file} :: ${call} #${ord}`;
const listed = new Map(LISTED.map(([file, call, ord, why]) => [key(file, call, ord), why]));
const fails = [];
const seenKeys = new Set();
const tally = { a: 0, b: 0, listed: 0 };
const heldAt = new Map();
for (const pass of [...passes, ...LIBS]) {
  const ws = waits(pass.lines);
  for (const site of sites(pass)) {
    const k = key(site.file, site.call, site.ord);
    seenKeys.add(k);
    const how = held(pass, site, ws);
    heldAt.set(k, how);
    if (how && listed.has(k)) fails.push(`${k} (line ${site.line + 1}) is listed, and now holds by (${how}): a stale excuse`);
    else if (how) tally[how]++;
    else if (listed.has(k)) tally.listed++;
    else fails.push(`${k} (line ${site.line + 1}) is neither held by a wait on its element, nor retried, nor listed`);
  }
}
for (const k of listed.keys()) if (!seenKeys.has(k)) fails.push(`${k} is listed, and no pass makes that call any more: a stale excuse`);

// ---- lookups that are not find_el or by_text ----------------------------------------------------
// A pass that asked Find Element by hand, or through `wd_raw_find`, would escape every rule above
// (#296's gate adversary, M1). `"$BASE/element"` may appear only in a `find_el` definition, and
// `wd_raw_find` only inside a `die` or `say` message, as a diagnostic.
for (const pass of [...passes, ...LIBS]) {
  pass.lines.forEach((l, i) => {
    if (comment(l)) return;
    if (/"\$BASE\/elements?"/.test(l) && !/^\s*find_el\(\)\s*\{/.test(l)) fails.push(`${pass.name}:${i + 1} asks Find Element by hand, outside find_el: ${l.trim().slice(0, 120)}`);
    if (/\bwd_raw_find\b/.test(l) && !/\b(die|say)\s+".*\$\(wd_raw_find\b/.test(l)) fails.push(`${pass.name}:${i + 1} uses wd_raw_find outside a die or say message: ${l.trim().slice(0, 120)}`);
  });
}

// ---- where the picker is looked up --------------------------------------------------------------
// And the two lookups #296 fixed are there, and held by a wait on the picker itself.
const PICK = `find_el '{"using":"css selector","value":"#system-selection"}'`;
for (const f of ['stage2-ui-check.sh', 'stage2-ui-record-check.sh']) {
  const how = heldAt.get(key(f, PICK, 1));
  if (how !== 'a') fails.push(`${f}'s lookup of the system-audio picker is ${how === undefined ? 'gone' : `held by (${how ?? 'nothing'})`}, not by a wait on the picker`);
}
const PICKER = /system-selection/;
const where = passes.filter((p) => p.lines.some((l) => !comment(l) && PICKER.test(l))).map((p) => p.name);
const expected = ['stage2-two-channel-check.sh', 'stage2-ui-check.sh', 'stage2-ui-record-check.sh'];
if (JSON.stringify(where) !== JSON.stringify(expected)) fails.push(`the system-audio picker is looked up in ${JSON.stringify(where)}, not exactly ${JSON.stringify(expected)}`);

assert.deepEqual(fails, [], 'a Stage 2 lookup does not wait for its element');
const total = tally.a + tally.b + tally.listed;
assert.ok(total >= 60, `only ${total} call sites found; the census has gone stale`);
console.log(`ok - ${total} find_el and by_text calls in ${passes.length} passes and ${LIBS.length} helpers: ${tally.a} held by a wait on their element, ${tally.b} retried, ${tally.listed} listed with their reason; the picker is looked up in ${expected.length} passes`);

// ---- the helpers, run against a driver stub ------------------------------------------------------
// The census above reads `await_present` by two substrings; this runs it. A stub answers Execute
// Script by mode and Find Element with an error, on a port of its own, and the helper runs under the
// passes' own `set -euo pipefail`. `refused` closes the port first: before #296's gate adversary that
// case ended the pass with exit 7 and no message at all, because a failed `curl` inside the
// substitution failed it under `pipefail`.
async function underStub(mode, body) {
  let polls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let script = '';
      try { script = JSON.parse(raw).script ?? ''; } catch { /* Find Element's body has no script */ }
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/element')) return res.end(JSON.stringify({ value: { error: 'no such element', message: 'stub' } }));
      if (script.includes('tabpanel')) return res.end(JSON.stringify({ value: 'the panel rendered without it' }));
      polls++;
      const value = { present: true, late: polls >= 3, absent: false, error: { error: 'invalid session id', message: 'stub' } }[mode];
      res.end(JSON.stringify({ value }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  if (mode === 'refused') await new Promise((r) => server.close(r));
  const script = `set -euo pipefail
die() { echo "DIE: $*"; exit 1; }
say() { echo "SAY: $*"; }
BASE=http://127.0.0.1:${port}/session/stub
. "$1"
${body}
echo RETURNED`;
  const child = spawn('bash', ['-c', script, 'stub', path.join(SCRIPTS, 'lib', 'webdriver.sh')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise((r) => child.on('close', (c, sig) => r(c ?? sig)));
  clearTimeout(timer);
  if (mode !== 'refused') server.close();
  return { code, out, polls };
}

const WAIT = "await_present '#system-selection' 'the picker' 2";
const helperFails = [];
const expect = (name, r, code, patterns, absent = []) => {
  if (r.code !== code) helperFails.push(`${name}: exit ${r.code}, not ${code}: ${JSON.stringify(r.out)}`);
  for (const p of patterns) if (!p.test(r.out)) helperFails.push(`${name}: no ${p} in ${JSON.stringify(r.out)}`);
  for (const p of absent) if (p.test(r.out)) helperFails.push(`${name}: ${p} in ${JSON.stringify(r.out)}`);
};
const DIED = /DIE: timed out after 2s waiting for the picker \(#system-selection\)\. The panel shows /;
let r = await underStub('present', WAIT);
expect('present at once', r, 0, [/SAY: the picker rendered after \d+ ms; at the first check it was present\n/, /RETURNED/]);
r = await underStub('late', WAIT);
expect('present at the third check', r, 0, [/at the first check it was absent \(false\)/, /RETURNED/]);
if (r.polls < 3) helperFails.push(`present at the third check: the stub was asked ${r.polls} times`);
r = await underStub('absent', WAIT);
expect('never present', r, 1, [DIED, /The panel shows the panel rendered without it; Find Element answers .*no such element/], [/RETURNED/, /rendered after/]);
r = await underStub('error', WAIT);
expect('a driver error', r, 1, [DIED], [/RETURNED/, /rendered after/]);
r = await underStub('refused', WAIT);
expect('a refused connection', r, 1, [DIED, /The panel shows \(the driver gave no answer\); Find Element answers \(no answer: curl exit 7\)/], [/RETURNED/]);
r = await underStub('refused', `PANEL=$(wd_panel_state '#system-selection'); echo "PANEL: $PANEL"`);
expect('wd_panel_state, refused', r, 0, [/PANEL: \(the driver gave no answer\)/, /RETURNED/]);
r = await underStub('refused', `RAW=$(wd_raw_find '#system-selection'); echo "RAW: $RAW"`);
expect('wd_raw_find, refused', r, 0, [/RAW: \(no answer: curl exit 7\)/, /RETURNED/]);
assert.deepEqual(helperFails, [], 'a WebDriver helper does not do what the passes rely on');
console.log('ok - await_present, wd_panel_state and wd_raw_find, run against a stub in 7 cases');

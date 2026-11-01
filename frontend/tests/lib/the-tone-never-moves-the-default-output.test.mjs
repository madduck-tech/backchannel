// The core pass never moves the person's default output, and its tone reaches its sink by name. (#266)
//
// Until #266 `stage2-core-check.sh` wrote `default.configured.audio.sink` to the tone sink for each press.
// WirePlumber's `follow` then moved every stream without a target of its own into that null sink: a
// Chrome tab's audio went silent for 8 s each press, measured, and the pass failed on it. Now the tone sink
// has a name of this run's own and the driver launches the application with `PULSE_SINK` naming it.
//
// Held by reading the pass itself:
// - **(a)** every line of `stage2-core-check.sh`, of `audio-harness.sh` (which it runs) and of every library
//   the pass sources is read, but for the legacy `tone_sink_put_back`, which nothing read may name, and a
//   library's direct-run block. Each line there that names `pw-metadata`, `pactl` or `wpctl` must be a
//   known read, by file and exact text;
// - **(a')** item 4's checks are at the pass's top level, in order before the press, with nothing between
//   them that could skip one, and the tone's judge requires the stamps the two route checks leave;
// - **(b)** the `tauri-driver` launch line carries `PULSE_SINK="$TONE_SINK_NAME"` and
//   `GST_PLUGIN_FEATURE_RANK="$TONE_GST_PIN"`, and `$TONE_GST_PIN` holds the four entries item 4 names;
// - **(c)** `tone-sink.sh` assigns `$TONE_SINK_NAME` once, as the family followed by a run id, and no file
//   under `scripts/` assigns it anywhere else, by `=`, `printf -v` or `read`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS = path.join(repo, 'scripts');
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
const lines = (rel) => fs.readFileSync(path.join(SCRIPTS, rel), 'utf8').split('\n').map((l, i) => ({ rel, n: i + 1, l, code: /^\s*#/.test(l) ? '' : l }));

// --- (a) -----------------------------------------------------------------------------------------------

const PASS = 'stage2-core-check.sh';
// The files the pass sources, by `.` or `source`, followed through each library's own. A line that sources
// something the census cannot resolve fails it: a file it does not read could hold anything.
const SOURCE_LINE = /^\s*(?:\.|source)\s+(.+?)\s*$/;
const resolve = (rel, arg) => {
  const m = /^"\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)\/([\w./-]+\.sh)"$/.exec(arg)
    || /^"\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)\/([\w./-]+\.sh)"$/.exec(arg)
    || /^"\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)\/([\w./-]+\.sh)"$/.exec(arg);
  return m ? path.posix.join(path.posix.dirname(rel), m[1]) : null;
};
const files = [PASS];
for (let i = 0; i < files.length; i++) {
  for (const { n, code } of lines(files[i])) {
    const m = SOURCE_LINE.exec(code);
    if (!m) continue;
    const target = resolve(files[i], m[1]);
    check('(a) every sourced file is resolved', target !== null, `${files[i]}:${n}: \`${code.trim()}\` sources something the census cannot read`);
    if (target && !files.includes(target)) files.push(target);
  }
}
check('(a) the files the pass sources', ['lib/tone-sink.sh', 'lib/harness-guard.sh', 'lib/audio-check.sh'].every((f) => files.includes(f)),
  `the census found ${JSON.stringify(files)}; it must at least reach lib/tone-sink.sh, lib/harness-guard.sh and lib/audio-check.sh`);

// Every line of the pass, of the harness it runs and of every library it sources is read, functions and
// all: the first two versions split the libraries into functions and followed calls, and a function closed
// late, or one named through a variable, hid what came after (#266's gate adversary, rounds 1 and 2). Two
// things are not read: `tone_sink_put_back`'s body, the legacy repair only `restore` runs, and a library's
// `if [ "${BASH_SOURCE[0]}" = "$0" ]; then` block, which runs only when the file is run directly. The
// put-back must stay unnamed by everything read, so it stays unreached.
const EXEMPT = { 'lib/tone-sink.sh': 'tone_sink_put_back' };
const queue = [];
const exempt = [];
for (const rel of [...files, 'audio-harness.sh']) {
  let inExempt = false; let guard = false;
  for (const line of lines(rel)) {
    if (EXEMPT[rel] && new RegExp(`^${EXEMPT[rel]}\\(\\)\\s*\\{`).test(line.code)) { inExempt = true; exempt.push(line); continue; }
    if (inExempt) {
      // A definition inside it means its end was not found, and whatever it swallowed went unread.
      const inner = /^\s*(function\s+[A-Za-z_]|[A-Za-z_][\w]*\(\)\s*\{)/.test(line.code);
      check('(a) the exempt function closes before the next definition', !inner, `${rel}:${line.n}: a definition inside ${EXEMPT[rel]}(), so its end was not found`);
      if (inner) { inExempt = false; queue.push(line); continue; }
      exempt.push(line); if (/^\s*\}\s*$/.test(line.code) || /;\s*\}\s*$/.test(line.code)) inExempt = false; continue;
    }
    if (rel !== PASS && rel !== 'audio-harness.sh' && /^if \[ "\$\{BASH_SOURCE\[0\]\}" = "\$0" \]; then\s*$/.test(line.code)) { guard = true; continue; }
    if (guard) { if (/^fi\s*$/.test(line.code)) guard = false; continue; }
    queue.push(line);
  }
  check('(a) the exempt function and the direct-run block close', !inExempt && !guard, `${rel}: ${inExempt ? EXEMPT[rel] + '()' : 'the direct-run block'} is still open at the end of the file`);
}
const passLines = lines(PASS).slice(0, -1);
const lastCode = [...passLines].reverse().find(({ code }) => code.trim());
check('(a) the census reads the pass to its last line', queue.some((l) => l.rel === PASS && l.n === lastCode.n), `line ${lastCode?.n} of ${PASS} is not among the lines read`);
check('(a) the legacy put-back stays unreached', !queue.some(({ code }) => /(^|[^\w-])tone_sink_put_back([^\w-]|$)/.test(code)),
  `read lines name tone_sink_put_back: ${JSON.stringify(queue.filter(({ code }) => /tone_sink_put_back/.test(code)).map(({ rel, n }) => `${rel}:${n}`))}`);
check('(a) the put-back is a write, so its exemption is load-bearing', exempt.some(({ code }) => /pw-metadata -n default 0 default\.configured\.audio\.sink "\$orig"/.test(code)),
  'tone_sink_put_back no longer writes the configured default, so its exemption should go');

// **Every line that names a default-output tool is a known read, by file and exact text.** Not a rule
// for writes: a rule missed a second call on one line, a path or a backslash before the tool, `eval`, the
// tool's name in a variable, and options before `set-default-sink` (round 2). A list fails safe: a line
// that names the tool anew fails until it is added here, which the diff shows. The two `audio-harness.sh`
// writes are of the default *input*, the harness's own guard (#293), not the output.
const KNOWN = {
  'lib/harness-guard.sh': ['pw-metadata -n default 0 default.audio.source 2>/dev/null \\'],
  'audio-harness.sh': [
    'for t in pw-cli pw-cat pw-loopback pw-metadata pw-dump; do',
    'pw-metadata -n default 2>/dev/null \\',
    'pw-metadata -n default 0 default.configured.audio.source "{\\"name\\":\\"$SRC_NAME\\"}" >/dev/null',
    'pw-metadata -n default 0 default.configured.audio.source "$(cat "$STATE_DIR/original-default-source")" >/dev/null || true',
  ],
  'lib/tone-sink.sh': [
    'out=$(pw-metadata -n default 0 default.configured.audio.sink 2>/dev/null) || return 1',
    'out=$(pw-metadata -n default 0 default.audio.sink 2>/dev/null) || return 1',
  ],
};
const TOOL = /pw-metadata|pactl|wpctl/;
const unknown = queue.filter(({ rel, code }) => TOOL.test(code) && !(KNOWN[rel] ?? []).includes(code.trim()));
check('(a) every line that names a default-output tool is a known read', unknown.length === 0,
  `lines the pass reaches that name pw-metadata, pactl or wpctl and are not known reads:\n    ${unknown.map(({ rel, n, code }) => `${rel}:${n}: ${code.trim()}`).join('\n    ')}`);
const stale = Object.entries(KNOWN).flatMap(([rel, list]) => list.filter((text) => !queue.some((l) => l.rel === rel && l.code.trim() === text)).map((text) => `${rel}: ${text}`));
check('(a) every known read is still there', stale.length === 0, `known reads no longer in the files: ${JSON.stringify(stale)}`);

// --- (a'), item 4 at the call site: the pass runs every check before the press, at its top level, in order,
// and nothing between the first check and the press can skip one or swallow its `die`: no block opens there
// that does not close on its own line, no heredoc, no `exit`, no definition (round 2's major). At run time
// the two route checks leave stamps the tone's judge requires, so a check skipped anyway turns the entry red.
const ends = (code) => /^\s*\}/.test(code) || /;\s*\}\s*$/.test(code);
const passTop = (() => {
  const out = []; let fn = null;
  for (const line of passLines) {
    const def = /^(?:function\s+)?([A-Za-z_][\w]*)(?:\(\))?\s*\{/.exec(line.code);
    if (def && /^(function\s|[A-Za-z_][\w]*\(\))/.test(line.code)) { fn = /\}\s*$/.test(line.code.slice(def[0].length)) ? null : def[1]; continue; }
    if (fn) { if (ends(line.code)) fn = null; continue; }
    out.push(line);
  }
  return out;
})();
const SEQUENCE = [
  ['the web processes', /^WEBENV=\$\(python3 -I scripts\/lib\/tone-graph\.py webenv "\$DRIVER_PID" "\$TONE_SINK_NAME" "\$TONE_GST_PIN" --stamp "\$WEBENV_STAMP"\) \|\| die /],
  ['one node of the family', /^ONE=\$\(python3 -I scripts\/lib\/tone-graph\.py one-sink "\$TONE_SINK_FAMILY" "\$TONE_SINK_ID" "\$TONE_SINK_NAME"\) \|\| die /],
  ['the default, again', /^tone_sink_guard_default\s*$/],
  ['the probe\'s sampler', /^python3 -I scripts\/lib\/tone-graph\.py watch "\$TONE_SINK_ID" "\$DRIVER_PID" "\$PROBE_GRAPH" .*&\s*$/],
  ['the probe', /scripts\/lib\/web-audio-probe\.js/],
  ['the wait for the probe\'s stream to close', /tone-graph\.py closed "\$PROBE_GRAPH" "\$ANSWERED"/],
  ['Web Audio started', /\|\| die "before the press: Web Audio did not start/],
  ['the probe\'s route', /^ROUTE=\$\(python3 -I scripts\/lib\/tone-graph\.py probe-judge "\$PROBE_GRAPH" "\$TONE_SINK_ID" "\$ANSWERED" --stamp "\$PROBE_STAMP"\) \|\| die /],
  ['the tone\'s sampler', /^python3 -I scripts\/lib\/tone-graph\.py watch "\$TONE_SINK_ID" "\$DRIVER_PID" "\$GRAPH" .*&\s*$/],
  ['the wait for its first sample', /\|\| die "before the press: the tone's sampler wrote no sample/],
  ['the press', /^audio_check_press "The other side is heard through" "Play a tone and listen"\s*$/],
  ['the judge, with both stamps', /^VERDICT=\$\(python3 -I scripts\/lib\/tone-graph\.py judge "\$GRAPH" --stamps "\$WEBENV_STAMP" "\$PROBE_STAMP" "\$TONE_SINK_ID" "\$TONE_SINK_NAME"\) \|\| TONE_FAILS\+=/],
];
let last = -1; let first = null; let press = null;
for (const [what, re] of SEQUENCE) {
  const at = passTop.filter(({ code }) => re.test(code));
  check(`(a') ${what}`, at.length === 1 && at[0].n > last, at.length === 1 ? `at line ${at[0].n}, not after line ${last}` : `${at.length} top-level lines of ${PASS} match ${re}`);
  if (at.length === 1) { last = Math.max(last, at[0].n); first ??= at[0].n; if (what === 'the press') press = at[0].n; }
}
if (first !== null && press !== null) {
  const span = passLines.filter(({ n }) => n >= first && n <= press);
  const opens = span.filter(({ code }) => (/^\s*(if|case|while|until|for|select|function)\b/.test(code) || /^\s*[{(]/.test(code)) && !/(\bfi|\besac|\bdone|\}|\))\s*$/.test(code));
  // A block that closes here opened before the first check, and so encloses it.
  const closes = span.filter(({ code }) => /^\s*(fi|esac|done)\b/.test(code) || /^\s*[})]/.test(code));
  const heredocs = span.filter(({ code }) => /<<(?!<)/.test(code));
  const exits = span.filter(({ code }) => /(^|[;&|{(]\s*|\s)(exit|return)(\s|;|$)/.test(code));
  const defs = span.filter(({ code }) => /^\s*(function\s+[A-Za-z_]|[A-Za-z_][\w]*\(\)\s*\{)/.test(code));
  for (const [what, found] of [['a block that does not close on its line', opens], ['a block that closes, opened before the first check', closes], ['a heredoc', heredocs], ['an exit or return', exits], ['a definition', defs]]) {
    check(`(a') nothing between the first check and the press can skip one: ${what}`, found.length === 0, found.map(({ n, code }) => `${PASS}:${n}: ${code.trim()}`).join('; '));
  }
}

// --- (b) -----------------------------------------------------------------------------------------------

const pass = fs.readFileSync(path.join(SCRIPTS, PASS), 'utf8');
const launch = /((?:^[^\n#]*\\\n)+)\s*setsid tauri-driver /m.exec(pass)?.[1] ?? '';
check('(b) the launch line names the sink', /(^|\s)PULSE_SINK="\$TONE_SINK_NAME"(\s|\\)/.test(launch), `the lines before \`setsid tauri-driver\`: ${JSON.stringify(launch)}`);
check('(b) the launch line carries the pin', /(^|\s)GST_PLUGIN_FEATURE_RANK="\$TONE_GST_PIN"(\s|\\)/.test(launch), `the lines before \`setsid tauri-driver\`: ${JSON.stringify(launch)}`);
const sink = fs.readFileSync(path.join(SCRIPTS, 'lib', 'tone-sink.sh'), 'utf8');
const pins = [...sink.matchAll(/^TONE_GST_PIN=(.*)$/gm)].map((m) => m[1]);
check('(b) the pin holds item 4\'s four entries', pins.length === 1 && pins[0] === 'alsasink:NONE,jackaudiosink:NONE,oss4sink:NONE,osssink:NONE',
  `TONE_GST_PIN is assigned ${JSON.stringify(pins)}`);

// --- (c) -----------------------------------------------------------------------------------------------

const assigned = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__pycache__') walk(p); continue; }
    fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
      if (!/^\s*#/.test(l) && (/(^|[\s;(])(export\s+|local\s+|readonly\s+|declare\s+(-\w+\s+)*)?TONE_SINK_NAME=/.test(l) || /\bprintf\s+-v\s*['"]?TONE_SINK_NAME\b/.test(l) || /(^|[;&|(]\s*)read\s+(-\S+\s+)*([A-Za-z_]\w*\s+)*TONE_SINK_NAME\b/.test(l.trim()))) assigned.push({ rel: path.relative(SCRIPTS, p), n: i + 1, l: l.trim() });
    });
  }
};
walk(SCRIPTS);
check('(c) one assignment of TONE_SINK_NAME, the family and a run id',
  assigned.length === 1 && assigned[0].rel === path.join('lib', 'tone-sink.sh') && assigned[0].l === 'TONE_SINK_NAME="${TONE_SINK_FAMILY}_$(date +%s)_$$"',
  `assignments: ${JSON.stringify(assigned)}`);
check('(c) the family is the constant', /^TONE_SINK_FAMILY=backchannel_tone_sink$/m.test(sink), 'no `TONE_SINK_FAMILY=backchannel_tone_sink` line in tone-sink.sh');

assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log(`ok - the tone never moves the default output: all ${passLines.length} lines of the pass and ${queue.length} in all read, through ${files.length} files, every line naming a default-output tool a known read; the ${SEQUENCE.length} steps before and at the press in order, nothing between them able to skip one; the driver is launched with PULSE_SINK and the pin; TONE_SINK_NAME is assigned once, the family and a run id`);

// The core pass never moves the person's default output, and its tone reaches its sink by name. (#266)
//
// Until #266 `stage2-core-check.sh` wrote `default.configured.audio.sink` to the tone sink for each press.
// WirePlumber's `follow` then moved every stream without a target of its own into that null sink: a
// Chrome tab's audio went silent for 8 s each press, measured, and the pass failed on it. Now the tone sink
// has a name of this run's own and the driver launches the application with `PULSE_SINK` naming it.
//
// Held by reading the pass itself:
// - **(a)** no line of `stage2-core-check.sh`, of `audio-harness.sh` (which it runs), or of any function
//   the pass reaches through the files it sources, writes either default-output key. A write is
//   `pw-metadata … <key> <value>`, `pw-metadata -d … <key>`, `pactl set-default-sink` or
//   `wpctl set-default`. A read with no value, as `tone_sink_effective` does, is not a write. A function is
//   reached when a reached line names it; a sourced file's own `if [ "${BASH_SOURCE[0]}" = "$0" ]` block
//   runs only when the file is run directly, so it is not reached;
// - **(b)** the `tauri-driver` launch line carries `PULSE_SINK="$TONE_SINK_NAME"` and
//   `GST_PLUGIN_FEATURE_RANK="$TONE_GST_PIN"`, and `$TONE_GST_PIN` holds the four entries item 4 names;
// - **(c)** `tone-sink.sh` assigns `$TONE_SINK_NAME` once, as the family followed by a run id, and no file
//   under `scripts/` assigns it anywhere else.
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
const sources = (rel) => lines(rel).map(({ code }) => /^\s*\.\s+"\$\(.*\)\/([\w./-]+\.sh)"\s*$/.exec(code) || /^\s*\.\s+"\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)\/([\w.-]+\.sh)"\s*$/.exec(code))
  .filter(Boolean).map((m) => (m[1].startsWith('lib/') ? m[1] : path.posix.join(path.posix.dirname(rel), m[1])));
const files = [PASS];
for (let i = 0; i < files.length; i++) for (const s of sources(files[i])) if (!files.includes(s)) files.push(s);
check('(a) the files the pass sources', ['lib/tone-sink.sh', 'lib/harness-guard.sh'].every((f) => files.includes(f)),
  `the census found ${JSON.stringify(files)}; it must at least reach lib/tone-sink.sh and lib/harness-guard.sh`);

// The pass and the harness it runs are read whole: every line of theirs is something they run. The first
// version split them into functions too, closed one only at a `}` in column 0, and so read `js() { …; }`
// in the core pass as open to the end of the file: 601 of its 807 lines went unread, and a move of the
// default placed before the press passed (#266's gate adversary, round 1).
//
// The sourced libraries are split into functions and their top level. A function runs from `name() {` to a
// `}` in column 0 or a line ending `; }`. Closing one early only moves lines to the top level, which is read
// whole; closing one late would hide what follows, so a definition inside a body, or a function still open
// at the end of its file, fails the census. A function is reached when a reached line names it.
const WHOLE = [PASS, 'audio-harness.sh'];
const functions = {};
const queue = [];
const ends = (code) => /^\}/.test(code) || /;\s*\}\s*$/.test(code);
for (const rel of [...files, 'audio-harness.sh']) {
  let fn = null; let guard = false;
  for (const line of lines(rel)) {
    const def = /^([A-Za-z_][\w]*)\(\)\s*\{/.exec(line.code);
    if (WHOLE.includes(rel)) { queue.push(line); if (def) functions[def[1]] = []; continue; }
    if (def) {
      check('(a) no definition inside a function', fn === null, `${rel}:${line.n}: ${def[1]}() is defined inside ${fn}(), so ${fn}()'s end was not found`);
      fn = def[1]; functions[fn] = [line]; if (/\}\s*$/.test(line.code.slice(def[0].length))) fn = null; continue;
    }
    if (fn) { functions[fn].push(line); if (ends(line.code)) fn = null; continue; }
    if (/^if \[ "\$\{BASH_SOURCE\[0\]\}" = "\$0" \]; then/.test(line.code)) { guard = true; continue; }
    if (guard) { if (/^fi\b/.test(line.code)) guard = false; continue; }
    queue.push(line);
  }
  check('(a) every function closes', fn === null, `${rel}: ${fn}() is still open at the end of the file, so the census cannot tell its body from the top level`);
}
const reached = new Set();
for (let i = 0; i < queue.length; i++) {
  for (const name of Object.keys(functions)) {
    if (!reached.has(name) && new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(queue[i].code)) { reached.add(name); queue.push(...functions[name]); }
  }
}
// Positive sentinels: the press, the pass's last line and the press's own function are among what was read.
const passLines = lines(PASS);
const lastCode = [...passLines].reverse().find(({ code }) => code.trim());
check('(a) the census reads the press', queue.some(({ rel, code }) => rel === PASS && /^audio_check_press "The other side is heard through" "Play a tone and listen"/.test(code)),
  'the line that presses the tone is not among the lines the census read');
check('(a) the census reads the pass to its last line', queue.some((l) => l.rel === PASS && l.n === lastCode.n), `line ${lastCode?.n} of ${PASS} is not among the lines read`);
check('(a) the census reaches audio_check_press', reached.has('audio_check_press') && (functions.audio_check_press ?? []).length > 1, 'audio_check_press, which the press runs, is not reached in lib/audio-check.sh');
check('(a) the census reaches the tone sink', ['tone_sink_create', 'tone_sink_destroy', 'tone_sink_guard_default', 'tone_sink_effective'].every((f) => reached.has(f)),
  `reached ${JSON.stringify([...reached].filter((f) => f.startsWith('tone_')))}`);
const KEY = /^default\.(configured\.)?audio\.sink$/;
const OTHER_KEY = /^default\.(configured\.)?audio\.source$/;
// A logical line: a line continued with a trailing backslash is read together with the next.
const joined = (list) => list.map((l, i) => {
  let code = l.code; let j = i;
  while (/\\\s*$/.test(code) && list[j + 1] && list[j + 1].rel === l.rel && list[j + 1].n === list[j].n + 1) { j++; code = code.replace(/\\\s*$/, ' ') + list[j].code; }
  return { ...l, code };
});
// The words of a shell command, quotes kept, up to a redirection, a pipe or the end of the command.
const words = (code) => {
  const out = [];
  for (const m of code.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+/g)) {
    if (/^(\d?>|>|\||&&|\|\||;|\)|&)/.test(m[0])) break;
    out.push(m[0]);
  }
  return out;
};
const unquote = (w) => w.replace(/^(['"])(.*)\1$/, '$2');
function writes(code) {
  if (/\bpactl\s+set-default-sink\b/.test(code) || /\bwpctl\s+set-default\b/.test(code)) return true;
  const at = code.search(/(^|[\s;(|&$`])pw-metadata\b/);
  if (at < 0) return false;
  const w = words(code.slice(at).replace(/^[\s;(|&$`]*pw-metadata\b/, ''));
  let del = false; const pos = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '-n' || w[i] === '--name' || w[i] === '-r' || w[i] === '--remote') { i++; continue; }
    if (w[i] === '-d' || w[i] === '--delete') { del = true; continue; }
    if (w[i].startsWith('-')) continue;
    pos.push(unquote(w[i]));
  }
  const [, key, value] = pos;
  // A key the census cannot read, held in a variable, counts as the sink's.
  const sinkKey = key !== undefined && (KEY.test(key) || (!OTHER_KEY.test(key) && /\$/.test(key)));
  if (del) return key === undefined || sinkKey;
  return value !== undefined && sinkKey;
}
const written = joined(queue).filter(({ code }) => writes(code));
check('(a) nothing the pass reaches writes a default output', written.length === 0,
  `writes reached from the pass, each as one logical line:\n    ${written.map(({ rel, n, code }) => `${rel}:${n}: ${code.trim()}`).join('\n    ')}`);
// The census sees what it is for: tone-sink.sh's legacy put-back writes the key, and is not reached.
check('(a) the legacy put-back is a write the pass does not reach', joined(functions.tone_sink_put_back ?? []).some(({ code }) => writes(code)) && !reached.has('tone_sink_put_back'),
  `tone_sink_put_back ${functions.tone_sink_put_back ? 'is' : 'is not'} defined, ${reached.has('tone_sink_put_back') ? 'is' : 'is not'} reached`);
const RULE = [
  ['  out=$(pw-metadata -n default 0 default.audio.sink 2>/dev/null) || return 1', false],
  ['  pw-metadata -n default 2>/dev/null \\', false],
  ['pw-metadata -n default 0 default.configured.audio.source "{\\"name\\":\\"$SRC_NAME\\"}" >/dev/null', false],
  ['pw-metadata -n default 0 default.configured.audio.sink "$x" >/dev/null', true],
  ['pw-metadata -n default 0 "$KEY" "$VALUE"', true],
  ['pw-metadata -n default -d 0 default.audio.sink', true],
  ['pw-metadata -n default 0 \\ default.configured.audio.sink "$x"'.replace('\\ ', ' '), true],
  ['pactl set-default-sink backchannel_tone_sink_1_1', true],
];
check('(a) the write rule', RULE.every(([code, want]) => writes(code) === want), `misread: ${JSON.stringify(RULE.filter(([code, want]) => writes(code) !== want))}`);
check('(a) a continued line is read whole', joined([{ rel: 'x', n: 1, code: 'pw-metadata -n default 0 \\' }, { rel: 'x', n: 2, code: '  default.configured.audio.sink "$x"' }]).some(({ code }) => writes(code)),
  'a write continued onto a second line was not read as one');

// --- (a'), item 4 at the call site: the pass runs every check before the press, at its top level, in order.
// A unit test of each check cannot see whether the pass still calls it (the gate adversary's major).
const passTop = (() => {
  const out = []; let fn = null;
  for (const line of passLines) {
    const def = /^([A-Za-z_][\w]*)\(\)\s*\{/.exec(line.code);
    if (def) { fn = /\}\s*$/.test(line.code.slice(def[0].length)) ? null : def[1]; continue; }
    if (fn) { if (ends(line.code)) fn = null; continue; }
    out.push(line);
  }
  return out;
})();
const SEQUENCE = [
  ['the web processes', /^WEBENV=\$\(python3 -I scripts\/lib\/tone-graph\.py webenv "\$DRIVER_PID" "\$TONE_SINK_NAME" "\$TONE_GST_PIN"\) \|\| die /],
  ['one node of the family', /^ONE=\$\(python3 -I scripts\/lib\/tone-graph\.py one-sink "\$TONE_SINK_FAMILY" "\$TONE_SINK_ID" "\$TONE_SINK_NAME"\) \|\| die /],
  ['the default, again', /^tone_sink_guard_default\s*$/],
  ['the probe\'s sampler', /^python3 -I scripts\/lib\/tone-graph\.py watch "\$TONE_SINK_ID" "\$DRIVER_PID" "\$PROBE_GRAPH" .*&\s*$/],
  ['the probe', /scripts\/lib\/web-audio-probe\.js/],
  ['the wait for the probe\'s stream to close', /tone-graph\.py closed "\$PROBE_GRAPH" "\$ANSWERED"/],
  ['Web Audio started', /\|\| die "before the press: Web Audio did not start/],
  ['the probe\'s route', /^ROUTE=\$\(python3 -I scripts\/lib\/tone-graph\.py probe-judge "\$PROBE_GRAPH" "\$TONE_SINK_ID" "\$ANSWERED"\) \|\| die /],
  ['the tone\'s sampler', /^python3 -I scripts\/lib\/tone-graph\.py watch "\$TONE_SINK_ID" "\$DRIVER_PID" "\$GRAPH" .*&\s*$/],
  ['the wait for its first sample', /\|\| die "before the press: the tone's sampler wrote no sample/],
  ['the press', /^audio_check_press "The other side is heard through" "Play a tone and listen"\s*$/],
  ['the judge', /^VERDICT=\$\(python3 -I scripts\/lib\/tone-graph\.py judge "\$GRAPH"\) \|\| TONE_FAILS\+=/],
];
let last = -1;
for (const [what, re] of SEQUENCE) {
  const at = passTop.filter(({ code }) => re.test(code));
  check(`(a') ${what}`, at.length === 1 && at[0].n > last, at.length === 1 ? `at line ${at[0].n}, not after line ${last}` : `${at.length} top-level lines of ${PASS} match ${re}`);
  if (at.length === 1) last = Math.max(last, at[0].n);
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
      if (!/^\s*#/.test(l) && /(^|[\s;(])(export\s+|local\s+|readonly\s+|declare\s+(-\w+\s+)*)?TONE_SINK_NAME=/.test(l)) assigned.push({ rel: path.relative(SCRIPTS, p), n: i + 1, l: l.trim() });
    });
  }
};
walk(SCRIPTS);
check('(c) one assignment of TONE_SINK_NAME, the family and a run id',
  assigned.length === 1 && assigned[0].rel === path.join('lib', 'tone-sink.sh') && assigned[0].l === 'TONE_SINK_NAME="${TONE_SINK_FAMILY}_$(date +%s)_$$"',
  `assignments: ${JSON.stringify(assigned)}`);
check('(c) the family is the constant', /^TONE_SINK_FAMILY=backchannel_tone_sink$/m.test(sink), 'no `TONE_SINK_FAMILY=backchannel_tone_sink` line in tone-sink.sh');

assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log(`ok - the tone never moves the default output: all ${passLines.length} lines of the pass and ${queue.length} in all read, through ${files.length} files and ${reached.size} functions, none writing a default-output key; the ${SEQUENCE.length} steps before and at the press in order; the driver is launched with PULSE_SINK and the pin; TONE_SINK_NAME is assigned once, the family and a run id`);

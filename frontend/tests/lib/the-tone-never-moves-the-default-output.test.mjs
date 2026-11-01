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

// Split each file into its functions and the rest, its top level. A function runs from `name() {` to a `}`
// at column 0 or a line ending `; }`, as `js() { …; }` does, or to the next definition. Closing one early
// only moves lines to the top level, which is read whole; closing one late would hide the lines after it,
// which is how the first version missed a write placed after `js` (its own control, 3.1). So a function
// still open at the end of its file fails the census.
const functions = {};
const toplevel = [];
const ends = (code) => /^\}/.test(code) || /;\s*\}\s*$/.test(code);
for (const rel of [...files, 'audio-harness.sh']) {
  let fn = null; let guard = false;
  for (const line of lines(rel)) {
    const def = /^([A-Za-z_][\w]*)\(\)\s*\{/.exec(line.code);
    if (def) { fn = def[1]; functions[fn] = [line]; if (/\}\s*$/.test(line.code.slice(def[0].length))) fn = null; continue; }
    if (fn) { functions[fn].push(line); if (ends(line.code)) fn = null; continue; }
    if (rel !== PASS && rel !== 'audio-harness.sh' && /^if \[ "\$\{BASH_SOURCE\[0\]\}" = "\$0" \]; then/.test(line.code)) { guard = true; continue; }
    if (guard) { if (/^fi\b/.test(line.code)) guard = false; continue; }
    toplevel.push(line);
  }
  check('(a) every function closes', fn === null, `${rel}: ${fn}() is still open at the end of the file, so the census cannot tell its body from the top level`);
}
// The pass and the harness it runs are reached whole; a function is reached when a reached line names it.
const reached = new Set();
const queue = [...toplevel, ...Object.entries(functions).filter(([, body]) => body[0].rel === 'audio-harness.sh').flatMap(([, b]) => b)];
for (let i = 0; i < queue.length; i++) {
  for (const name of Object.keys(functions)) {
    if (!reached.has(name) && new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(queue[i].code)) { reached.add(name); queue.push(...functions[name]); }
  }
}
check('(a) the census reaches the tone sink', ['tone_sink_create', 'tone_sink_destroy', 'tone_sink_guard_default', 'tone_sink_effective'].every((f) => reached.has(f)),
  `reached ${JSON.stringify([...reached].filter((f) => f.startsWith('tone_')))}`);
const KEY = /\bdefault\.(configured\.)?audio\.sink\b/;
function writes(code) {
  if (/\bpactl\s+set-default-sink\b/.test(code) || /\bwpctl\s+set-default\b/.test(code)) return true;
  if (!/\bpw-metadata\b/.test(code) || !KEY.test(code)) return false;
  if (/\bpw-metadata\b[^|;]*\s-d\b/.test(code)) return true;
  // The token after the key: a value is a write; a redirection, a pipe or the end of the command is a read.
  const after = code.slice(code.search(KEY)).replace(KEY, '').trimStart();
  return after !== '' && !/^(\d?>|\||\)|;|&|\\$)/.test(after);
}
// The positive sentinel: the press itself is among the lines read.
check('(a) the census reads the press', queue.some(({ rel, code }) => rel === PASS && /audio_check_press "The other side is heard through"/.test(code)),
  'the line that presses the tone is not among the lines the census reached');
const written = queue.filter(({ code }) => writes(code));
check('(a) nothing the pass reaches writes a default output', written.length === 0,
  `writes reached from the pass:\n    ${written.map(({ rel, n, l }) => `${rel}:${n}: ${l.trim()}`).join('\n    ')}`);
// The census sees what it is for: tone-sink.sh's legacy put-back writes the key, and is not reached.
check('(a) the legacy put-back is a write the pass does not reach', (functions.tone_sink_put_back ?? []).some(({ code }) => writes(code)) && !reached.has('tone_sink_put_back'),
  `tone_sink_put_back ${functions.tone_sink_put_back ? 'is' : 'is not'} defined, ${reached.has('tone_sink_put_back') ? 'is' : 'is not'} reached`);
check('(a) the reads stay reads', !writes('  out=$(pw-metadata -n default 0 default.audio.sink 2>/dev/null) || return 1') && writes('pw-metadata -n default 0 default.configured.audio.sink "$x" >/dev/null'),
  'the write rule misreads a read or a write');

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
console.log(`ok - the tone never moves the default output: ${queue.length} lines reached from the pass through ${files.length} files and ${reached.size} functions, none writing a default-output key; the driver is launched with PULSE_SINK and the pin; TONE_SINK_NAME is assigned once, the family and a run id`);

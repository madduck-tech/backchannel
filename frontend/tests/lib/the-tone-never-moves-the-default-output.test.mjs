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
// - **(a')** item 4's checks are at the pass's top level, in order before the press. Each stamps its pass,
//   and the one press goes through `tone_press`, which refuses without all four stamps, as the judge does:
//   round 2's static rule was beaten by one-line edits (#266's gate adversary, round 3), so what the census
//   now holds is that the press cannot be reached any other way. One line in all the files read presses
//   the tone, inside `tone_press`; no function is defined twice in the pass and the libraries it sources,
//   none is defined with a builtin's name, and no alias is made;
// - **(b)** the `tauri-driver` launch line carries `PULSE_SINK="$TONE_SINK_NAME"` and
//   `GST_PLUGIN_FEATURE_RANK="$TONE_GST_PIN"`, and `$TONE_GST_PIN` holds the four entries item 4 names;
// - **(c)** `tone-sink.sh` assigns `$TONE_SINK_NAME` once, as the family followed by a run id, and no file
//   under `scripts/` assigns it anywhere else: by `=` or `+=`, `printf -v`, `read`, `mapfile` or `for`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS = path.join(repo, 'scripts');
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
const lines = (rel) => fs.readFileSync(path.join(SCRIPTS, rel), 'utf8').split('\n').map((l, i) => ({ rel, n: i + 1, l, code: /^\s*#/.test(l) ? '' : l }));
// A line with its quoted text emptied and its trailing comment cut: what bash runs as words. The rules that
// must fail closed read this, not a pattern of where a word may sit (#266's gate adversary, round 5: every
// pattern of positions missed a spelling, `if . lib; then` and a case arm among them).
const bare = (l) => {
  let out = ''; let q = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') { if (c === '\\') { i++; continue; } if (c === '"') q = null; continue; }
    if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) break;
    if (c === "'" || c === '"') { q = c; out += c + c; continue; }
    out += c;
  }
  return out;
};
const WORD = (w) => new RegExp(`(^|[\\s;&|(){}!\`])(${w})(?=\\s|$|;|\\)|=|>|<|&|\\||\\}|\`)`);
// What bash runs as code in a line: outside quotes, and inside every `$( … )` or backtick that a double-quoted
// string holds. Single-quoted text and the rest of a double-quoted string are text (round 7: a
// `"$(bash … restore)"` went unseen by `bare()`, which empties the whole quoted string).
const codeView = (l) => {
  let out = ''; let q = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') { q = null; continue; }
      if (c === '$' && l[i + 1] === '(') {
        let depth = 0; let j = i + 1;
        for (; j < l.length; j++) { if (l[j] === '(') depth++; else if (l[j] === ')' && --depth === 0) break; }
        out += ' ' + l.slice(i + 2, j) + ' '; i = j; continue;
      }
      if (c === '`') { const j = l.indexOf('`', i + 1); out += ' ' + l.slice(i + 1, j < 0 ? l.length : j) + ' '; i = j < 0 ? l.length : j; }
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) break;
    if (c === "'" || c === '"') { q = c; out += ' '; continue; }
    out += c;
  }
  return out;
};

// --- (a) -----------------------------------------------------------------------------------------------

const PASS = 'stage2-core-check.sh';
// The files the pass sources, by `.` or `source`, followed through each library's own. A line that sources
// something the census cannot resolve fails it: a file it does not read could hold anything. A source is
// found in any command position: at the line's start, after `;`, `&&`, `||`, `|`, `(`, `{` or `!`, and after
// `then`, `else`, `elif`, `do`, `time`, `command` or `builtin` (round 3 found `&&`; round 4 found eight
// spellings the round-3 pattern still missed). `eval` is refused outright below.
const SOURCES = /(?:^|[;&|({!]|\b(?:then|else|elif|do|time|command|builtin)\b)\s*(?:\.|source)\s+("(?:[^"\\]|\\.|"[^"]*")*?"(?=\s|;|$|&|\|)|[^\s;)}]+)/g;
const resolve = (rel, arg) => {
  const m = /^"\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)\/([\w./-]+\.sh)"$/.exec(arg)
    || /^"\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)\/([\w./-]+\.sh)"$/.exec(arg)
    || /^"\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)\/([\w./-]+\.sh)"$/.exec(arg);
  return m ? path.posix.join(path.posix.dirname(rel), m[1]) : null;
};
// **Fail closed:** a line whose bare words hold `.` or `source` as a command word must be one the resolver reads
// (round 5). And the harness's own sources are followed too: it runs as a process of its own, but a library it
// sources is code the pass runs.
const SOURCE_WORD = WORD('\\.|source');
const files = [PASS, 'audio-harness.sh'];
for (let i = 0; i < files.length; i++) {
  for (const { n, l, code } of lines(files[i])) {
    const found = [...code.matchAll(SOURCES)];
    const bareSource = code && SOURCE_WORD.test(bare(l));
    check('(a) every source word is a source the census reads', !bareSource || found.length > 0, `${files[i]}:${n}: \`${l.trim()}\` holds a source word the census does not follow`);
    for (const m of found) {
      const target = resolve(files[i], m[1]);
      check('(a) every sourced file is resolved', target !== null, `${files[i]}:${n}: \`${code.trim()}\` sources something the census cannot read`);
      if (target && !files.includes(target)) files.push(target);
    }
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
for (const rel of files) {
  let inExempt = false; let guard = false; let depth = 0;
  for (const line of lines(rel)) {
    if (EXEMPT[rel] && new RegExp(`^${EXEMPT[rel]}\\(\\)\\s*\\{`).test(line.code)) { inExempt = true; exempt.push(line); continue; }
    if (inExempt) {
      // A definition inside it means its end was not found, and whatever it swallowed went unread.
      const inner = /^\s*(function\s+[A-Za-z_]|[A-Za-z_][\w:-]*\s*\(\s*\))/.test(line.code);
      check('(a) the exempt function closes before the next definition', !inner, `${rel}:${line.n}: a definition inside ${EXEMPT[rel]}(), so its end was not found`);
      if (inner) { inExempt = false; queue.push(line); continue; }
      exempt.push(line); if (/^\s*\}\s*(#.*)?$/.test(line.code) || /;\s*\}\s*(#.*)?$/.test(line.code)) inExempt = false; continue;
    }
    if (rel !== PASS && rel !== 'audio-harness.sh' && /^if \[ "\$\{BASH_SOURCE\[0\]\}" = "\$0" \]; then\s*$/.test(line.code)) { guard = true; depth = 1; continue; }
    if (guard) {
      // Its own `else`, at any indent, would run when the file is sourced, unread (rounds 4 and 5). Depth is
      // tracked so the `if`s nested inside it keep theirs.
      const words = bare(line.l);
      if (depth === 1) check('(a) a direct-run block has no else', !/^\s*(else|elif)\b/.test(words), `${rel}:${line.n}: \`${line.code.trim()}\` in the direct-run block runs when the file is sourced`);
      depth += (words.match(/(^|[\s;&|])if(?=\s)/g) || []).length - (words.match(/(^|[\s;&|])fi(?=\s|$|;)/g) || []).length;
      if (depth === 0) guard = false; continue;
    }
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
    'pw-cli destroy "$TONE_SINK_ID" >/dev/null 2>&1',
    'out=$(pw-metadata -n default 0 default.configured.audio.sink 2>/dev/null) || return 1',
    'out=$(pw-metadata -n default 0 default.audio.sink 2>/dev/null) || return 1',
  ],
};
// `pw-cli destroy` too: an inline loop over the family destroyed another run's sink with the census green
// (round 7's m1).
const TOOL = /pw-metadata|pactl|wpctl|pw-cli\s+(destroy|d)\b/;
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
    const def = /^(?:function\s+)?([A-Za-z_][\w]*)\s*(?:\(\s*\))?\s*\{/.exec(line.code);
    if (def && /^(function\s|[A-Za-z_][\w]*\s*\(\s*\))/.test(line.code)) { fn = /\}\s*$/.test(line.code.slice(def[0].length)) ? null : def[1]; continue; }
    if (fn) { if (ends(line.code)) fn = null; continue; }
    out.push(line);
  }
  return out;
})();
const SEQUENCE = [
  ['the stamp directory, in the run\'s profile', /^STAMPS="\$PROFILE\/before-press"; mkdir "\$STAMPS" \|\| die "[^"]*"\s*$/],
  ['the web processes', /^WEBENV=\$\(python3 -I scripts\/lib\/tone-graph\.py webenv "\$DRIVER_PID" "\$TONE_SINK_NAME" "\$TONE_GST_PIN" --stamp "\$STAMPS" "\$TONE_SINK_ID"\) \|\| die "[^"]*"\s*$/],
  ['one node of the family', /^ONE=\$\(python3 -I scripts\/lib\/tone-graph\.py one-sink "\$TONE_SINK_FAMILY" "\$TONE_SINK_ID" "\$TONE_SINK_NAME" --stamp "\$STAMPS"\) \|\| die "[^"]*"\s*$/],
  ['the default, again', /^tone_sink_guard_default "\$STAMPS"\s*$/],
  ['the probe\'s sampler', /^python3 -I scripts\/lib\/tone-graph\.py watch "\$TONE_SINK_ID" "\$DRIVER_PID" "\$PROBE_GRAPH" .*&\s*$/],
  ['the probe', /scripts\/lib\/web-audio-probe\.js/],
  ['the wait for the probe\'s stream to close', /tone-graph\.py closed "\$PROBE_GRAPH" "\$ANSWERED"/],
  ['Web Audio started', /\|\| die "before the press: Web Audio did not start/],
  ['the probe\'s route', /^ROUTE=\$\(python3 -I scripts\/lib\/tone-graph\.py probe-judge "\$PROBE_GRAPH" "\$TONE_SINK_ID" "\$ANSWERED" --stamp "\$STAMPS" "\$TONE_SINK_NAME"\) \|\| die "[^"]*"\s*$/],
  ['the tone\'s sampler', /^python3 -I scripts\/lib\/tone-graph\.py watch "\$TONE_SINK_ID" "\$DRIVER_PID" "\$GRAPH" .*&\s*$/],
  ['the wait for its first sample', /\|\| die "before the press: the tone's sampler wrote no sample/],
  ['the press', /^tone_press "\$STAMPS" "\$GRAPH" \|\| die "[^"]*"\s*$/],
  ['the judge, with the four stamps', /^VERDICT=\$\(python3 -I scripts\/lib\/tone-graph\.py judge "\$GRAPH" --stamps "\$STAMPS" "\$TONE_SINK_ID" "\$TONE_SINK_NAME"\) \|\| TONE_FAILS\+=/],
];
let last = -1; let first = null; let press = null;
for (const [what, re] of SEQUENCE) {
  const at = passTop.filter(({ code }) => re.test(code));
  check(`(a') ${what}`, at.length === 1 && at[0].n > last, at.length === 1 ? `at line ${at[0].n}, not after line ${last}` : `${at.length} top-level lines of ${PASS} match ${re}`);
  if (at.length === 1) { last = Math.max(last, at[0].n); first ??= at[0].n; if (what === 'the press') press = at[0].n; }
  // A step that starts its line is a command of its own: the code line before it does not carry on into it.
  // The four matched inside a statement (the probe's pipeline, its `|| die`s) are held by their neighbours.
  const before = at.length === 1 && re.source.startsWith('^') ? [...passLines].reverse().find(({ n, code }) => n < at[0].n && code.trim()) : null;
  check(`(a') ${what} is a command of its own`, !before || !/(\\|&&|\|\||\|)\s*$/.test(before.code), before ? `${PASS}:${before.n}: \`${before.code.trim()}\` carries on into it` : '');
}
if (first !== null && press !== null) {
  const span = passLines.filter(({ n }) => n >= first && n <= press);
  const opens = span.filter(({ code }) => (/^\s*(if|case|while|until|for|select|function)\b/.test(code) || /^\s*[{(]/.test(code)) && !/(\bfi|\besac|\bdone|\}|\))\s*$/.test(code));
  // A block that closes here opened before the first check, and so encloses it.
  const closes = span.filter(({ code }) => /^\s*(fi|esac|done|else|elif)\b/.test(code) || /^\s*[})]/.test(code));
  const heredocs = span.filter(({ code }) => /<<(?!<)/.test(code));
  const exits = span.filter(({ code }) => /(^|[;&|{(]\s*|\s)(exit|return)(\s|;|$)/.test(code));
  const defs = span.filter(({ code }) => /^\s*(function\s+[A-Za-z_]|[A-Za-z_][\w]*\s*\(\s*\)\s*\{)/.test(code));
  for (const [what, found] of [['a block that does not close on its line', opens], ['a block that closes, opened before the first check', closes], ['a heredoc', heredocs], ['an exit or return', exits], ['a definition', defs]]) {
    check(`(a') nothing between the first check and the press can skip one: ${what}`, found.length === 0, found.map(({ n, code }) => `${PASS}:${n}: ${code.trim()}`).join('; '));
  }
}

// **One press, inside `tone_press`.** The tone's button is named on one line among everything read, and that
// line is in the body of the pass's one `tone_press`, which refuses without the four stamps. A second press
// above the checks was invisible to a census that matched one spelling (round 3).
// Any spelling of the button's start: round 5 found an XPath `starts-with(…,"Play a tone")` click.
const PRESS_TEXT = /Play a tone/i;
const presses = queue.filter(({ code }) => PRESS_TEXT.test(code));
const body = (() => {
  const start = passLines.find(({ code }) => /^tone_press\(\)\s*\{/.test(code));
  const end = start && passLines.find(({ n, code }) => n > start.n && /^\}\s*$/.test(code));
  return start && end ? [start.n, end.n] : null;
})();
check('(a\') the press is named once in everything read', presses.length === 1, `${presses.length} lines name it: ${presses.map(({ rel, n }) => `${rel}:${n}`).join(', ')}`);
check('(a\') the press is inside tone_press', !!body && presses.length === 1 && presses[0].rel === PASS && presses[0].n > body[0] && presses[0].n < body[1],
  body ? `tone_press is lines ${body[0]}-${body[1]}; the press is at ${presses.map(({ rel, n }) => `${rel}:${n}`).join(', ')}` : 'no tone_press() { ... } block in the pass');
check('(a\') tone_press refuses without the stamps', !!body && passLines.some(({ n, code }) => n > body[0] && n < body[1] && /stamps-ok "\$1" "\$TONE_SINK_NAME" "\$TONE_SINK_ID" "\$2"/.test(code)),
  'tone_press does not run `tone-graph.py stamps-ok` on its arguments');

// **No function is defined twice, none with a builtin's name, and no alias.** Redefining the guard, `die` or
// `exit` above the checks, or aliasing one, kept round 2's census green (round 3). The pass and the
// libraries it sources share one shell; `audio-harness.sh` runs in its own and is left out.
// A definition is `name()` anywhere in a line's bare words, whatever follows it: a brace on the next line, a body
// in `( … )`, a compound command (round 5). Names starting with `[`, `.` or `:` are caught too.
const DEF = /(?:^|[\s;&|(){}!`])(?:function\s+([^\s(){}]+)|([A-Za-z_][\w:-]*|\[|\.|:)\s*\(\s*\))/g;
const shared = queue.filter(({ rel }) => rel !== 'audio-harness.sh');
const defined = new Map();
for (const { rel, n, l, code } of queue) {
  if (!code) continue;
  for (const m of bare(l).matchAll(DEF)) {
    const name = m[1] ?? m[2];
    const key = rel === 'audio-harness.sh' ? `audio-harness.sh:${name}` : name;
    defined.set(key, [...(defined.get(key) ?? []), `${rel}:${n}`]);
  }
}
const twice = [...defined].filter(([, at]) => at.length > 1);
check('(a\') no function is defined twice', twice.length === 0, twice.map(([name, at]) => `${name} at ${at.join(', ')}`).join('; '));
const BUILTINS = ['exit', 'return', 'builtin', 'command', 'source', '.', 'eval', 'exec', 'set', 'shopt', 'trap', 'alias', 'unalias', 'enable', 'printf', 'echo', 'read', 'test', '[', 'kill', 'wait', 'sleep', 'mkdir', 'python3', 'curl', 'cat', 'true', 'false', ':'];
const shadows = [...defined.keys()].map((k) => k.replace(/^audio-harness\.sh:/, '')).filter((name) => BUILTINS.includes(name));
check('(a\') no function has a builtin\'s name', shadows.length === 0, shadows.map((name) => `${name} at ${(defined.get(name) ?? defined.get(`audio-harness.sh:${name}`)).join(', ')}`).join('; '));
// **Words that change what a command means are known lines, at any indent** (round 5: an indented `alias`, an
// `extdebug` DEBUG trap and `set -o posix` each skipped `return 1`). Fail closed, as the known reads are.
const RISKY = WORD('eval|alias|unalias|trap|enable|hash|shopt|set\\s+-o\\s+posix|set\\s+-T|set\\s+-o\\s+functrace|POSIXLY_CORRECT|extdebug|BASH_ENV|ENV');
const KNOWN_RISKY = {
  [PASS]: ["trap '' INT TERM", 'trap - INT TERM', 'trap cleanup EXIT'],
  'audio-harness.sh': ["trap 'if [ \"$UP_COMPLETED\" != 1 ]; then note \"bringing the machine back after a failed up\"; cmd_down >/dev/null 2>&1 || true; fi' EXIT"],
};
const risky = queue.filter(({ rel, l, code }) => code && RISKY.test(bare(l)) && !(KNOWN_RISKY[rel] ?? []).includes(l.trim()));
check('(a\') no alias is made', risky.length === 0, `lines with eval, alias, trap, shopt, hash, enable or posix mode that are not known lines: ${risky.map(({ rel, n, l }) => `${rel}:${n}: ${l.trim()}`).join('; ')}`);
const staleRisky = Object.entries(KNOWN_RISKY).flatMap(([rel, list]) => list.filter((t) => !queue.some((x) => x.rel === rel && x.l.trim() === t)).map((t) => `${rel}: ${t}`));
check('(a\') every known trap line is still there', staleRisky.length === 0, JSON.stringify(staleRisky));
// `restore` runs the exempt put-back and destroys every sink of the family: nothing read runs it (round 5). Round 6:
// a quoted path to the script, or one held in a variable, hid it from a rule that named the path, so the rule
// names the word: `restore` as a bare word anywhere a line's code holds it, or a word that is exactly a quoted
// "restore". A message that tells a person to run it (`run 'bash scripts/lib/tone-sink.sh restore'`) is text.
const restores = queue.filter(({ l, code }) => code && (/(^|[^\w./-])restore(?![\w./-])/.test(codeView(l)) || /(^|[\s;&|(){}!`])(["'])restore\2(?=\s|$|;|\)|&|\||>|<)/.test(l.replace(/(^|\s)#.*$/, ''))));
check('(a\') nothing read runs tone-sink.sh restore', restores.length === 0, restores.map(({ rel, n, l }) => `${rel}:${n}: ${l.trim()}`).join('; '));
// Nothing unmakes a function, and nothing builds code from a string (round 4: `unset -f` left the guard's line a
// "command not found" the run went past; `eval` defines what no pattern reads).
const unmake = shared.filter(({ code }) => /(^|[;&|({!]\s*|\b(?:then|else|do)\s+)(builtin\s+|command\s+)?(unset\s+-\w*f|eval\b)/.test(code) || /\bunset\b[^#]*\b(die|say|exit|tone_press|tone_sink_guard_default|audio_check_press)\b/.test(code));
check('(a\') no function is unset and no code is built from a string', unmake.length === 0, unmake.map(({ rel, n, code }) => `${rel}:${n}: ${code.trim()}`).join('; '));

// **`tone_press`, `say` and `die` are fixed text.** Round 4: the census held only that `tone_press` named
// `stamps-ok`, so deleting its `return 1`, inverting its `if`, or moving the press above it stayed green, and
// `die` without its `exit 1` too. Each is compared line for line with this text, which changes only with it.
const FIXED = {
  say: [`say() { printf 'stage2-core: %s\\n' "$*"; }`],
  die: [`die() { printf 'stage2-core: %s\\n' "$*" >&2; exit 1; }`],
  tone_press: [
    `tone_press() {  # <stamp dir> <the tone's sampler file>`,
    `  local why`,
    `  if ! why=$(python3 -I scripts/lib/tone-graph.py stamps-ok "$1" "$TONE_SINK_NAME" "$TONE_SINK_ID" "$2"); then`,
    `    say "the tone was not pressed: $why"`,
    `    return 1`,
    `  fi`,
    `  say "$why"`,
    `  audio_check_press "The other side is heard through" "Play a tone and listen"`,
    `}`,
  ],
};
for (const [name, text] of Object.entries(FIXED)) {
  const at = passLines.findIndex(({ code }) => code.startsWith(`${name}() {`));
  const got = at < 0 ? [] : passLines.slice(at, at + text.length).map(({ l }) => l);
  const diff = text.findIndex((t, i) => got[i] !== t);
  check(`(a') ${name} is its fixed text`, at >= 0 && diff < 0, at < 0 ? `no ${name}() in the pass` : `line ${passLines[at + diff]?.n}: ${JSON.stringify(got[diff])}, not ${JSON.stringify(text[diff])}`);
}

// **Only the guard stamps from the shell, and only the seven known lines name the stamp directory.** A stamp
// written by any other line, or a file written into the directory, would let the press through (round 4's F1,
// F2: deliberate edits, held all the same).
const guardBody = (() => {
  const ls = lines('lib/tone-sink.sh');
  const start = ls.find(({ code }) => /^tone_sink_guard_default\(\) \{/.test(code));
  const end = start && ls.find(({ n, code }) => n > start.n && /^\}\s*$/.test(code));
  return start && end ? [start.n, end.n] : null;
})();
const stampCalls = queue.filter(({ code }) => /(tone-graph\.py|\$\{?TONE_GRAPH\}?)"?\s+stamp\s/.test(code));
check('(a\') only the guard stamps from the shell', !!guardBody && stampCalls.length === 1 && stampCalls[0].rel === 'lib/tone-sink.sh' && stampCalls[0].n > guardBody[0] && stampCalls[0].n < guardBody[1],
  `lines that run tone-graph.py stamp: ${stampCalls.map(({ rel, n }) => `${rel}:${n}`).join(', ') || 'none'}`);
const stampLines = queue.filter(({ code }) => /\$\{?STAMPS\b|before-press/.test(code));
const STAMP_STEPS = SEQUENCE.filter(([what]) => ['the stamp directory, in the run\'s profile', 'the web processes', 'one node of the family', 'the default, again', 'the probe\'s route', 'the press', 'the judge, with the four stamps'].includes(what)).map(([, re]) => re);
const strayStamps = stampLines.filter(({ rel, code }) => rel !== PASS || !STAMP_STEPS.some((re) => re.test(code)));
check('(a\') only the seven known lines name the stamp directory', strayStamps.length === 0 && stampLines.length === 7,
  `${stampLines.length} lines name it; not one of the seven: ${strayStamps.map(({ rel, n, code }) => `${rel}:${n}: ${code.trim()}`).join('; ')}`);

// **Two presses in everything read: the microphone's, bare, and the tone's, in tone_press.** Any other call of
// `audio_check_press` could press the tone by spelling its text another way (round 4's P1, P6).
const pressCalls = queue.filter(({ code }) => /(^|[^\w-])audio_check_press([^\w-]|$)/.test(code) && !/^audio_check_press\(\) \{/.test(code));
const strayPress = pressCalls.filter(({ rel, code }) => !(rel === PASS && (code.trim() === 'audio_check_press' || code === FIXED.tone_press[7])));
check('(a\') the two presses are the microphone\'s and tone_press\'s', strayPress.length === 0 && pressCalls.length === 2,
  `${pressCalls.length} calls; others: ${strayPress.map(({ rel, n, code }) => `${rel}:${n}: ${code.trim()}`).join('; ')}`);

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
// Every way bash assigns a name; `+=`, `IFS= read` and `for` each slipped past the first three (round 3).
const ASSIGNS = [
  /(^|[\s;(&|])(export\s+|local\s+|readonly\s+|typeset\s+|declare\s+(-\w+\s+)*)?TONE_SINK_NAME\+?=/,
  /\bprintf\s+(-\S+\s+)*-v\s*['"]?TONE_SINK_NAME\b/,
  /(^|[;&|(]\s*)([A-Za-z_]\w*=\S*\s+)*(read|mapfile|readarray)\s+(-\S+\s+)*([A-Za-z_]\w*\s+)*TONE_SINK_NAME\b/,
  /(^|[;&|(]\s*)for\s+TONE_SINK_NAME\b/,
];
// And any bare `TONE_SINK_NAME` in a shell file that is not a parameter expansion is an assignment (round 6:
// `if ! read -r TONE_SINK_NAME` and `while IFS= read -r TONE_SINK_NAME` escaped the forms above).
const bareNamed = (l) => [...bare(l).matchAll(/(^|.)(\{[#!]?)?\bTONE_SINK_NAME\b/g)].some((m) => !(m[1] === '$' || (m[2] && bare(l)[m.index + m[1].length - 1] === '$') || m[1] === '{' || m[1] === '#' || m[1] === '!'));
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__pycache__') walk(p); continue; }
    fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
      if (!/^\s*#/.test(l) && (ASSIGNS.some((re) => re.test(l.trim())) || (p.endsWith('.sh') && bareNamed(l)))) assigned.push({ rel: path.relative(SCRIPTS, p), n: i + 1, l: l.trim() });
    });
  }
};
walk(SCRIPTS);
check('(c) one assignment of TONE_SINK_NAME, the family and a run id',
  assigned.length === 1 && assigned[0].rel === path.join('lib', 'tone-sink.sh') && assigned[0].l === 'TONE_SINK_NAME="${TONE_SINK_FAMILY}_$(date +%s)_$$"',
  `assignments: ${JSON.stringify(assigned)}`);
check('(c) the family is the constant', /^TONE_SINK_FAMILY=backchannel_tone_sink$/m.test(sink), 'no `TONE_SINK_FAMILY=backchannel_tone_sink` line in tone-sink.sh');

assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log(`ok - the tone never moves the default output: all ${passLines.length} lines of the pass and ${queue.length} in all read, through ${files.length} files, every line naming a default-output tool a known read; the ${SEQUENCE.length} steps before and at the press in order, the press named once and inside tone_press, which refuses without the four stamps; ${defined.size} functions each defined once, none a builtin's name, no alias; the driver is launched with PULSE_SINK and the pin; TONE_SINK_NAME is assigned once, the family and a run id`);

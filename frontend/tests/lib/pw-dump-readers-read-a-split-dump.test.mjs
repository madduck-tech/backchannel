// Every graph read under `scripts/` reads a split `pw-dump` as one graph, and says so when it cannot. (#320)
//
// `pw-dump` prints a second array when the graph changes while it reads: 8 of 696 reads across one core
// entry on 2026-10-31. A single `json.load` raises `Extra data` on that, and four readers took one: the
// two passes' target-sink picks, `gate-sinks.sh`'s description lookup and two-channel's default-output
// refusal. On 2026-11-01 the refusal failed the `changed` entry twice in a row, reported as "something
// plays on the default output ((the graph could not be read))".
//
// Three halves:
// - **the census:** no file under `scripts/` that git does not ignore runs `pw-dump`, outside comments and
//   `audio-harness.sh`'s presence check, except `capture-graph.py` and `tone-graph.py`; a file of a type the
//   census cannot lex fails it;
// - **the wiring:** both passes source `graph-reads.sh` before their first read, each function is called
//   as a statement of its own, never inside `$(…)`, and each is defined in one file. A test of a function
//   alone cannot see its call site, which is where round 2 of the critic measured three silent paths;
// - **the functions, run** against `pw-dump` shims in both modes the passes could run them in, without
//   `set -e` and under `set -euo pipefail`, each followed by an unconditional sentinel: 42 runs, the
//   issue's 40 and two on a graph large enough to fill a pipe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

// --- the census -------------------------------------------------------------------------------------

// A line that mentions `pw-dump` is let through only when it is one of the comment lines below, by file and
// exact text, or `audio-harness.sh`'s presence check. Not a lexer: the first one lost track of quoting in
// three files and then let a reader appended after them through (#320's gate adversary, round 1). Not a
// rule for comments either: in an unquoted heredoc a line beginning `#` still runs its `$(…)`, and in
// JavaScript a line beginning `*` can be code (round 2). A comment that mentions `pw-dump` anew fails the
// census until it is added here, which the diff shows. JSON is read too; a file of any other type fails.
const ALLOWED = {
  'scripts/audio-harness.sh': [
    '# `node.description=Backchannel harness sink` for the sink, and `pw-dump` reports',
    '# Read it back from `pw-dump` instead.',
    '# split `pw-dump` (two arrays) as one graph: a single `json.load` took one for an empty graph (#293).',
    '# Not `pw-dump | grep -q`: grep -q closes the pipe on its first match, pw-dump takes',
  ],
  'scripts/lib/gate-sinks.sh': ['# The descriptions are read through #293\'s `harness_description`, so a split `pw-dump` is one graph (#320).'],
  'scripts/lib/graph-reads.sh': ['# split `pw-dump` (two arrays) as one graph and fails on an unreadable one. Sourced by both passes after'],
  'scripts/lib/harness-guard.sh': ['# The graph is read through `capture-graph.py`, which reads a split `pw-dump` (two arrays, 8 of 696 reads'],
  'scripts/lib/tone-sink.sh': ['# "the person chose another output", which dropped the only record of the original; and a `pw-dump`'],
  'scripts/stage2-core-check.sh': ['# Through the shared reader: one `json.load` of a split `pw-dump` failed entry 27 on 2026-10-31.'],
};
const TYPES = new Set(['.sh', '.py', '.js', '.mjs', '.json', '.ps1']);
const READERS = new Set(['scripts/lib/capture-graph.py', 'scripts/lib/tone-graph.py']);
// `audio-harness.sh`'s presence check names the tool and runs `command -v` on it, nothing else.
const presence = (lines, n) => /^\s*for t in [\w .-]*\bpw-dump\b[\w .-]*; do\s*$/.test(lines[n]) && /^\s*command -v "\$t" >\/dev\/null \|\| die /.test(lines[n + 1] ?? '');

export function census(root) {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'scripts'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const found = [];
  for (const file of listed.stdout.split('\n').filter(Boolean)) {
    if (!fs.existsSync(path.join(root, file))) continue;
    if (!TYPES.has(path.extname(file))) { found.push(`${file}: a type the census does not lex`); continue; }
    if (READERS.has(file)) continue;
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((l, n) => {
      if (/pw-dump/.test(l) && !(ALLOWED[file] ?? []).includes(l.trim()) && !presence(lines, n)) found.push(`${file}:${n + 1}: ${l.trim()}`);
    });
  }
  return found;
}

const readers = census(repo);
check('C1 the census', readers.length === 0, `pw-dump is run outside capture-graph.py and tone-graph.py:\n    ${readers.join('\n    ')}`);
// The census sees what it is for: the presence check is the one code mention it lets through, and the
// four readers #320 moved would each be found (the controls show it).
const harness = read('scripts/audio-harness.sh');
check('C1 the presence check', harness.split('\n').some((l, n, all) => /pw-dump/.test(l) && presence(all, n)), 'audio-harness.sh\'s `for t in … pw-dump` check is no longer where the census expects it');

// --- the wiring -------------------------------------------------------------------------------------

const SOURCE = '. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/graph-reads.sh"';
const HOME = {
  pick_two_channel_sink: 'scripts/lib/graph-reads.sh',
  pick_ui_record_sink: 'scripts/lib/graph-reads.sh',
  refuse_if_the_default_output_plays: 'scripts/lib/graph-reads.sh',
  gate__descs: 'scripts/lib/gate-sinks.sh',
};
// Where each function is called, and how often: a call dropped is a read nobody makes.
const CALLS = {
  pick_two_channel_sink: { 'scripts/stage2-two-channel-check.sh': 1 },
  pick_ui_record_sink: { 'scripts/stage2-ui-record-check.sh': 1 },
  refuse_if_the_default_output_plays: { 'scripts/stage2-two-channel-check.sh': 4 },
  gate__descs: { 'scripts/lib/gate-sinks.sh': 1 },
};
// A statement of its own: the name, then double-quoted arguments and nothing else, optionally after a
// final `[ … ] &&`, under which a function keeps `set -e` (measured, #320).
const statement = (name) => new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*&&\\s*)?${name}(?:\\s+"[^"]*")*\\s*$`);
const shellFiles = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'scripts'], { cwd: repo, encoding: 'utf8' })
  .stdout.split('\n').filter((f) => f.endsWith('.sh') && fs.existsSync(path.join(repo, f)));
// The comment lines that name a function, by file and exact text, are not calls; every other line is read
// as it stands, a `#` line included, since one in an unquoted heredoc runs its `$(…)` (round 2).
const NAMED = {
  'scripts/lib/graph-reads.sh': [
    '#   pick_two_channel_sink                    TARGET_SINK, TARGET_DESC: the sink whose monitor two-channel picks',
    '#   pick_ui_record_sink                      TARGET_SINK, TARGET_DESC, and OTHER_SINK for the wrong-sink control',
    '#   refuse_if_the_default_output_plays <which start>',
  ],
  'scripts/stage2-two-channel-check.sh': ['# `refuse_if_the_default_output_plays <which start>` is in `lib/graph-reads.sh`, with its reader (#320).'],
};
const code = Object.fromEntries(shellFiles.map((f) => [f, read(f).split('\n').map((l) => ((NAMED[f] ?? []).includes(l.trim()) ? '' : l))]));
for (const [name, home] of Object.entries(HOME)) {
  const counts = {};
  for (const [file, lines] of Object.entries(code)) {
    lines.forEach((l, n) => {
      if (!new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(l)) return;
      if (new RegExp(`^\\s*${name}\\(\\)\\s*\\{`).test(l)) {
        check(`W1 ${name} is defined once`, file === home, `${file}:${n + 1} defines it; only ${home} may`);
      } else if (statement(name).test(l)) {
        counts[file] = (counts[file] ?? 0) + 1;
      } else {
        failures.push(`W1 ${name} is called as a statement of its own: ${file}:${n + 1}: ${l.trim()}`);
      }
    });
  }
  check(`W1 ${name}'s calls`, JSON.stringify(counts) === JSON.stringify(CALLS[name]), `calls ${JSON.stringify(counts)}, not ${JSON.stringify(CALLS[name])}`);
}
for (const pass of ['scripts/stage2-two-channel-check.sh', 'scripts/stage2-ui-record-check.sh']) {
  const lines = code[pass];
  const src = lines.findIndex((l) => l.trim() === SOURCE);
  const die = lines.findIndex((l) => /^die\(\) \{/.test(l));
  const first = lines.findIndex((l) => Object.keys(HOME).slice(0, 3).some((name) => statement(name).test(l)));
  check(`W1 ${pass} sources graph-reads.sh`, src >= 0 && die >= 0 && die < src && src < first,
    `the source line at ${src + 1}, die() at ${die + 1}, the first call at ${first + 1}: it must come after die() and before the first call`);
}
check('W1 gate-sinks.sh sources harness-guard.sh', code['scripts/lib/gate-sinks.sh'].some((l) => l.trim() === '. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness-guard.sh"'),
  'two-channel sources harness-guard.sh only after gate_sinks_create runs, so gate-sinks.sh must source it itself');

// --- the functions, run -----------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dump-readers-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const guardLog = path.join(root, 'guard.log');
// Only the shim answers: every other PipeWire tool on PATH refuses and is logged, so a run never reaches
// the real graph.
for (const t of ['pw-cli', 'pw-metadata', 'pw-cat', 'pw-record', 'pw-play', 'pw-loopback', 'wpctl', 'pactl']) {
  fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho "${t} $*" >> ${JSON.stringify(guardLog)}\nexit 99\n`, { mode: 0o755 });
}
// The shim prints `dump` on each call, or exits 1 on a call named by a `fail-<n>` file, or on all with `fail`.
fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/bin/sh
d="$PW_SHIM"; n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/n"
if [ -e "$d/fail" ] || [ -e "$d/fail-$n" ]; then exit 1; fi
cat "$d/dump"
`, { mode: 0o755 });

const NODE = 'PipeWire:Interface:Node';
const node = (id, name, cls, desc, extra = {}) => ({ id, type: NODE, info: { props: { 'node.name': name, 'media.class': cls, 'node.description': desc, ...extra } } });
const sink = (id, name, desc) => node(id, name, 'Audio/Sink', desc);
const link = (id, from, into) => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-node-id': from, 'input-node-id': into, state: 'active' } });
const gone = (id) => ({ id, info: null });
const meta = (sinkName) => ({ id: 30, type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: [
  { subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: { name: 'alsa_input.mic' } },
  ...(sinkName ? [{ subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: { name: sinkName } }] : []),
] });
const dump = (...arrays) => arrays.map((a) => JSON.stringify(a, null, 2)).join('\n');
const UNREAD = /could not be read/;

// The picks. (a): a sink without `Speaker` and one about to go, an `Audio/Sink/…` node described `Speaker`
// and a lowercase `speaker`; then the `Speaker + Headphones` sink added, with its whitespace untidy, a
// second `Speaker` sink after it, and the other removed. So the right pick is the first sink of class
// `Audio/Sink` whose description holds `Speaker`, case and all, and a pick that takes the last, ignores
// case or takes any `Audio/Sink…` class answers another (#320's gate adversary). (b): a removal record,
// then the graph, the harness sink first, a sink with `backchannel_harness` inside its name next, and no
// `Speaker`: two-channel skips the prefix alone.
const PICK_A = dump(
  [meta('alsa_output.builtin'), sink(41, 'alsa_output.usb', 'USB Audio'), sink(42, 'alsa_output.hdmi', 'HDMI Output'),
    node(55, 'alsa_output.virtual', 'Audio/Sink/Virtual', 'Speaker Virtual'), sink(49, 'alsa_output.lower', 'speaker lowercase')],
  [sink(43, 'alsa_output.builtin', ' Speaker  + Headphones '), sink(48, 'alsa_output.second', 'Speaker Two'), gone(41)],
);
const PICK_B = dump(
  [gone(99)],
  [meta('alsa_output.hdmi'), sink(44, 'backchannel_harness_sink', 'Backchannel'), sink(56, 'alsa_backchannel_harness_mid', 'Mid Output'),
    sink(45, 'alsa_output.hdmi', 'HDMI Output'), sink(46, 'alsa_output.usb', 'USB Audio')],
);
const PICK_D = dump([meta('alsa_output.builtin'), node(47, 'alsa_input.mic', 'Audio/Source', 'Microphone')]);
// gate__descs. (a): A and something about to go, then B added and the other removed.
const DESC = (id, s) => sink(id, `backchannel_gate_sink_${s}`, `Backchannel gate sink ${s.toUpperCase()}`);
const GATE_GRAPH = [meta('alsa_output.builtin'), DESC(51, 'a'), DESC(52, 'b')];
const GATE_A = dump([meta('alsa_output.builtin'), DESC(51, 'a'), sink(53, 'alsa_output.usb', 'USB Audio')], [DESC(52, 'b'), gone(53)]);
const GATE_B = dump([gone(99)], GATE_GRAPH);
const GATE_D = dump([meta('alsa_output.builtin'), sink(54, 'alsa_output.usb', 'USB Audio')]);
// (f): sink A first and enough nodes after it that `nodes` outgrows a pipe. A reader that stops at its
// row under `pipefail` returns 141 with the answer in hand (#320's gate adversary, measured at 315 KB).
const GATE_F = dump([meta('alsa_output.builtin'), DESC(51, 'a'),
  ...Array.from({ length: 6000 }, (_, i) => sink(1000 + i, `alsa_output.filler_${i}_${'x'.repeat(24)}`, `Filler output number ${i}`)), DESC(52, 'b')]);
// The refusal. Firefox plays into the default sink; (a) adds that link in the second array.
const BUILTIN = sink(60, 'alsa_output.builtin', 'Speaker + Headphones');
const FIREFOX = node(61, 'firefox-stream', 'Stream/Output/Audio', 'Firefox', { 'application.name': 'Firefox' });
const REF_A = dump([meta('alsa_output.builtin'), BUILTIN, sink(63, 'alsa_output.usb', 'USB Audio')], [FIREFOX, link(62, 61, 60), gone(63)]);
const REF_B = dump([gone(99)], [meta('alsa_output.builtin'), BUILTIN, FIREFOX, link(62, 61, 60)]);
const REF_D = dump([meta('alsa_output.builtin'), BUILTIN, FIREFOX]);
const REF_E1 = dump([meta('alsa_output.builtin'), BUILTIN, FIREFOX, link(62, 61, 60)], [gone(60), gone(62)]);
const REF_E2 = dump([meta(null), BUILTIN, FIREFOX]);

const answer = (want) => (r) => r.sentinel && !UNREAD.test(r.err) && Object.entries(want).every(([k, v]) => r.vars[k] === v)
  ? null : `wanted ${JSON.stringify(want)} and the sentinel; got ${JSON.stringify(r.vars)}, sentinel ${r.sentinel}, stderr ${JSON.stringify(r.err)}`;
// The reader's own last line rides in the words, so a failed pw-dump says so (the gate adversary's fifth).
const CAUSE = /returned non-zero exit status 1/;
const unreadable = (also = /(?:)/) => (r) => !r.sentinel && UNREAD.test(r.err) && also.test(r.err) && !/no Audio\/Sink to target|do not present distinct|no default output sink|something plays/.test(r.err)
  ? null : `wanted the unreadable words ${also} and no sentinel; got sentinel ${r.sentinel}, stderr ${JSON.stringify(r.err)}`;
const dies = (words) => (r) => !r.sentinel && words.test(r.err) && !UNREAD.test(r.err)
  ? null : `wanted ${words} without the unreadable words, and no sentinel; got sentinel ${r.sentinel}, stderr ${JSON.stringify(r.err)}`;
const goesOn = (r) => r.sentinel && r.err === '' ? null : `wanted the start to go ahead, silently; got sentinel ${r.sentinel}, stderr ${JSON.stringify(r.err)}`;
const missing = (r) => !r.sentinel && /no default output sink/.test(r.err) && !UNREAD.test(r.err) && !/something plays/.test(r.err)
  ? null : `wanted a refusal naming the missing default sink, without the unreadable words or "something plays"; got sentinel ${r.sentinel}, stderr ${JSON.stringify(r.err)}`;

const LIB = path.join(repo, 'scripts', 'lib');
const FUNCTIONS = [
  { fn: 'pick_two_channel_sink', lib: 'graph-reads.sh', vars: ['TARGET_SINK', 'TARGET_DESC'], shims: [
    ['a', PICK_A, answer({ TARGET_SINK: 'alsa_output.builtin', TARGET_DESC: 'Speaker + Headphones' })],
    ['b', PICK_B, answer({ TARGET_SINK: 'alsa_backchannel_harness_mid', TARGET_DESC: 'Mid Output' })],
    ['c', null, unreadable(CAUSE)],
    ['d', PICK_D, dies(/no Audio\/Sink to target/)],
  ] },
  { fn: 'pick_ui_record_sink', lib: 'graph-reads.sh', vars: ['TARGET_SINK', 'TARGET_DESC', 'OTHER_SINK'], shims: [
    ['a', PICK_A, answer({ TARGET_SINK: 'alsa_output.builtin', TARGET_DESC: 'Speaker + Headphones', OTHER_SINK: 'alsa_output.hdmi' })],
    ['b', PICK_B, answer({ TARGET_SINK: 'backchannel_harness_sink', TARGET_DESC: 'Backchannel', OTHER_SINK: 'alsa_backchannel_harness_mid' })],
    ['c', null, unreadable(CAUSE)],
    ['d', PICK_D, dies(/no Audio\/Sink to target/)],
  ] },
  { fn: 'gate__descs', lib: 'gate-sinks.sh', vars: ['GATE_DESC_A', 'GATE_DESC_B'], shims: [
    ['a', GATE_A, answer({ GATE_DESC_A: 'Backchannel gate sink A', GATE_DESC_B: 'Backchannel gate sink B' })],
    ['b', GATE_B, answer({ GATE_DESC_A: 'Backchannel gate sink A', GATE_DESC_B: 'Backchannel gate sink B' })],
    ['c', null, unreadable(/gate sink A/)],
    ["c'", dump(GATE_GRAPH), unreadable(/gate sink B/), [2]],
    ["c''", dump(GATE_GRAPH), unreadable(/gate sink A/), [1]],
    ['d', GATE_D, dies(/do not present distinct descriptions \('', ''\)/)],
    ['f', GATE_F, answer({ GATE_DESC_A: 'Backchannel gate sink A', GATE_DESC_B: 'Backchannel gate sink B' })],
  ] },
  { fn: 'refuse_if_the_default_output_plays', lib: 'graph-reads.sh', args: ['the start'], vars: [], shims: [
    ['a', REF_A, dies(/something plays on the default output \(Firefox\); the start could record it/)],
    ['b', REF_B, dies(/something plays on the default output \(Firefox\); the start could record it/)],
    ['c', null, unreadable(CAUSE)],
    ['d', REF_D, goesOn],
    ['e1', REF_E1, missing],
    ['e2', REF_E2, missing],
  ] },
];

let runs = 0;
const lines = [];
for (const { fn, lib, args = [], vars, shims } of FUNCTIONS) {
  for (const [shim, text, judge, failCalls] of shims) {
    for (const mode of ['plain', 'strict']) {
      const d = fs.mkdtempSync(path.join(root, 'shim-'));
      if (text === null) fs.writeFileSync(path.join(d, 'fail'), '');
      else fs.writeFileSync(path.join(d, 'dump'), text);
      for (const n of failCalls ?? []) fs.writeFileSync(path.join(d, `fail-${n}`), '');
      const script = [
        mode === 'strict' ? 'set -euo pipefail' : '',
        `die() { printf 'pass: %s\\n' "$*" >&2; exit 1; }`,
        `. ${JSON.stringify(path.join(LIB, lib))}`,
        `${fn}${args.map((a) => ` ${JSON.stringify(a)}`).join('')}`,
        'echo SENTINEL',
        ...vars.map((v) => `printf '%s=%s\\n' ${v} "\${${v}-<unset>}"`),
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PW_SHIM: d }, encoding: 'utf8' });
      const out = r.stdout.split('\n');
      const got = { sentinel: out.includes('SENTINEL'), err: r.stderr.trim(), vars: Object.fromEntries(out.filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
      const verdict = judge(got);
      runs++;
      lines.push(`${verdict ? 'FAIL' : 'ok  '} ${fn} (${shim}) ${mode}${verdict ? `: ${verdict}` : ''}`);
      if (verdict) failures.push(`F ${fn} on (${shim}), ${mode === 'strict' ? 'under set -euo pipefail' : 'without set -e'}: ${verdict}`);
    }
  }
}
console.log(lines.join('\n'));
// A reader whose stderr carries a line on a read that succeeds: the loader's, or a wrapper's. It must
// change nothing, since a line taken with the answer became the default sink (round 2's major).
const noisy = path.join(root, 'noisy');
fs.mkdirSync(noisy);
fs.writeFileSync(path.join(noisy, 'python3'), `#!/bin/sh\necho "ld.so: a warning on a read that succeeds" >&2\nexec /usr/bin/python3 "$@"\n`, { mode: 0o755 });
const NOISY = [
  ['pick_two_channel_sink', 'graph-reads.sh', [], ['TARGET_SINK', 'TARGET_DESC'], 'a', PICK_A, answer({ TARGET_SINK: 'alsa_output.builtin', TARGET_DESC: 'Speaker + Headphones' })],
  ['refuse_if_the_default_output_plays', 'graph-reads.sh', ['the start'], [], 'd', REF_D, goesOn],
  ['refuse_if_the_default_output_plays', 'graph-reads.sh', ['the start'], [], 'e1', REF_E1, missing],
  ['refuse_if_the_default_output_plays', 'graph-reads.sh', ['the start'], [], 'e2', REF_E2, missing],
];
for (const [fn, lib, args, vars, shim, text, judge] of NOISY) {
  for (const mode of ['plain', 'strict']) {
    const d = fs.mkdtempSync(path.join(root, 'shim-'));
    fs.writeFileSync(path.join(d, 'dump'), text);
    const script = [mode === 'strict' ? 'set -euo pipefail' : '', `die() { printf 'pass: %s\\n' "$*" >&2; exit 1; }`, `. ${JSON.stringify(path.join(LIB, lib))}`,
      `${fn}${args.map((x) => ` ${JSON.stringify(x)}`).join('')}`, 'echo SENTINEL', ...vars.map((v) => `printf '%s=%s\\n' ${v} "\${${v}-<unset>}"`)].join('\n');
    const r = spawnSync('bash', ['-c', script], { env: { PATH: `${noisy}:${bin}:/usr/bin:/bin`, HOME: root, PW_SHIM: d }, encoding: 'utf8' });
    const out = r.stdout.split('\n');
    const got = { sentinel: out.includes('SENTINEL'), err: r.stderr.split('\n').filter((l) => !/^ld\.so: /.test(l)).join('\n').trim(), vars: Object.fromEntries(out.filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
    const verdict = judge(got);
    runs++;
    lines.push(`${verdict ? 'FAIL' : 'ok  '} ${fn} (${shim}, a noisy reader) ${mode}${verdict ? `: ${verdict}` : ''}`);
    if (verdict) failures.push(`F ${fn} on (${shim}) with a reader that writes to stderr and succeeds, ${mode === 'strict' ? 'under set -euo pipefail' : 'without set -e'}: ${verdict}`);
  }
}
console.log(lines.slice(-8).join('\n'));
// The issue's 40, 2 on (f), which fills a pipe, and 8 with a reader that writes to stderr and succeeds.
check('F the run count', runs === 50, `${runs} runs, not 50`);
check('F nothing reached the real graph', !fs.existsSync(guardLog), `a PipeWire tool other than the shim was called: ${fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8') : ''}`);

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log(`ok - pw-dump readers: no file under scripts/ runs pw-dump but the two shared readers; both passes source graph-reads.sh before their first read and call each function as a statement of its own; the four functions answer through a split dump, and name an unreadable graph as unreadable, in ${runs} runs with and without set -e`);

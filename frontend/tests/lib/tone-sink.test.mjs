// The tone sink's guard and repair, run against PipeWire shims. (#173, #266)
//
// `scripts/lib/tone-sink.sh` makes a null sink for the audio check's tone, under a name of this run's own,
// and never moves the person's default output (#266). Until #266 it moved the default for each press, and
// the cases that held that move went with it. What is held here:
//
//   - **the family.** A sink left by a killed run, of either era, is found: the constant
//     `backchannel_tone_sink` and every `backchannel_tone_sink_<…>`. Cases 5, 7 and 11 keep a constant node
//     and each gains a `backchannel_tone_sink_1_1` twin with the case's own outcome;
//   - **the default guard.** WirePlumber makes a node whose name is on its stack of previous defaults the
//     default output on its own, with no write (measured 2026-11-01: 0.001 s after the node was made). So
//     `create` reads the effective default before the sink exists and for a window after it has ports, and
//     refuses the run, destroying the sink, on a move or on a read it cannot take;
//   - **destroy by name.** PipeWire gives a freed id to the next object, so the exit trap destroys its id
//     only while that id still names this run's sink;
//   - **legacy.** A run from before #266 kept the original default in a file while it had moved it. A run
//     still refuses while that file exists, and `restore` still puts that output back.
//
// The shims keep the graph in a JSON file: the configured and effective default, and the nodes, each with
// an input port. A write to the configured default moves the effective one too, as WirePlumber does,
// unless `ignoreWrites` is set, which is a write that does not take effect. `moveOnCreate` makes the new
// node the effective default at once, as a stacked name does; `moveAfterReads: n` makes it so on the n-th
// read of the effective default after it was made. `failReads` fails every read, `failEffective` the
// effective read alone, and `splitDump` prints the graph, then a second, empty array.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = path.join(repo, 'scripts', 'lib', 'tone-sink.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-sink-'));
const HEADSET = '{"name":"bluez_output.headset"}';
const SPEAKERS = '{"name":"alsa_output.usb-speakers"}';
const CONSTANT = 'backchannel_tone_sink';
const TWIN = 'backchannel_tone_sink_1_1';
const named = (n) => `{"name":"${n}"}`;

const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env python3
import json, os, re, sys
S = os.environ['SHIM_STATE']
st = json.load(open(S))
def save(): json.dump(st, open(S, 'w'))
a = sys.argv[1:]
${body}
`, { mode: 0o755 });
shim('pw-metadata', `
key = a[3]
if len(a) < 5 and (st.get('failReads') or (st.get('failEffective') and key == 'default.audio.sink')):
    sys.exit(1)
if len(a) >= 5:
    if key == 'default.configured.audio.sink' and not st.get('ignoreWrites'):
        st['configured'] = a[4]; st['effective'] = a[4]; save()
    sys.exit(0)
if key == 'default.audio.sink' and st.get('made'):
    st['reads'] = st.get('reads', 0) + 1
    if st.get('moveAfterReads') and st['reads'] >= st['moveAfterReads']:
        st['effective'] = '{"name":"%s"}' % st['made']
    save()
v = st.get('configured' if key == 'default.configured.audio.sink' else 'effective')
if v: print(f"update: id:0 key:'{key}' value:'{v}' type:'Spa:String:JSON'")
`);
shim('pw-dump', `
objs = []
for n in st['nodes']:
    objs.append({'id': n['id'], 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': n['name']}}})
    objs.append({'id': 10000 + n['id'], 'type': 'PipeWire:Interface:Port', 'info': {'direction': 'input', 'props': {'node.id': n['id']}}})
print(json.dumps(objs))
if st.get('splitDump'): print('[]')`);
shim('pw-cli', `
if a[0] == 'create-node':
    st['next'] = st.get('next', 100) + 1
    name = re.search(r'node\\.name=(\\S+)', a[2]).group(1)
    st['nodes'].append({'id': st['next'], 'name': name}); st['made'] = name
    if st.get('moveOnCreate'): st['effective'] = '{"name":"%s"}' % name
    save()
elif a[0] == 'destroy':
    if st.get('failDestroy'): sys.exit(1)
    st.setdefault('destroyed', []).append(a[1])
    st['nodes'] = [n for n in st['nodes'] if str(n['id']) != a[1]]; save()
`);

// A repository of its own, so the state dir is found from the script's location as it is for real.
const work = path.join(root, 'repo');
fs.mkdirSync(path.join(work, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(SOURCE, path.join(work, 'scripts', 'lib', 'tone-sink.sh'));
fs.copyFileSync(path.join(repo, 'scripts', 'lib', 'tone-graph.py'), path.join(work, 'scripts', 'lib', 'tone-graph.py'));
const git = (...args) => spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' });
git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
const STATE_FILE = path.join(work, '.git', 'backchannel-tone-sink', 'original-default-sink');

let statePath;
function graph(init) {
  statePath = path.join(root, `state-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(statePath, JSON.stringify({ nodes: [], ...init }));
  fs.rmSync(path.dirname(STATE_FILE), { recursive: true, force: true });
}
// The record a run from before #266 kept while it had moved the default output.
const legacy = (original) => { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, `${original}\n`); };
const now = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const flip = (patch) => fs.writeFileSync(statePath, JSON.stringify({ ...now(), ...patch }));
const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_STATE: statePath });
// A pass's shape: say/die, the library sourced, an EXIT trap that calls tone_sink_destroy.
function pass(body, script = path.join(work, 'scripts', 'lib', 'tone-sink.sh'), cwd = work) {
  return spawnSync('bash', ['-c', `
say() { printf 'pass: %s\\n' "$*"; }
die() { printf 'pass: %s\\n' "$*" >&2; exit 1; }
. ${JSON.stringify(script)}
trap 'tone_sink_destroy' EXIT
${body}`], { cwd, env: env(), encoding: 'utf8' });
}
const restore = (cwd = work, script = path.join(work, 'scripts', 'lib', 'tone-sink.sh')) =>
  spawnSync('bash', [script, 'restore'], { cwd, env: env(), encoding: 'utf8' });

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

// 1. A whole run: a sink of this run's own name, made and destroyed, and the defaults never written.
graph({ configured: HEADSET, effective: HEADSET });
let r = pass('tone_sink_create; echo "NAME=$TONE_SINK_NAME"');
const made = /NAME=(\S+)/.exec(r.stdout)?.[1];
check('1 a whole run', r.status === 0 && now().configured === HEADSET && now().effective === HEADSET && now().nodes.length === 0 && now().made === made && !fs.existsSync(STATE_FILE),
  `exit ${r.status}, configured ${now().configured}, nodes ${JSON.stringify(now().nodes)}, made ${now().made}, named ${made}: ${r.stdout}${r.stderr}`);
check('1b the name is the family and a run id', /^backchannel_tone_sink_\d+_\d+$/.test(made ?? ''), `named ${made}`);
graph({ configured: HEADSET, effective: HEADSET });
r = pass('echo "NAME=$TONE_SINK_NAME"');
check('1c and no two runs share it', (/NAME=(\S+)/.exec(r.stdout)?.[1] ?? made) !== made, `two runs both named ${made}`);

// 2. The default guard (#266): a sink that took the effective default is destroyed, and the run refused.
graph({ configured: HEADSET, effective: SPEAKERS, moveOnCreate: true });
r = pass('tone_sink_create; echo WENT-ON');
check('2a moved at once', r.status === 1 && !/WENT-ON/.test(r.stdout) && /moved from \{"name":"alsa_output.usb-speakers"\} to \{"name":"backchannel_tone_sink_\d+_\d+"\}/.test(r.stderr) && now().nodes.length === 0,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
graph({ configured: HEADSET, effective: SPEAKERS, moveAfterReads: 3 });
r = pass('tone_sink_create; echo WENT-ON');
check('2b moved on the third read after the ports appeared', r.status === 1 && !/WENT-ON/.test(r.stdout) && /moved from \{"name":"alsa_output.usb-speakers"\} to \{"name":"backchannel_tone_sink_\d+_\d+"\}/.test(r.stderr) && now().nodes.length === 0,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
// ... on the seventh read: inside the 2 s window, past a 1 s one.
graph({ configured: HEADSET, effective: SPEAKERS, moveAfterReads: 7 });
r = pass('tone_sink_create; echo WENT-ON');
check('2e moved on the seventh read', r.status === 1 && !/WENT-ON/.test(r.stdout) && /moved from/.test(r.stderr) && now().nodes.length === 0,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
// ... and a destroy that does not take is said, and leaves the id for the exit trap and restore.
graph({ configured: HEADSET, effective: SPEAKERS, moveOnCreate: true, failDestroy: true });
r = pass('tone_sink_create; echo WENT-ON');
check('2f a destroy that did not take is said', r.status === 1 && /the sink could NOT be destroyed; run 'bash scripts\/lib\/tone-sink\.sh restore'/.test(r.stderr) && now().nodes.length === 1,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
graph({ configured: HEADSET, effective: SPEAKERS });
flip({ failEffective: true });
r = pass('tone_sink_create; echo WENT-ON');
check('2c the effective read fails while the configured one answers', r.status === 1 && !/WENT-ON/.test(r.stdout) && /could not read the effective default output/.test(r.stderr) && now().nodes.length === 0,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
// ... and once the sink exists: the reads after it fail closed too.
graph({ configured: HEADSET, effective: SPEAKERS });
fs.writeFileSync(path.join(bin, 'flip-effective'), `#!/usr/bin/env python3
import json, os
S = os.environ['SHIM_STATE']; st = json.load(open(S)); st['failEffective'] = True; json.dump(st, open(S, 'w'))
`, { mode: 0o755 });
r = pass(`tone_sink_create; ${JSON.stringify(path.join(bin, 'flip-effective'))}; tone_sink_guard_default; echo WENT-ON`);
check('2d a read that fails after the sink exists', r.status === 1 && !/WENT-ON/.test(r.stdout) && /could not be read, so nothing shows the tone sink left it alone/.test(r.stderr) && now().nodes.length === 0,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

// 3. Destroy by name: an id that now names another node is not destroyed.
graph({ configured: HEADSET, effective: HEADSET });
fs.writeFileSync(path.join(bin, 'reuse-id'), `#!/usr/bin/env python3
import json, os
S = os.environ['SHIM_STATE']; st = json.load(open(S)); st['nodes'] = [{'id': n['id'], 'name': 'someone-elses-stream'} for n in st['nodes']]; json.dump(st, open(S, 'w'))
`, { mode: 0o755 });
r = pass(`tone_sink_create; ${JSON.stringify(path.join(bin, 'reuse-id'))}`);
check('3 an id reused by another node is left alone', r.status === 0 && !(now().destroyed ?? []).length && now().nodes.length === 1 && /no longer names backchannel_tone_sink_\d+_\d+/.test(r.stdout),
  `exit ${r.status}, destroyed ${JSON.stringify(now().destroyed)}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

// 4. Legacy: a run from before #266 that never put the default back. The next run refuses, and restore
// writes the original back, for the constant and for a twin.
for (const sink of [CONSTANT, TWIN]) {
  graph({ configured: named(sink), effective: named(sink), nodes: [{ id: 9, name: sink }] });
  legacy(HEADSET);
  r = pass('tone_sink_create; echo WENT-ON');
  check(`4a a legacy record refuses the run (${sink})`, r.status === 1 && /was never put back/.test(r.stderr) && !/WENT-ON/.test(r.stdout) && now().nodes.length === 1 && fs.existsSync(STATE_FILE),
    `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
  r = restore();
  check(`4b restore puts the original back and clears the sink (${sink})`, r.status === 0 && now().configured === HEADSET && now().nodes.length === 0 && !fs.existsSync(STATE_FILE),
    `exit ${r.status}, configured ${now().configured}, nodes ${JSON.stringify(now().nodes)}, file ${fs.existsSync(STATE_FILE)}: ${r.stdout}${r.stderr}`);
}

// 5. The default names a tone sink and no file says what it was: restore says so, and destroys nothing.
for (const sink of [CONSTANT, TWIN]) {
  graph({ configured: named(sink), effective: named(sink), nodes: [{ id: 7, name: sink }] });
  r = restore();
  check(`5 no record of the original (${sink})`, r.status === 1 && /nothing records what it was/.test(r.stderr) && now().nodes.length === 1,
    `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
  // ... and a run refuses while the configured default names it.
  graph({ configured: named(sink), effective: SPEAKERS });
  r = pass('tone_sink_create; echo WENT-ON');
  check(`5b a configured tone sink refuses the run (${sink})`, r.status === 1 && /configured default output is a tone sink/.test(r.stderr) && !/WENT-ON/.test(r.stdout) && now().nodes.length === 0,
    `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
}

// 6. Legacy, the person chose speakers since: restore drops the file without writing.
graph({ configured: SPEAKERS, effective: SPEAKERS });
legacy(HEADSET);
r = restore();
check('6 restore leaves an output chosen since', r.status === 0 && now().configured === SPEAKERS && !fs.existsSync(STATE_FILE) && /left alone/.test(r.stdout),
  `exit ${r.status}, configured ${now().configured}, file ${fs.existsSync(STATE_FILE)}: ${r.stdout}${r.stderr}`);

// 7. A stale node with no file is refused, and the refusing run's trap does not destroy it.
for (const sink of [CONSTANT, TWIN]) {
  graph({ configured: HEADSET, effective: HEADSET, nodes: [{ id: 9, name: sink }] });
  r = pass('tone_sink_create');
  check(`7 a stale node is refused and kept (${sink})`, r.status === 1 && /already in the graph/.test(r.stderr) && now().nodes.length === 1, `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stderr}`);
}

// 8. A copy outside any repository cannot rule out a legacy record, so it changes nothing.
const loose = path.join(root, 'loose');
fs.mkdirSync(loose);
fs.copyFileSync(SOURCE, path.join(loose, 'tone-sink.sh'));
fs.copyFileSync(path.join(repo, 'scripts', 'lib', 'tone-graph.py'), path.join(loose, 'tone-graph.py'));
graph({ configured: HEADSET, effective: HEADSET });
r = pass('tone_sink_create; echo WENT-ON', path.join(loose, 'tone-sink.sh'), loose);
check('8 no git dir, no change', r.status === 1 && /could not find the repository's git dir/.test(r.stderr) && now().nodes.length === 0,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

// 9. Legacy: a write that does not take effect, and a PipeWire that cannot be read: restore keeps the
// record and the node.
graph({ configured: named(CONSTANT), effective: named(CONSTANT), nodes: [{ id: 9, name: CONSTANT }], ignoreWrites: true });
legacy(HEADSET);
r = restore();
check('9a a write that did not land fails restore', r.status === 1 && fs.existsSync(STATE_FILE) && now().nodes.length === 1 && /nothing was destroyed/.test(r.stderr),
  `exit ${r.status}, file ${fs.existsSync(STATE_FILE)}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
graph({ configured: named(CONSTANT), effective: named(CONSTANT), nodes: [{ id: 9, name: CONSTANT }], failReads: true });
legacy(HEADSET);
r = restore();
check('9b restore with PipeWire unreadable changes nothing', r.status === 1 && fs.existsSync(STATE_FILE) && now().nodes.length === 1 && now().configured === named(CONSTANT),
  `exit ${r.status}, file ${fs.existsSync(STATE_FILE)}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
flip({ failReads: false });
r = restore();
check('9c and once it answers, restore puts the headset back', r.status === 0 && now().configured === HEADSET && !fs.existsSync(STATE_FILE), `exit ${r.status}, configured ${now().configured}: ${r.stdout}${r.stderr}`);

// 10. The state is found from the script's own repository, from any working directory and from a worktree.
graph({ configured: SPEAKERS, effective: SPEAKERS });
legacy(HEADSET);
r = restore(os.tmpdir());
check('10a restore from outside the repository', r.status === 0 && !fs.existsSync(STATE_FILE), `exit ${r.status}, file ${fs.existsSync(STATE_FILE)}: ${r.stdout}${r.stderr}`);
const tree = path.join(root, 'tree');
git('worktree', 'add', '-q', tree);
graph({ configured: HEADSET, effective: HEADSET });
legacy(HEADSET);
r = pass('tone_sink_create; echo WENT-ON', path.join(tree, 'scripts', 'lib', 'tone-sink.sh'), tree);
check('10b a worktree sees the record in the common git dir', r.status === 1 && /was never put back/.test(r.stderr) && !/WENT-ON/.test(r.stdout), `exit ${r.status}: ${r.stdout}${r.stderr}`);

// 11. A split dump does not hide a stale node, from a run or from restore.
for (const sink of [CONSTANT, TWIN]) {
  graph({ configured: HEADSET, effective: HEADSET, nodes: [{ id: 9, name: sink }], splitDump: true });
  r = pass('tone_sink_create; echo WENT-ON');
  check(`11a a split dump still shows the stale node (${sink})`, r.status === 1 && /already in the graph \(node 9\)/.test(r.stderr) && !/WENT-ON/.test(r.stdout) && now().nodes.length === 1,
    `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
  r = restore();
  check(`11b and restore clears it (${sink})`, r.status === 0 && now().nodes.length === 0 && /no tone sink in the graph/.test(r.stdout), `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);
}

// 12. A graph that cannot be read at all is not an empty one.
graph({ configured: HEADSET, effective: HEADSET });
fs.writeFileSync(path.join(bin, 'pw-dump.real'), fs.readFileSync(path.join(bin, 'pw-dump')));
fs.writeFileSync(path.join(bin, 'pw-dump'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
r = pass('tone_sink_create; echo WENT-ON');
check('12a an unreadable graph refuses the run', r.status === 1 && /could not read the graph/.test(r.stderr) && now().nodes.length === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
r = restore();
check('12b and restore reports it rather than "no tone sink"', r.status === 1 && /could not read the graph/.test(r.stderr), `exit ${r.status}: ${r.stdout}${r.stderr}`);
fs.writeFileSync(path.join(bin, 'pw-dump'), fs.readFileSync(path.join(bin, 'pw-dump.real')), { mode: 0o755 });

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - tone sink: a run makes a sink of its own name and writes no default; a sink that takes the effective default, at once or later, or a read that cannot be taken, refuses the run and destroys the sink; an id reused by another node is left alone; a stale sink or a configured one of either era is refused; restore puts a legacy record back, leaves an output chosen since, fails when its write does not land, finds the state from any directory or worktree, and takes no failed read or split dump for an answer');

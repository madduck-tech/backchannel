// The tone sink's guard and repair, run against PipeWire shims. (#173)
//
// `scripts/lib/tone-sink.sh` moves the person's default output for the length of one tone press. The
// gate's adversary found three ways its repair path went wrong, each measured against shims like these:
// a refusing run that restored anyway and overwrote an output the person had chosen since, a `restore`
// that exited 0 when its write had not taken effect, and a wedge that `restore` could not clear. Before
// that, the only control for the file was one kill by hand. This holds each case.
//
// The shims keep the graph in a JSON file: the configured and effective default, and the nodes. A write
// to the configured default moves the effective one too, as WirePlumber does, unless `ignoreWrites` is
// set, which is a write that does not take effect.
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
const TONE = '{"name":"backchannel_tone_sink"}';

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
if len(a) >= 5:
    if key == 'default.configured.audio.sink' and not st.get('ignoreWrites'):
        st['configured'] = a[4]; st['effective'] = a[4]; save()
    sys.exit(0)
v = st.get('configured' if key == 'default.configured.audio.sink' else 'effective')
if v: print(f"update: id:0 key:'{key}' value:'{v}' type:'Spa:String:JSON'")
`);
shim('pw-dump', `print(json.dumps([{'id': n['id'], 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': n['name']}}} for n in st['nodes']]))`);
shim('pw-cli', `
if a[0] == 'create-node':
    st['next'] = st.get('next', 100) + 1
    st['nodes'].append({'id': st['next'], 'name': re.search(r'node\\.name=(\\S+)', a[2]).group(1)}); save()
elif a[0] == 'destroy':
    st['nodes'] = [n for n in st['nodes'] if str(n['id']) != a[1]]; save()
`);

// A repository of its own, so the state dir is found from the script's location as it is for real.
const work = path.join(root, 'repo');
fs.mkdirSync(path.join(work, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(SOURCE, path.join(work, 'scripts', 'lib', 'tone-sink.sh'));
const git = (...args) => spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' });
git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
const STATE_FILE = path.join(work, '.git', 'backchannel-tone-sink', 'original-default-sink');

let statePath;
function graph(init) {
  statePath = path.join(root, `state-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(statePath, JSON.stringify({ nodes: [], ...init }));
  fs.rmSync(path.dirname(STATE_FILE), { recursive: true, force: true });
}
const now = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_STATE: statePath });
// A pass's shape: say/die, the library sourced, an EXIT trap that calls tone_sink_destroy.
function pass(body, script = path.join(work, 'scripts', 'lib', 'tone-sink.sh'), cwd = work) {
  return spawnSync('bash', ['-c', `
say() { printf 'pass: %s\\n' "$*"; }
die() { printf 'pass: %s\\n' "$*" >&2; exit 1; }
. ${JSON.stringify(script)}
trap 'tone_sink_destroy || say "NOT put back"' EXIT
${body}`], { cwd, env: env(), encoding: 'utf8' });
}
const restore = (cwd = work, script = path.join(work, 'scripts', 'lib', 'tone-sink.sh')) =>
  spawnSync('bash', [script, 'restore'], { cwd, env: env(), encoding: 'utf8' });

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

// 1. A press that runs to the end puts everything back.
graph({ configured: HEADSET, effective: HEADSET });
let r = pass('tone_sink_create; tone_sink_make_default; tone_sink_restore');
check('1 a whole press', r.status === 0 && now().configured === HEADSET && now().nodes.length === 0 && !fs.existsSync(STATE_FILE),
  `exit ${r.status}, configured ${now().configured}, nodes ${JSON.stringify(now().nodes)}, file ${fs.existsSync(STATE_FILE)}`);

// 2. Killed after the move: the next run refuses, and its trap touches nothing; restore repairs.
graph({ configured: HEADSET, effective: HEADSET });
r = pass('tone_sink_create; tone_sink_make_default; kill -KILL $$');
check('2a the kill leaves the move', r.signal === 'SIGKILL' && now().configured === TONE && fs.existsSync(STATE_FILE), `exit ${r.status} ${r.signal}, configured ${now().configured}`);
const nodesAfterKill = JSON.stringify(now().nodes);
r = pass('tone_sink_create; echo WENT-ON');
check('2b the next run refuses', r.status === 1 && /was never put back/.test(r.stderr) && !/WENT-ON/.test(r.stdout), `exit ${r.status}: ${r.stderr}${r.stdout}`);
check('2c and its trap touches nothing', now().configured === TONE && JSON.stringify(now().nodes) === nodesAfterKill && fs.existsSync(STATE_FILE),
  `configured ${now().configured}, nodes ${JSON.stringify(now().nodes)} (were ${nodesAfterKill}), file ${fs.existsSync(STATE_FILE)}`);
r = restore();
check('2d restore puts the headset back', r.status === 0 && now().configured === HEADSET && now().nodes.length === 0 && !fs.existsSync(STATE_FILE),
  `exit ${r.status}, configured ${now().configured}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

// 3. Killed, then the person chose speakers by hand: nothing overwrites their choice.
graph({ configured: HEADSET, effective: HEADSET });
pass('tone_sink_create; tone_sink_make_default; kill -KILL $$');
const st3 = now(); st3.configured = SPEAKERS; st3.effective = SPEAKERS; fs.writeFileSync(statePath, JSON.stringify(st3));
r = pass('tone_sink_create');
check('3a a refusing run leaves the speakers', r.status === 1 && now().configured === SPEAKERS, `exit ${r.status} ${r.signal}, configured ${now().configured}`);
r = restore();
check('3b restore drops the file without writing', r.status === 0 && now().configured === SPEAKERS && !fs.existsSync(STATE_FILE) && /left alone/.test(r.stdout),
  `exit ${r.status}, configured ${now().configured}, file ${fs.existsSync(STATE_FILE)}: ${r.stdout}${r.stderr}`);

// 4. A write that does not take effect: restore fails, keeps the file and the node.
graph({ configured: HEADSET, effective: HEADSET });
pass('tone_sink_create; tone_sink_make_default; kill -KILL $$');
const st4 = now(); st4.ignoreWrites = true; fs.writeFileSync(statePath, JSON.stringify(st4));
r = restore();
check('4 a write that did not land fails restore', r.status === 1 && fs.existsSync(STATE_FILE) && now().nodes.length === 1 && /nothing was destroyed/.test(r.stderr),
  `exit ${r.status}, file ${fs.existsSync(STATE_FILE)}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

// 5. The default names the tone sink and no file says what it was: restore says so, and destroys nothing.
graph({ configured: TONE, effective: TONE, nodes: [{ id: 7, name: 'backchannel_tone_sink' }] });
r = restore();
check('5 no record of the original', r.status === 1 && /nothing records what it was/.test(r.stderr) && now().nodes.length === 1,
  `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

// 6. The state is found from the script's own repository, from any working directory and from a worktree.
graph({ configured: HEADSET, effective: HEADSET });
pass('tone_sink_create; tone_sink_make_default; kill -KILL $$');
r = restore(os.tmpdir());
check('6a restore from outside the repository', r.status === 0 && now().configured === HEADSET && !fs.existsSync(STATE_FILE), `exit ${r.status}, configured ${now().configured}: ${r.stdout}${r.stderr}`);
const tree = path.join(root, 'tree');
git('worktree', 'add', '-q', tree);
graph({ configured: HEADSET, effective: HEADSET });
pass('tone_sink_create; tone_sink_make_default; kill -KILL $$', path.join(tree, 'scripts', 'lib', 'tone-sink.sh'), tree);
check('6b a worktree keeps the state in the common git dir', fs.existsSync(STATE_FILE), `no ${STATE_FILE} after a killed run in ${tree}`);
r = restore();
check('6c and the main checkout repairs it', r.status === 0 && now().configured === HEADSET, `exit ${r.status}, configured ${now().configured}: ${r.stdout}${r.stderr}`);

// 7. A stale node with no file is refused, and the refusing run's trap does not destroy it.
graph({ configured: HEADSET, effective: HEADSET, nodes: [{ id: 9, name: 'backchannel_tone_sink' }] });
r = pass('tone_sink_create');
check('7 a stale node is refused and kept', r.status === 1 && /already in the graph/.test(r.stderr) && now().nodes.length === 1, `exit ${r.status}, nodes ${JSON.stringify(now().nodes)}: ${r.stderr}`);

// 8. A copy outside any repository has nowhere to keep the original, so it changes nothing.
const loose = path.join(root, 'loose');
fs.mkdirSync(loose);
fs.copyFileSync(SOURCE, path.join(loose, 'tone-sink.sh'));
graph({ configured: HEADSET, effective: HEADSET });
r = pass('tone_sink_create; tone_sink_make_default; echo WENT-ON', path.join(loose, 'tone-sink.sh'), loose);
check('8 no git dir, no change', r.status === 1 && /could not find the repository's git dir/.test(r.stderr) && now().configured === HEADSET && now().nodes.length === 0,
  `exit ${r.status}, configured ${now().configured}, nodes ${JSON.stringify(now().nodes)}: ${r.stdout}${r.stderr}`);

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - tone sink: a whole press puts everything back; a killed press is refused by the next run, whose trap touches nothing; restore repairs it, leaves an output the person chose since, fails when its write does not land or nothing records the original, finds the state from any directory or worktree, and changes nothing without a git dir');

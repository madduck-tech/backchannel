// `gate_sink_remove` destroys only a node this run made. (#266, the gate adversary's round 11)
//
// `scripts/lib/gate-sinks.sh` removes a sink by name. Until round 11 it destroyed every node of the name it was
// given, so a helper that sourced it could clear another run's tone sink, or a person's node, while every census
// stayed green: the `pw-cli destroy` line was a known one, and who called it was not read. Now a node whose id
// this shell's `gate_sinks_create` did not record is refused, and nothing is destroyed.
//
// The shims keep the graph in a JSON file. `pw-dump` prints its nodes with an input port each, as `tone-graph.py
// nodes` reads them, and `pw-cli destroy` removes one and logs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sinks-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env python3
import json, os, sys
S = os.environ['SHIM_STATE']
st = json.load(open(S))
a = sys.argv[1:]
${body}
`, { mode: 0o755 });
shim('pw-dump', `
objs = []
for n in st['nodes']:
    objs.append({'id': n['id'], 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': n['name']}}})
    objs.append({'id': 10000 + n['id'], 'type': 'PipeWire:Interface:Port', 'info': {'direction': 'input', 'props': {'node.id': n['id']}}})
print(json.dumps(objs))`);
shim('pw-cli', `
if a[0] == 'destroy':
    st['nodes'] = [n for n in st['nodes'] if str(n['id']) != a[1]]
    st.setdefault('destroyed', []).append(int(a[1]))
    json.dump(st, open(S, 'w'))`);
shim('pw-metadata', 'sys.exit(0)');

const B = 'backchannel_gate_sink_b';
const OTHER = 'backchannel_tone_sink_1761990000_4242';
let cell = 0;
function remove({ nodes, made, name }) {
  const state = path.join(root, `state-${++cell}.json`);
  fs.writeFileSync(state, JSON.stringify({ nodes }));
  const r = spawnSync('bash', ['-c', `
    set -u
    die() { echo "DIE: $*"; exit 3; }
    . scripts/lib/gate-sinks.sh
    GATE_SINK_IDS="$1"
    gate_sink_remove "$2"
    echo REMOVED`, 'cell', made, name], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_STATE: state },
  });
  return { out: r.stdout + r.stderr, status: r.status, destroyed: JSON.parse(fs.readFileSync(state, 'utf8')).destroyed ?? [] };
}

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

// The positive sentinel: what this run made goes.
{
  const r = remove({ nodes: [{ id: 41, name: B }], made: ' 40 41', name: B });
  check('1 a node this run made is removed', r.status === 0 && /REMOVED/.test(r.out) && r.destroyed.join() === '41', JSON.stringify(r));
}
// A node of the same name that this run did not make: another run's.
{
  const r = remove({ nodes: [{ id: 41, name: B }], made: ' 40', name: B });
  check('2 a node of the name this run did not make is refused', r.status === 3 && /not made by this run/.test(r.out) && r.destroyed.length === 0, JSON.stringify(r));
}
// Another run's tone sink, by its own name, from a shell that made nothing: round 11's helper.
{
  const r = remove({ nodes: [{ id: 101, name: OTHER }], made: '', name: OTHER });
  check('3 another run\'s tone sink is refused from a shell that made nothing', r.status === 3 && r.destroyed.length === 0, JSON.stringify(r));
}
// Two nodes of the name, one this run's: nothing is destroyed, not even its own, since the refusal comes first.
{
  const r = remove({ nodes: [{ id: 41, name: B }, { id: 77, name: B }], made: ' 41', name: B });
  check('4 a name that also holds a node not made by this run destroys nothing', r.status === 3 && r.destroyed.length === 0, JSON.stringify(r));
}

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log('ok - gate_sink_remove destroys only the nodes this run made: its own, and refuses another run\'s or a person\'s');

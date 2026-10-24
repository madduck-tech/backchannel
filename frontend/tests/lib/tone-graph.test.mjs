// The gate's reading of the PipeWire graph across the tone press, run against graphs written here. (#173)
//
// `scripts/lib/tone-graph.py` decides whether the tone that reached the sink was WebKit's and nothing
// else's. The core pass is the only thing that runs it against a real graph, and a real graph cannot be
// made to hold a foreign stream on demand. So the judgement is held here, against the shapes measured
// on 2026-10-25:
//
//   - **The binary may be on the client only.** pipewire-pulse copies `application.process.binary`
//     onto the node for PulseAudio streams; a `pw-cat` node carried it on its client alone.
//   - **"Into" is the sink's input side.** The application reading the sink's monitor is a link *out
//     of* the sink, and it is the sentinel that makes an empty sink mean something.
//   - **`pw-dump` can print two arrays** when the graph changes while it reads (one sample in 39 across
//     the first press). The second is an update, and `info: null` removes an object.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = path.join(repo, 'scripts', 'lib', 'tone-graph.py');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-graph-'));

const SINK = 50;
const node = (id, props) => ({ id, type: 'PipeWire:Interface:Node', info: { props } });
const client = (id, props) => ({ id, type: 'PipeWire:Interface:Client', info: { props } });
const link = (id, from, to) => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-node-id': from, 'input-node-id': to } });
const SINK_NODE = node(SINK, { 'node.name': 'backchannel_tone_sink' });
// The application reading the monitor: cpal's PulseAudio client sends no process binary.
const READER = [client(70, { 'application.process.binary': 'pipewire' }), node(71, { 'client.id': 70, 'client.api': 'pipewire-pulse', 'node.name': 'cpal-pulseaudio-1' }), link(72, SINK, 71)];
const WEBKIT_ON_NODE = [node(60, { 'application.process.binary': 'WebKitWebProcess', 'client.api': 'pipewire-pulse', 'node.name': 'conversationaly' }), link(61, 60, SINK)];
const WEBKIT_ON_CLIENT = [client(62, { 'application.process.binary': 'WebKitWebProcess' }), node(63, { 'client.id': 62, 'node.name': 'webkit-native' }), link(64, 63, SINK)];
const FOREIGN = [node(80, { 'application.process.binary': 'firefox', 'client.api': 'pipewire-pulse', 'node.name': 'Firefox' }), link(81, 80, SINK)];

// `watch`, with `pw-dump` replaced by a script that prints each graph in turn, then `judge`.
function judge(name, graphs) {
  const seq = path.join(dir, `${name}.graphs`);
  fs.writeFileSync(seq, JSON.stringify(graphs));
  const bin = path.join(dir, `${name}.bin`);
  fs.mkdirSync(bin);
  const counter = path.join(dir, `${name}.n`);
  fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/usr/bin/env python3
import json, os, sys
graphs = json.load(open(${JSON.stringify(seq)}))
n = int(open(${JSON.stringify(counter)}).read()) if os.path.exists(${JSON.stringify(counter)}) else 0
open(${JSON.stringify(counter)}, 'w').write(str(n + 1))
g = graphs[min(n, len(graphs) - 1)]
if g == 'fail': sys.exit(3)
sys.stdout.write(g if isinstance(g, str) else json.dumps(g))
`, { mode: 0o755 });
  const out = path.join(dir, `${name}.jsonl`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  // Stopped once every graph has been served, counted by the stub, not timed: a slow machine takes
  // fewer samples in a fixed time, and a case would then pass without its second graph being seen.
  const child = spawnSync('python3', ['-I', '-c', `
import os, signal, subprocess, sys, time
p = subprocess.Popen([sys.executable, '-I', ${JSON.stringify(TOOL)}, 'watch', '${SINK}', ${JSON.stringify(out)}])
served = lambda: int(open(${JSON.stringify(counter)}).read()) if os.path.exists(${JSON.stringify(counter)}) else 0
deadline = time.monotonic() + 30
while served() < ${graphs.length} and time.monotonic() < deadline: time.sleep(0.05)
p.send_signal(signal.SIGTERM); p.wait()
sys.exit(0 if served() >= ${graphs.length} else 4)
`], { env });
  assert.equal(child.status, 0, String(child.stderr));
  const r = spawnSync('python3', ['-I', TOOL, 'judge', out], { encoding: 'utf8' });
  return { code: r.status, line: r.stdout.trim() };
}

const cases = [
  ['webkit on its node, the monitor read', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE]], 0, /with a link from WebKitWebProcess \(binary read from its node/],
  ['webkit on its client only', [[SINK_NODE, ...READER, ...WEBKIT_ON_CLIENT]], 0, /binary read from its client; node\.name=webkit-native; missing client\.api, media\.software/],
  ['nothing entered the sink', [[SINK_NODE, ...READER]], 1, /no link entered the tone sink from WebKitWebProcess/],
  ['webkit, and another stream moved in by `follow`', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...FOREIGN]], 1, /something other than WebKitWebProcess .*firefox/],
  ['a stream with no binary anywhere is not webkit', [[SINK_NODE, ...READER, node(90, { 'node.name': 'anon' }), link(91, 90, SINK)]], 1, /something other than WebKitWebProcess .*"binary": null/],
  ['webkit, and nobody read the monitor', [[SINK_NODE, ...WEBKIT_ON_NODE]], 1, /nothing read the sink's monitor/],
  ['a sample that could not be taken', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE], 'fail'], 1, /could not be read cannot vouch/],
  ['the monitor link is not counted as into', [[SINK_NODE, ...READER, link(73, SINK, 60), node(60, { 'application.process.binary': 'WebKitWebProcess' })]], 1, /no link entered/],
  ['two arrays from one pw-dump, the second removing the foreign stream',
    [JSON.stringify([SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...FOREIGN]) + '\n' + JSON.stringify([{ id: 81, info: null }])], 0, /none from anything else/],
];

const failures = [];
for (const [name, graphs, code, line] of cases) {
  const got = judge(name.replace(/\W+/g, '-'), graphs);
  if (got.code !== code || !line.test(got.line)) failures.push(`${name}: exit ${got.code}, "${got.line}" (want ${code}, ${line})`);
}
fs.rmSync(dir, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
// Sanity: the tool is the one the pass runs.
assert.match(execFileSync('grep', ['-c', 'scripts/lib/tone-graph.py', path.join(repo, 'scripts', 'stage2-core-check.sh')], { encoding: 'utf8' }), /^[1-9]/);
console.log(`ok - tone graph: ${cases.length} graphs judged as measured; the binary is read from the node or its client, "into" is the sink's input side, the monitor read is required, and a split pw-dump is merged`);

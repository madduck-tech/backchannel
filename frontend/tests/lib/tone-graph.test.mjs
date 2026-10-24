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
//   - **Ours, not every WebKit's.** Every WebKitGTK program runs a `WebKitWebProcess`; a node counts
//     only when its `application.process.id` descends from the pass's driver. Here the root is this
//     process and `OURS` is a child it spawns, so the walk up `/proc` is what decides, as it is for
//     WebKitWebProcess and cpal under the driver (with `OURS` equal to the root, the walk never ran:
//     the adversary's round 2). Pid 1 is anybody else.
//   - **`pw-dump` can print two arrays** when the graph changes while it reads (one sample in 39 across
//     the first press). The second is an update, and `info: null` removes an object.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = path.join(repo, 'scripts', 'lib', 'tone-graph.py');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-graph-'));

const SINK = 50;
const ROOT = process.pid;
const descendant = spawn('sleep', ['120'], { stdio: 'ignore' });
const OURS = descendant.pid;
const OTHER = 1;
const node = (id, props) => ({ id, type: 'PipeWire:Interface:Node', info: { props } });
const client = (id, props) => ({ id, type: 'PipeWire:Interface:Client', info: { props } });
const link = (id, from, to, state = 'active') => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-node-id': from, 'input-node-id': to, state } });
const SINK_NODE = node(SINK, { 'node.name': 'backchannel_tone_sink' });
// The application reading the monitor: cpal's PulseAudio client sends no process binary.
// The application reading the monitor, as measured: cpal sends no process properties, so its client
// carries the PulseAudio server's binary and pid, and only the stream's name holds the application's pid.
const READER = [client(70, { 'application.process.binary': 'pipewire', 'application.process.id': OTHER }), node(71, { 'client.id': 70, 'client.api': 'pipewire-pulse', 'node.name': `cpal-pulseaudio-${OURS}` }), link(72, SINK, 71)];
const WEBKIT_ON_NODE = [node(60, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS, 'client.api': 'pipewire-pulse', 'node.name': 'conversationaly' }), link(61, 60, SINK)];
const WEBKIT_ON_CLIENT = [client(62, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS }), node(63, { 'client.id': 62, 'node.name': 'webkit-native' }), link(64, 63, SINK)];
const FOREIGN = [node(80, { 'application.process.binary': 'firefox', 'application.process.id': OTHER, 'client.api': 'pipewire-pulse', 'node.name': 'Firefox' }), link(81, 80, SINK)];
const EPIPHANY = [node(82, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OTHER, 'client.api': 'pipewire-pulse', 'node.name': 'epiphany' }), link(83, 82, SINK)];
const METER = [node(74, { 'application.process.binary': 'pavucontrol', 'application.process.id': OTHER, 'node.name': 'peak-meter' }), link(75, SINK, 74)];

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
p = subprocess.Popen([sys.executable, '-I', ${JSON.stringify(TOOL)}, 'watch', '${SINK}', '${ROOT}', ${JSON.stringify(out)}])
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
  ['webkit on its node, the monitor read', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE]], 0, /with an active link from WebKitWebProcess \(pid \d+ from its node, ours; .*binary read from its node.*the monitor was read by pipewire \(pid \d+ from its cpal stream name, ours/],
  ['webkit on its client only', [[SINK_NODE, ...READER, ...WEBKIT_ON_CLIENT]], 0, /node\.name=webkit-native\), binary read from its client; missing client\.api, media\.software/],
  ['nothing entered the sink', [[SINK_NODE, ...READER]], 1, /no active link entered the tone sink from the application's WebKitWebProcess; the monitor was read by pipewire/],
  ['webkit, and another stream moved in by `follow`', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...FOREIGN]], 1, /something other than the application's WebKitWebProcess .*firefox/],
  ['another WebKitGTK program is not the application', [[SINK_NODE, ...READER, ...EPIPHANY]], 1, /something other than .*WebKitWebProcess \(pid 1 from its node, not ours; .*epiphany/],
  ['a stream with no binary anywhere is not webkit', [[SINK_NODE, ...READER, node(90, { 'node.name': 'anon' }), link(91, 90, SINK)]], 1, /something other than .*None \(pid None from its None, not ours; node\.name=anon/],
  ['the application\'s link in error carried nothing', [[SINK_NODE, ...READER, WEBKIT_ON_NODE[0], link(61, 60, SINK, 'error')]], 1, /no active link entered .*\(its links were error\)/],
  ['webkit, and nobody read the monitor', [[SINK_NODE, ...WEBKIT_ON_NODE]], 1, /the application never read the sink's monitor.*\(read by: nobody\)/],
  ['webkit, and only someone else read the monitor', [[SINK_NODE, ...METER, ...WEBKIT_ON_NODE]], 1, /the application never read .*\(read by: pavucontrol \(pid 1 from its node, not ours/],
  ['another cpal program reading the monitor is not the application', [[SINK_NODE, client(76, { 'application.process.id': OTHER }), node(77, { 'client.id': 76, 'node.name': 'cpal-pulseaudio-1' }), link(78, SINK, 77), ...WEBKIT_ON_NODE]], 1, /the application never read .*\(read by: .*pid 1 from its cpal stream name, not ours; node\.name=cpal-pulseaudio-1/],
  ['a sample that could not be taken', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE], 'fail'], 1, /could not be read cannot vouch/],
  ['the monitor link is not counted as into', [[SINK_NODE, ...READER, link(73, SINK, 60), node(60, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS })]], 1, /no active link entered/],
  ['two arrays from one pw-dump, the second removing the foreign stream',
    [JSON.stringify([SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...FOREIGN]) + '\n' + JSON.stringify([{ id: 81, info: null }])], 0, /none from anything else/],
];

const failures = [];
for (const [name, graphs, code, line] of cases) {
  const got = judge(name.replace(/\W+/g, '-'), graphs);
  if (got.code !== code || !line.test(got.line)) failures.push(`${name}: exit ${got.code}, "${got.line}" (want ${code}, ${line})`);
}
descendant.kill();
fs.rmSync(dir, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
// Sanity: the tool is the one the pass runs.
assert.match(execFileSync('grep', ['-c', 'scripts/lib/tone-graph.py', path.join(repo, 'scripts', 'stage2-core-check.sh')], { encoding: 'utf8' }), /^[1-9]/);
console.log(`ok - tone graph: ${cases.length} graphs judged; the tone is an active link from the application's own WebKitWebProcess (pid under the driver, binary from the node or its client), "into" is the sink's input side, the application must be reading the monitor, and a split pw-dump is merged`);

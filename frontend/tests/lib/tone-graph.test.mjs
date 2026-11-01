// The gate's reading of the PipeWire graph across the tone press, run against graphs written here. (#173, #266)
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
//
//   - **The route (#266).** The tone reaches its sink by name, through GStreamer's `pulsesink`, and the
//     default output is never moved. So every graph a case judges starts with a sample taken before the
//     press, with no link into the sink; every active tone link carries `client.api=pipewire-pulse`; our
//     web process plays into nothing else; and no sample's default-output key names the sink. The probe's
//     own file, the web processes' environment and the one-node check are held here too.
//
// It must not hang (#294). On CI one run of it held the step until the job was cancelled: the stub
// truncated its counter before writing it, the wrapper read it empty, raised and died without stopping
// `watch`, and `watch` held `spawnSync`'s pipes. So the wrapper no longer reads the counter: it counts the
// lines `watch` has written, stops `watch` in a `finally` with bounded waits, and keeps `watch` off its
// pipes; Node kills a `watch` a dead wrapper left; each case's runs are bounded, failing by name; and a
// case fails unless every graph it served was sampled. The stub still writes its counter whole, though
// only the next stub, which runs after it has exited, reads it.
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
// Above the wrapper's own 30 s deadline plus `watch`'s bounded exit, so even 13 cases at the bound end
// inside #268's 480 s for one file.
const CASE_TIMEOUT_MS = 35_000;
const WATCH_EXIT_S = 2;
const ROOT = process.pid;
const descendant = spawn('sleep', ['120'], { stdio: 'ignore' });
const OURS = descendant.pid;
const OTHER = 1;
const node = (id, props) => ({ id, type: 'PipeWire:Interface:Node', info: { props } });
const client = (id, props) => ({ id, type: 'PipeWire:Interface:Client', info: { props } });
const link = (id, from, to, state = 'active') => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-node-id': from, 'input-node-id': to, state } });
const SINK_NAME = 'backchannel_tone_sink_1_1';
const SINK_NODE = node(SINK, { 'node.name': SINK_NAME });
// Taken before the press: the sink, nothing linked into it.
const IDLE = [SINK_NODE];
const meta = (key, name) => ({ id: 30, type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: [{ subject: 0, key, type: 'Spa:String:JSON', value: { name } }] });
// The application reading the monitor: cpal's PulseAudio client sends no process binary.
// The application reading the monitor, as measured: cpal sends no process properties, so its client
// carries the PulseAudio server's binary and pid, and only the stream's name holds the application's pid.
const READER = [client(70, { 'application.process.binary': 'pipewire', 'application.process.id': OTHER }), node(71, { 'client.id': 70, 'client.api': 'pipewire-pulse', 'node.name': `cpal-pulseaudio-${OURS}` }), link(72, SINK, 71)];
const WEBKIT_ON_NODE = [node(60, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS, 'client.api': 'pipewire-pulse', 'node.name': 'conversationaly' }), link(61, 60, SINK)];
const WEBKIT_ON_CLIENT = [client(62, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS }), node(63, { 'client.id': 62, 'node.name': 'webkit-native' }), link(64, 63, SINK)];
const FOREIGN = [node(80, { 'application.process.binary': 'firefox', 'application.process.id': OTHER, 'client.api': 'pipewire-pulse', 'node.name': 'Firefox' }), link(81, 80, SINK)];
const EPIPHANY = [node(82, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OTHER, 'client.api': 'pipewire-pulse', 'node.name': 'epiphany' }), link(83, 82, SINK)];
const METER = [node(74, { 'application.process.binary': 'pavucontrol', 'application.process.id': OTHER, 'node.name': 'peak-meter' }), link(75, SINK, 74)];

// `watch`, with `pw-dump` replaced by a script that prints each graph in turn, then `judge`, or `probe-judge`
// with the sink and an answer time of 0, so every sample counts as after it.
function judge(name, graphs, { probe = false, sentinel = null } = {}) {
  const seq = path.join(dir, `${name}.graphs`);
  fs.writeFileSync(seq, JSON.stringify(graphs));
  const bin = path.join(dir, `${name}.bin`);
  fs.mkdirSync(bin);
  const counter = path.join(dir, `${name}.n`);
  fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/usr/bin/env python3
import json, os, sys
graphs = json.load(open(${JSON.stringify(seq)}))
n = int(open(${JSON.stringify(counter)}).read()) if os.path.exists(${JSON.stringify(counter)}) else 0
# Whole or not at all: a reader never sees it truncated (#294).
open(${JSON.stringify(counter + '.tmp')}, 'w').write(str(n + 1))
os.replace(${JSON.stringify(counter + '.tmp')}, ${JSON.stringify(counter)})
g = graphs[min(n, len(graphs) - 1)]
if g == 'fail': sys.exit(3)
sys.stdout.write(g if isinstance(g, str) else json.dumps(g))
`, { mode: 0o755 });
  const out = path.join(dir, `${name}.jsonl`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  // Stopped once `watch` has written a line for every graph, counted in its own file, not timed: a slow
  // machine takes fewer samples in a fixed time, and a case would then pass without its second graph
  // being seen. Not the stub's counter either: the stub bumps it before it prints, so a stop on the
  // counter could kill `watch` before its last sample was written (#294's gate adversary, round 1).
  // `watch` writes to a file of its own, not to this `spawnSync`'s pipes, which a `watch` left running
  // would hold open for ever; and the wrapper stops it in a `finally`, SIGTERM included, which a second
  // SIGTERM cannot cut short.
  const child = spawnSync('python3', ['-I', '-c', `
import os, signal, subprocess, sys, time
def stop(*_): raise SystemExit(5)
signal.signal(signal.SIGTERM, stop)
def sampled():
    try:
        return open(${JSON.stringify(out)}).read().count('\\n')
    except OSError:
        return 0
p = None
try:
    with open(${JSON.stringify(out + '.log')}, 'w') as log:
        p = subprocess.Popen([sys.executable, '-I', ${JSON.stringify(TOOL)}, 'watch', '${SINK}', '${ROOT}', ${JSON.stringify(out)}${sentinel ? `, '--sentinel', '${sentinel}'` : ''}], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    deadline = time.monotonic() + 30
    while sampled() < ${graphs.length} and time.monotonic() < deadline: time.sleep(0.05)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if p is not None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=${WATCH_EXIT_S})
        except subprocess.TimeoutExpired:
            p.kill()
            try:
                p.wait(timeout=${WATCH_EXIT_S})
            except subprocess.TimeoutExpired:
                pass  # unreapable: Node's search below kills what is left
sys.exit(0 if sampled() >= ${graphs.length} else 4)
`], { env, encoding: 'utf8', timeout: CASE_TIMEOUT_MS });
  killLeftWatch(out);
  if (child.error || child.status !== 0) {
    const how = child.error ? `${child.error.code} after ${CASE_TIMEOUT_MS} ms` : child.status === null ? `was ended by ${child.signal}` : `exited ${child.status}`;
    throw new Error(`${name}: the wrapper ${how}: ${child.stderr}${tail(`${out}.log`)}`);
  }
  const r = spawnSync('python3', ['-I', TOOL, ...(probe ? ['probe-judge', out, String(SINK), '0'] : ['judge', out])], { encoding: 'utf8', timeout: CASE_TIMEOUT_MS });
  if (r.error) throw new Error(`${name}: judge ${r.error.code} after ${CASE_TIMEOUT_MS} ms`);
  const line = r.stdout.trim();
  // The positive sentinel: every graph served was sampled, so a verdict never rests on a sample missing.
  // A line it cannot read fails too, rather than leaving the sentinel nothing to compare.
  const head = /^(\d+) samples, (\d+) not taken/.exec(line);
  if (!head) throw new Error(`${name}: judge's line does not say how many samples it read: ${line || '(nothing)'}${r.stderr ? `\n  judge said: ${r.stderr.trim().slice(-600)}` : ''}`);
  const [, taken, notTaken] = head;
  if (Number(taken) + Number(notTaken) < graphs.length) throw new Error(`${name}: judge read ${taken} samples and ${notTaken} not taken, of ${graphs.length} graphs served: ${line}`);
  return { code: r.status, line };
}

/** What `watch` said, if it said anything: its traceback, when it died. */
function tail(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text ? `\n  watch said: ${text.slice(-600)}` : '';
  } catch {
    return '';
  }
}

/** A wrapper that died without its `finally` (CI's shape) leaves `watch` running: find this case's by
 *  its command line, which names the case's own output file, and kill it. */
function killLeftWatch(out) {
  const mine = `tone-graph.py\0watch\0${SINK}\0${ROOT}\0${out}`;
  for (const n of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(n)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${n}/cmdline`);
    } catch {
      continue; // gone
    }
    // As bytes: a path with a non-ASCII letter is UTF-8 there (#294's gate adversary, round 2).
    if (cmd.includes(Buffer.from(mine))) {
      try {
        process.kill(Number(n), 'SIGKILL');
      } catch {
        // gone meanwhile
      }
    }
  }
}

// The probe's and the tone's streams, as the route makes them: `client.api=pipewire-pulse` on the node.
const WEBKIT_PULSE_ON_CLIENT = [client(62, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS }), node(63, { 'client.id': 62, 'client.api': 'pipewire-pulse', 'node.name': 'webkit-native' }), link(64, 63, SINK)];
const WEBKIT_ALSA = [node(65, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS, 'client.api': 'alsa', 'node.name': 'webkit-alsa' }), link(66, 65, SINK)];
const SPEAKERS = node(40, { 'node.name': 'alsa_output.speakers', 'media.class': 'Audio/Sink' });
const WEBKIT_ELSEWHERE = [SPEAKERS, node(67, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS, 'client.api': 'pipewire-pulse', 'node.name': 'webkit-elsewhere' }), link(68, 67, 40)];

const cases = [
  ['webkit on its node, the monitor read', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE]], 0, /with an active link from WebKitWebProcess \(pid \d+ from its node, ours; .*binary read from its node.*the monitor was read by pipewire \(pid \d+ from its cpal stream name, ours/],
  // Before #266 this case passed (exit 0): the binary on the client only, and no client.api anywhere.
  ['webkit on its client only, with no client.api', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_CLIENT]], 1, /did not take the route the gate pins: client\.api is absent, not pipewire-pulse, on WebKitWebProcess \(pid \d+ from its client/],
  ['webkit on its client, client.api on its node', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_PULSE_ON_CLIENT]], 0, /client\.api=pipewire-pulse, node\.name=webkit-native\), binary read from its client; missing media\.software/],
  ['nothing entered the sink', [IDLE, [SINK_NODE, ...READER]], 1, /no active link entered the tone sink from the application's WebKitWebProcess; the monitor was read by pipewire/],
  ['webkit, and another stream moved in by `follow`', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...FOREIGN]], 1, /something other than the application's WebKitWebProcess .*firefox/],
  ['another WebKitGTK program is not the application', [IDLE, [SINK_NODE, ...READER, ...EPIPHANY]], 1, /something other than .*WebKitWebProcess \(pid 1 from its node, not ours; .*epiphany/],
  ['a stream with no binary anywhere is not webkit', [IDLE, [SINK_NODE, ...READER, node(90, { 'node.name': 'anon' }), link(91, 90, SINK)]], 1, /something other than .*None \(pid None from its None, not ours; node\.name=anon/],
  ['the application\'s link in error carried nothing', [IDLE, [SINK_NODE, ...READER, WEBKIT_ON_NODE[0], link(61, 60, SINK, 'error')]], 1, /no active link entered .*\(its links were error\)/],
  ['webkit, and nobody read the monitor', [IDLE, [SINK_NODE, ...WEBKIT_ON_NODE]], 1, /the application never read the sink's monitor.*\(read by: nobody\)/],
  ['webkit, and only someone else read the monitor', [IDLE, [SINK_NODE, ...METER, ...WEBKIT_ON_NODE]], 1, /the application never read .*\(read by: pavucontrol \(pid 1 from its node, not ours/],
  ['another cpal program reading the monitor is not the application', [IDLE, [SINK_NODE, client(76, { 'application.process.id': OTHER }), node(77, { 'client.id': 76, 'node.name': 'cpal-pulseaudio-1' }), link(78, SINK, 77), ...WEBKIT_ON_NODE]], 1, /the application never read .*\(read by: .*pid 1 from its cpal stream name, not ours; node\.name=cpal-pulseaudio-1/],
  ['a sample that could not be taken', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE], 'fail'], 1, /could not be read cannot vouch/],
  ['the monitor link is not counted as into', [IDLE, [SINK_NODE, ...READER, link(73, SINK, 60), node(60, { 'application.process.binary': 'WebKitWebProcess', 'application.process.id': OURS })]], 1, /no active link entered/],
  ['two arrays from one pw-dump, the second removing the foreign stream',
    [IDLE, JSON.stringify([SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...FOREIGN]) + '\n' + JSON.stringify([{ id: 81, info: null }])], 0, /none from anything else/],
  // #266 item 2: the default output is never moved.
  ['the configured default output names the tone sink', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, meta('default.configured.audio.sink', SINK_NAME)]], 1, /default\.configured\.audio\.sink names the tone sink \(backchannel_tone_sink_1_1\): the default output moved/],
  ['the effective default output names the tone sink', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, meta('default.audio.sink', SINK_NAME)]], 1, /default\.audio\.sink names the tone sink \(backchannel_tone_sink_1_1\): the default output moved/],
  ['a default naming another output is not the tone sink', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, meta('default.audio.sink', 'alsa_output.speakers')]], 0, /none from anything else/],
  // #266 item 4: the tone's file.
  ['a link in the first sample', [[SINK_NODE, ...READER, ...WEBKIT_ON_NODE]], 1, /the first sample, taken before the press, already held a link into the tone sink: WebKitWebProcess/],
  ['a link from our web process into another node', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...WEBKIT_ELSEWHERE]], 1, /WebKitWebProcess played into alsa_output\.speakers \(node 40\), not only the tone sink/],
  ['two tone links, the later through alsa', [IDLE, [SINK_NODE, ...READER, ...WEBKIT_ON_NODE], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...WEBKIT_ALSA]], 1, /did not take the route the gate pins: client\.api is alsa, not pipewire-pulse/],
];

// The probe's own file (#266 item 4): the probe's stream enters the tone sink through `pulsesink`, from our
// web process alone and into nothing else, and is gone by the last sample.
const probeCases = [
  ['the probe: the route, then closed', [[SINK_NODE, ...WEBKIT_ON_NODE], IDLE], 0, /with an active link from WebKitWebProcess .* into the tone sink and none elsewhere; none left/],
  ['the probe: no link', [IDLE, IDLE], 1, /no active link from the application's WebKitWebProcess entered the tone sink/],
  ['the probe: a link not ours', [[SINK_NODE, ...EPIPHANY], IDLE], 1, /a link into the tone sink that is not ours: WebKitWebProcess \(pid 1/],
  ['the probe: client.api absent', [[SINK_NODE, ...WEBKIT_ON_CLIENT], IDLE], 1, /did not take the route the gate pins: client\.api is absent/],
  ['the probe: client.api=alsa', [[SINK_NODE, ...WEBKIT_ALSA], IDLE], 1, /did not take the route the gate pins: client\.api is alsa/],
  // With the route's own link beside it, so only the other-node rule can refuse it.
  ['the probe: a link into another node', [[SINK_NODE, ...WEBKIT_ON_NODE, ...WEBKIT_ELSEWHERE], IDLE], 1, /the probe's stream went into alsa_output\.speakers \(node 40\), not the tone sink/],
  ['the probe: a link still there at the deadline', [[SINK_NODE, ...WEBKIT_ON_NODE], [SINK_NODE, ...WEBKIT_ON_NODE]], 1, /was still there at the deadline/],
  ['the probe: the default moved', [[SINK_NODE, ...WEBKIT_ON_NODE, meta('default.audio.sink', SINK_NAME)], IDLE], 1, /default\.audio\.sink names the tone sink/],
];

// #266 item 5: a stream that follows the default, kept on a sink other than the tone sink, alive.
const SENT = spawn('sleep', ['120'], { stdio: 'ignore' });
const sentStream = (into) => [SPEAKERS, node(95, { 'application.process.id': SENT.pid, 'node.name': 'pw-play' }), link(96, 95, into)];
const sentinelCases = [
  ['the sentinel stays on the speakers', [[SINK_NODE, ...sentStream(40)], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, ...sentStream(40)]], 0, /none from anything else/],
  ['the sentinel moved into the tone sink', [[SINK_NODE, ...sentStream(40)], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, SPEAKERS, node(95, { 'application.process.id': SENT.pid, 'node.name': 'pw-play' }), link(97, 95, SINK)]], 1, /(the sentinel stream was linked into the tone sink|something other than)/],
  ['the sentinel with no link', [[SINK_NODE, ...sentStream(40)], [SINK_NODE, ...READER, ...WEBKIT_ON_NODE, node(95, { 'application.process.id': SENT.pid, 'node.name': 'pw-play' })]], 1, /the sentinel stream had no active link into any sink/],
];

const failures = [];

// #266 item 4, before the press: every WebKitWebProcess under the driver carries this run's PULSE_SINK and
// the pin. Each process is spawned under this test, which stands for the driver: a copy of a binary named
// `WebKitWebProcess`, or a process that made itself non-dumpable, so that only its `comm` names it.
const PIN = /^TONE_GST_PIN=(\S+)$/m.exec(fs.readFileSync(path.join(repo, 'scripts', 'lib', 'tone-sink.sh'), 'utf8'))?.[1];
const sleepFor = (ms) => spawnSync('sleep', [String(ms / 1000)]);
function webenvCases() {
  const fake = path.join(dir, 'webkit-bin');
  fs.mkdirSync(fake, { recursive: true });
  const WEB = path.join(fake, 'WebKitWebProcess');
  fs.copyFileSync('/usr/bin/sleep', WEB); fs.chmodSync(WEB, 0o755);
  const NONDUMP = `import ctypes, time
libc = ctypes.CDLL(None)
libc.prctl(15, b'WebKitWebProces', 0, 0, 0)  # PR_SET_NAME
libc.prctl(4, 0, 0, 0, 0)                    # PR_SET_DUMPABLE
time.sleep(60)`;
  const good = { PULSE_SINK: SINK_NAME, GST_PLUGIN_FEATURE_RANK: PIN };
  const list = [
    ['webenv: no web process', [], 1, /no WebKitWebProcess runs under the driver/],
    ['webenv: one without the variable', [[WEB, { GST_PLUGIN_FEATURE_RANK: PIN }]], 1, /has PULSE_SINK=<unset>, not backchannel_tone_sink_1_1/],
    ['webenv: a pin that is not the pin', [[WEB, { PULSE_SINK: SINK_NAME, GST_PLUGIN_FEATURE_RANK: 'alsasink:NONE' }]], 1, /has GST_PLUGIN_FEATURE_RANK=alsasink:NONE, not the pin/],
    ['webenv: the name the old stack held', [[WEB, { PULSE_SINK: 'backchannel_tone_sink', GST_PLUGIN_FEATURE_RANK: PIN }]], 1, /has PULSE_SINK=backchannel_tone_sink, not backchannel_tone_sink_1_1/],
    ['webenv: non-dumpable, found by its comm', [['python3', good, ['-I', '-c', NONDUMP]]], 1, /\(found by its comm\): its environ cannot be read/],
    ['webenv: one, as the route needs it', [[WEB, good]], 0, /^1 WebKitWebProcess under the driver, each with PULSE_SINK=backchannel_tone_sink_1_1 and the pin \(found by exe: 1, by comm: 0\)/],
  ];
  check('webenv: the pin is read from tone-sink.sh', !!PIN, 'no TONE_GST_PIN= line in tone-sink.sh');
  for (const [name, procs, code, line] of list) {
    const kids = procs.map(([bin, env, args]) => spawn(bin, args ?? ['60'], { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' }));
    try {
      sleepFor(300);
      const r = spawnSync('python3', ['-I', TOOL, 'webenv', String(ROOT), SINK_NAME, PIN ?? ''], { encoding: 'utf8', timeout: CASE_TIMEOUT_MS });
      const got = (r.stdout + r.stderr).trim();
      if (r.status !== code || !line.test(got)) failures.push(`${name}: exit ${r.status}, "${got}" (want ${code}, ${line})`);
    } finally {
      for (const k of kids) k.kill('SIGKILL');
    }
  }
}

// One node of the family, this run's: no node, two, or another id each refuse.
function oneSinkCases() {
  const bin = path.join(dir, 'one-sink.bin');
  fs.mkdirSync(bin, { recursive: true });
  const list = [
    ['one-sink: no node', [], 1, /no node of the backchannel_tone_sink family is in the graph/],
    ['one-sink: two nodes', [SINK_NODE, node(51, { 'node.name': 'backchannel_tone_sink' })], 1, /2 nodes of the backchannel_tone_sink family are in the graph/],
    ['one-sink: another id', [node(51, { 'node.name': SINK_NAME })], 1, /the backchannel_tone_sink node in the graph is 51 named backchannel_tone_sink_1_1, not this run's 50/],
    ['one-sink: this run\'s', [SINK_NODE, node(52, { 'node.name': 'alsa_output.speakers' })], 0, /one node of the family, 50, named backchannel_tone_sink_1_1/],
  ];
  for (const [name, graph, code, line] of list) {
    fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/bin/sh\ncat <<'X'\n${JSON.stringify(graph)}\nX\n`, { mode: 0o755 });
    const r = spawnSync('python3', ['-I', TOOL, 'one-sink', 'backchannel_tone_sink', String(SINK), SINK_NAME], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: CASE_TIMEOUT_MS });
    const got = (r.stdout + r.stderr).trim();
    if (r.status !== code || !line.test(got)) failures.push(`${name}: exit ${r.status}, "${got}" (want ${code}, ${line})`);
  }
}
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
try {
  const run = (list, opts) => {
    for (const [name, graphs, code, line] of list) {
      let got;
      try {
        got = judge(name.replace(/\W+/g, '-'), graphs, opts);
      } catch (e) {
        failures.push(e.message);
        continue;
      }
      if (got.code !== code || !line.test(got.line)) failures.push(`${name}: exit ${got.code}, "${got.line}" (want ${code}, ${line})`);
    }
  };
  run(cases);
  run(probeCases, { probe: true });
  run(sentinelCases, { sentinel: SENT.pid });
  webenvCases();
  oneSinkCases();
} finally {
  descendant.kill();
  SENT.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
// Sanity: the tool is the one the pass runs.
assert.match(execFileSync('grep', ['-c', 'scripts/lib/tone-graph.py', path.join(repo, 'scripts', 'stage2-core-check.sh')], { encoding: 'utf8' }), /^[1-9]/);
console.log(`ok - tone graph: ${cases.length + probeCases.length + sentinelCases.length} files judged, 6 web-process environments and 4 one-node graphs read; the tone is an active link from the application's own WebKitWebProcess (pid under the driver, binary from the node or its client), "into" is the sink's input side, the application must be reading the monitor, and a split pw-dump is merged`);

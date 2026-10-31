// The instrument behind #293's item 2, held to its own claims. (#293)
//
// `scripts/lib/capture-graph.py check` is what says, per sample of a gate entry, that a capture following
// the default stayed on the person's own microphone and that the application captured only the harness and
// the entry's system device. A check that cannot go red on the defect proves nothing about the change, and
// its first version could: a recording that never linked the harness passed on the audio check's link
// alone, and another run's source passed as this run's. Each case below is one sample file, built here,
// and the verdict `check` gives it. The graph reader is held too: a split `pw-dump` is one graph with its
// metadata kept, and a pid file older than the watch is not the pass's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GRAPH = path.join(repo, 'scripts', 'lib', 'capture-graph.py');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-graph-'));

const MIC = 'alsa_input.builtin';
const SRC = 'backchannel_harness_src_1793470000_4242';
const SINK = 'backchannel_harness_sink';
const APP = 'cpal-pulseaudio-31337';
const row = (t, patch = {}) => ({
  t, 'default.configured.audio.source': 'bluez_input.headset', 'default.audio.source': MIC, 'default.audio.sink': 'alsa_output.speakers',
  recorder_from: [MIC, MIC], app_links: [], foreign: [], ...patch,
});
// An entry as it should look: idle, the audio check (harness alone), the recording (harness and system).
const good = () => [
  row(0), row(1),
  row(2, { app_links: [{ into: APP, from: SRC }] }),
  row(3, { app_links: [{ into: APP, from: SRC }, { into: APP, from: SINK }] }),
  row(4, { app_links: [{ into: APP, from: SRC }, { into: APP, from: SINK }] }),
  row(5),
];
function check(rows, ...args) {
  const p = path.join(root, `g-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = spawnSync('python3', ['-I', GRAPH, 'check', p, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}
const CORE = ['--system', SINK, '--system', 'backchannel_tone_sink*', '--recording'];
const failures = [];
const held = (name, r) => { if (r.status !== 0 || !/^HELD: /m.test(r.out)) failures.push(`${name}: wanted HELD, got exit ${r.status}: ${r.out.trim()}`); };
const broken = (name, r, why) => { if (r.status !== 1 || !why.test(r.out)) failures.push(`${name}: wanted BROKEN matching ${why}, got exit ${r.status}: ${r.out.trim()}`); };
const at = (rows, i, patch) => { rows[i] = { ...rows[i], ...patch }; return rows; };

held('1 a correct entry', check(good(), ...CORE));
broken('2 the recorder moved to the harness', check(at(good(), 3, { recorder_from: [SRC] }), ...CORE), /recorder is linked from \['backchannel_harness_src_1793470000_4242'\], not the effective default/);
broken('3 the recorder on something other than the effective default', check(at(good(), 1, { recorder_from: ['alsa_input.usb'] }), ...CORE), /not the effective default alsa_input\.builtin/);
broken('4 the effective default names a harness node', check(at(good(), 2, { 'default.audio.source': SRC, recorder_from: [SRC] }), ...CORE), /default\.audio\.source names a harness node/);
broken('5 the configured default names a harness node', check(at(good(), 2, { 'default.configured.audio.source': 'backchannel_harness_src' }), ...CORE), /default\.configured\.audio\.source names a harness node/);
broken('6 the application captured the person\'s microphone', check(at(good(), 4, { app_links: [{ into: APP, from: SRC }, { into: APP, from: MIC }] }), ...CORE), /is linked from alsa_input\.builtin, neither/);
broken('7 the harness never linked', check(good().map((r) => ({ ...r, app_links: r.app_links.filter((l) => l.from !== SRC) })), ...CORE), /no sample of 6 links the harness source/);
broken('8 two harness sources', check(at(good(), 4, { app_links: [{ into: APP, from: 'backchannel_harness_src_1793479999_1' }, { into: APP, from: SINK }] }), ...CORE), /linked from 2 harness sources/);
const checkOnly = () => good().map((r) => ({ ...r, app_links: r.app_links.filter((l) => l.from === SRC) }));
broken('9 a recording that never took the harness with the system device', check(checkOnly(), ...CORE), /no sample links the harness source and a system device at once/);
held('9b and without --recording the audio check alone holds', check(checkOnly(), '--system', SINK));
broken('10 an unreadable sample', check([...good(), { t: 6, error: "JSONDecodeError('x')" }], ...CORE), /unreadable sample/);
broken('11 a stop', check([...good(), { t: 6, stopped: 'a foreign capture appeared', foreign: [{ node: 99, name: 'Chromium input' }] }], ...CORE), /the pass was stopped/);
broken('12 no samples', check([], ...CORE), /no samples/);
const record = () => good().map((r) => ({ ...r, app_links: r.app_links.map((l) => (l.from === SINK ? { ...l, from: 'alsa_output.speakers' } : l)) }));
held('13 the record pass\'s system side is the default sink of that sample', check(record(), '--system-default-sink', '--recording'));
broken('13b a sink that is not the sample\'s default', check(at(record(), 3, { 'default.audio.sink': 'alsa_output.hdmi' }), '--system-default-sink', '--recording'), /is linked from alsa_output\.speakers, neither/);
broken('20 a node read as ended for longer than an exit takes', check(good().map((r) => ({ ...r, ended: [{ node: 77, name: 'Firefox', pid: 160, binary: 'firefox' }] })), ...CORE), /node 77 \(Firefox, pid 160\) was read as ended for 5\.00 s/);
held('20b one read as ended for a moment', check(at(at(good(), 2, { ended: [{ node: 77, name: 'pw-cat', pid: 160 }] }), 3, { ended: [{ node: 77, name: 'pw-cat', pid: 160 }] }), ...CORE));
broken('21 the pass\'s own capture on the person\'s microphone', check(at(good(), 1, { pass_links: [{ into: 'pw-cat', from: MIC }] }), ...CORE), /the pass's own capture pw-cat is linked from alsa_input\.builtin/);
held('21b and on the harness source', check(at(good(), 1, { pass_links: [{ into: 'pw-cat', from: SRC }] }), ...CORE));
held('14 the tone sink by its prefix', check(at(good(), 4, { app_links: [{ into: APP, from: SRC }, { into: APP, from: 'backchannel_tone_sink_17_9' }] }), ...CORE));

// The reader: a split dump is one graph, removals apply, and the metadata is kept.
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const node = (id, name) => ({ id, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': name, 'media.class': 'Audio/Source', 'node.description': 'Backchannel' } } });
const meta = { id: 40, type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: [{ subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: { name: MIC } }] };
fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/bin/sh\ncat <<'X'\n${JSON.stringify([meta, node(41, MIC), node(42, 'gone')])}\n${JSON.stringify([node(43, SRC), { id: 42, info: null }])}\nX\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
let r = spawnSync('python3', ['-I', GRAPH, 'nodes'], { env, encoding: 'utf8' });
const names = r.stdout.trim().split('\n').map((l) => l.split('\t')[1]);
if (r.status !== 0 || JSON.stringify(names.sort()) !== JSON.stringify([MIC, SRC].sort())) failures.push(`15 a split dump is not read as one graph: exit ${r.status}, nodes ${JSON.stringify(names)}: ${r.stderr}`);
const py = (code) => spawnSync('python3', ['-I', '-c', `import importlib.util, json, sys, time\ns = importlib.util.spec_from_file_location('cg', ${JSON.stringify(GRAPH)}); cg = importlib.util.module_from_spec(s); s.loader.exec_module(cg)\n${code}`], { env, encoding: 'utf8' });
r = py('print(json.dumps(cg.defaults(cg.dump())))');
if (r.status !== 0 || JSON.parse(r.stdout || '{}')['default.audio.source'] !== MIC) failures.push(`16 the metadata did not survive the reader: exit ${r.status}: ${r.stdout}${r.stderr}`);
fs.writeFileSync(path.join(bin, 'pw-dump'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
r = spawnSync('python3', ['-I', GRAPH, 'nodes'], { env, encoding: 'utf8' });
if (r.status === 0) failures.push(`17 an unreadable graph read as an empty one: exit ${r.status}, '${r.stdout}'`);

// A pid file written before the watch began names a group that may belong to anyone by now.
const pids = path.join(root, 'pids');
fs.mkdirSync(pids);
fs.writeFileSync(path.join(pids, 'old.pid'), '111');
fs.utimesSync(path.join(pids, 'old.pid'), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
fs.writeFileSync(path.join(pids, 'new.pid'), '222');
r = py(`print(json.dumps(sorted(cg.pass_pgids(${JSON.stringify(path.join(pids, '*.pid'))}, time.time() - 60))))`);
if (r.status !== 0 || r.stdout.trim() !== '[222]') failures.push(`18 a stale pid file was taken for the pass's: exit ${r.status}, ${r.stdout.trim()} ${r.stderr}`);

// A capture whose process has exited is ended, not foreign; one whose process lives is foreign.
const live = spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim();
const passRoot = spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim();
const dead = String(spawnSync('true').pid);
const input = (id, pid) => ({ id, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': `cap-${id}`, 'media.class': 'Stream/Input/Audio', 'application.process.id': pid } } });
fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/bin/sh\ncat <<'X'\n${JSON.stringify([meta, input(50, dead), input(51, live)])}\nX\n`, { mode: 0o755 });
r = py(`rec = cg.sample(1, ${passRoot}, None); print(json.dumps([[x['pid'] for x in rec['ended']], [x['pid'] for x in rec['foreign']]]))`);
// ... for a moment: past the grace, a pid that is not on the host is foreign, as a sandboxed browser's is.
const late = py(`rec = cg.sample(1, ${passRoot}, None, 0.0, {50: time.monotonic() - 5}); print(json.dumps([[x['pid'] for x in rec['ended']], [x['pid'] for x in rec['foreign']]]))`);
const [lateEnded, lateForeign] = late.status === 0 ? JSON.parse(late.stdout) : [null, []];
if (late.status !== 0 || lateEnded.length || JSON.stringify([...lateForeign].sort()) !== JSON.stringify([Number(dead), Number(live)].sort())) {
  failures.push(`19b a pid not on the host stayed ended past the grace: exit ${late.status}, [ended, foreign] = ${late.stdout.trim()} ${late.stderr}`);
}
if (r.status !== 0 || JSON.stringify(JSON.parse(r.stdout || 'null')) !== JSON.stringify([[Number(dead)], [Number(live)]])) failures.push(`19 an exited capture is not told from a live foreign one: exit ${r.status}, [ended, foreign] = ${r.stdout.trim()} (dead ${dead}, live ${live}) ${r.stderr}`);
for (const pid of [live, passRoot]) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - capture-graph check: holds a correct entry; breaks on a recorder off the effective default, a default naming a harness node, an application link from anything but the harness source or the entry\'s system device, no harness link, two harness sources, a recording that never took the harness with a system device, an unreadable sample, a stop or no samples; reads a split dump as one graph with its metadata, fails on an unreadable one, ignores pid files older than the watch, tells an exited capture from a live foreign one for a moment and no longer, and breaks on a node ended for longer or on a probe of the pass linked from anything but a harness node');

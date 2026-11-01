// The harness guard fails closed, one condition at a time. (#293)
//
// `scripts/lib/harness-guard.sh` is what stops a pass that would record the wrong microphone, or that
// moved the person's default input. The log alone cannot say which device opened: first run's audio check
// writes `Creating microphone stream: Backchannel` 24 s before any Start (measured in a kept core
// profile), and the log names only the device asked for. So the guard reads the log after the start's own
// line, and then the graph, for a link from this run's harness source into the application.
//
// Each case below breaks one condition of an input the guard accepts, and requires the guard to refuse it
// with that condition's own message, so a case cannot pass by failing for another reason. The shims keep
// the graph in a JSON file: the effective default input, the nodes, and the links. With `splitDump`,
// `pw-dump` prints the graph and then a second, empty array. Of the 8 split reads in 696 on 2026-10-31, 6
// began with the graph and 2 with a 44-character array, a removal record by its length; what followed
// either was not kept.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARD = path.join(repo, 'scripts', 'lib', 'harness-guard.sh');
// Under /tmp/backchannel-*, because that is the only place the guard will remove recordings from.
const root = fs.mkdtempSync('/tmp/backchannel-guard-test-');
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env python3
import json, os, sys
st = json.load(open(os.environ['SHIM_STATE']))
a = sys.argv[1:]
${body}
`, { mode: 0o755 });
shim('pw-metadata', `
if a[-1] == 'default.audio.source' and st.get('effective'):
    print("update: id:0 key:'default.audio.source' value:'" + json.dumps({'name': st['effective']}) + "' type:'Spa:String:JSON'")
`);
shim('pw-dump', `
out = [{'id': n['id'], 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': n['name'], 'media.class': n['class'], 'node.description': n.get('desc', '')}}} for n in st['nodes']]
out += [{'id': 900 + i, 'type': 'PipeWire:Interface:Link', 'info': {'output-node-id': l[0], 'input-node-id': l[1], 'state': l[2] if len(l) > 2 else 'active'}} for i, l in enumerate(st['links'])]
print(json.dumps(out))
if st.get('splitDump'): print('[]')
`);

const SRC = 'backchannel_harness_src_1793470000_4242';
const BUILTIN = 'alsa_input.pci-0000_00_1f.3.analog-stereo';
const DESC = 'Backchannel';
const SEED = `${DESC} (input)`;
// The application's capture carries this process's pid, so "a capture under <root-pid>" can be asked of a
// root it descends from (this process) and of one it does not (a child of it).
const APP = `cpal-pulseaudio-${process.pid}`;
const graph = (patch = {}) => ({
  effective: BUILTIN,
  nodes: [
    { id: 41, name: BUILTIN, class: 'Audio/Source', desc: 'Built-in Audio Analog Stereo' },
    { id: 42, name: SRC, class: 'Audio/Source', desc: DESC },
    { id: 43, name: 'backchannel_harness_sink', class: 'Audio/Sink', desc: DESC },
    { id: 50, name: APP, class: 'Stream/Input/Audio' },
  ],
  links: [[42, 50]],
  ...patch,
});
const prefs = (mic) => {
  const p = path.join(root, `prefs-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ preferences: { save_folder: '/x', preferred_mic_device: mic, preferred_system_device: null } }));
  return p;
};
// The log as the application writes it: the audio check's lines, then a start's.
const CHECK = ["🎤 Creating microphone stream: Backchannel (always uses CPAL)", '✅ Microphone stream created successfully'];
const START = [
  '🚀 CALLED start_recording_with_devices_and_meeting - Meeting: Some("x")',
  "✅ Using microphone: 'Backchannel'",
  '🎤 Creating microphone stream: Backchannel (always uses CPAL)',
  '✅ Microphone stream created successfully',
];
const logOf = (start) => {
  const p = path.join(root, `log-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, [...CHECK, ...start].join('\n') + '\n');
  return { p, from: CHECK.length + 1 };
};

function run(state, body) {
  const s = path.join(root, `state-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(s, JSON.stringify(state));
  return spawnSync('bash', ['-c', `set -uo pipefail; . ${JSON.stringify(GUARD)}\n${body}`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_STATE: s },
    encoding: 'utf8',
    timeout: 30_000,
  });
}
const q = JSON.stringify;
const afterUp = (state, before) => run(state, `harness_guard_after_up ${q(before)}`);
const beforeStart = (state, p, src = SRC) => run(state, `harness_guard_before_start ${q(p)} ${q(SEED)} ${q(src)}`);
const afterStart = (state, log, secs = 1, root = '') => run(state, `harness_guard_after_start ${q(log.p)} ${log.from} ${q(DESC)} ${q(SRC)} ${secs} ${root}`);

const failures = [];
const accepts = (name, r) => { if (r.status !== 0) failures.push(`${name}: refused an input it must accept (exit ${r.status}): ${r.stderr}`); };
const refuses = (name, r, why) => {
  if (r.status === 0 || !why.test(r.stderr)) failures.push(`${name}: wanted a refusal matching ${why}, got exit ${r.status}: ${r.stderr.trim() || '<nothing on stderr>'}`);
};

// What each check accepts, so every refusal below is a change of one condition.
const read = run(graph(), 'harness_effective_source');
if (read.stdout.trim() !== BUILTIN) failures.push(`the effective source reads '${read.stdout.trim()}', not ${BUILTIN}`);
accepts('after up', afterUp(graph(), BUILTIN));
accepts('before Start', beforeStart(graph(), prefs(SEED)));
accepts('after Start', afterStart(graph(), logOf(START)));

// After `up`.
refuses('1 the default moved', afterUp(graph({ effective: SRC }), BUILTIN), /moved across 'up', from '.*' to 'backchannel_harness_src_/);
refuses('2 an empty read', afterUp(graph({ effective: '' }), BUILTIN), /could not be read/);

// Before Start.
refuses('3 the stored microphone changed', beforeStart(graph(), prefs(null)), /the stored microphone is '', not the seed/);
refuses('4 a second Backchannel source', beforeStart(graph({ nodes: [...graph().nodes, { id: 44, name: 'backchannel_harness_src', class: 'Audio/Source', desc: DESC }] }), prefs(SEED)),
  /2 Audio\/Source nodes carry the seed's description/);
refuses('8 the one Backchannel source is not this run\'s', beforeStart(graph(), prefs(SEED), 'backchannel_harness_src_1793479999_1'),
  /is '.*_4242', not this run's harness source/);

// After Start.
refuses('5 the microphone line only before the offset', afterStart(graph(), logOf(START.filter((l) => !l.includes('Creating microphone stream')))),
  /no 'Creating microphone stream: Backchannel' after the start/);
refuses('6 another microphone used', afterStart(graph(), logOf([...START, "✅ Using microphone: 'Built-in Audio Analog Stereo'"])),
  /the start used another microphone: Using microphone: 'Built-in Audio Analog Stereo'/);
refuses('7 no link from the harness source', afterStart(graph({ links: [[41, 50]] }), logOf(START)), /no link from '.*_4242' into the application within 1s/);
refuses('9 the start failed on its microphone',
  afterStart(graph(), logOf([...START, "Failed to start recording: The microphone 'Backchannel (input)' is not available: gone"])),
  /the start failed on its microphone: The microphone 'Backchannel \(input\)' is not available/);
refuses('10 no stream created after the offset', afterStart(graph(), logOf(START.filter((l) => !l.includes('created successfully')))),
  /no 'Microphone stream created successfully' after the start/);
refuses('11 no Using microphone line for the harness', afterStart(graph(), logOf(START.filter((l) => !l.includes('Using microphone')))),
  /no 'Using microphone: 'Backchannel'' after the start/);

// A split dump is one graph, before Start and after it.
accepts('13 before Start, a split dump', beforeStart(graph({ splitDump: true }), prefs(SEED)));
accepts('14 after Start, a split dump', afterStart(graph({ splitDump: true }), logOf(START)));

// 15. A root pid narrows the link to the application's own capture.
accepts('15a a capture under the root pid', afterStart(graph(), logOf(START), 1, process.pid));
const stranger = spawnSync('bash', ['-c', 'sleep 30 & echo $!'], { encoding: 'utf8' }).stdout.trim();
refuses('15b a capture of another process', afterStart(graph(), logOf(START), 1, stranger), new RegExp(`no link from '.*_4242' into the application under pid ${stranger} within 1s`));
try { process.kill(Number(stranger), 'SIGTERM'); } catch { /* gone */ }

// 16. A link that is not active carries nothing, so it does not show the harness opened.
refuses('16 a link still negotiating', afterStart(graph({ links: [[42, 50, 'negotiating']] }), logOf(START)), /no link from '.*_4242' into the application within 1s/);

// 12. A failure after Start removes the recordings before the profile is kept, wherever the application
// saves them, and never outside a gate profile. Both passes call it on that failure: the census in
// `the-harness-is-never-the-default-input.test.mjs` holds the wiring (6d, 6h).
const profile = path.join(root, 'profile');
const saved = ['rec', 'home/Documents/backchannel-recordings', 'home/backchannel-recordings'];
for (const d of saved) { fs.mkdirSync(path.join(profile, d), { recursive: true }); fs.writeFileSync(path.join(profile, d, 'audio.mp4'), 'x'); }
const DATA = 'home/.local/share/tech.madduck.backchannel';
const db = ['meeting_minutes.sqlite', 'meeting_minutes.sqlite-wal', 'meeting_minutes.sqlite-shm'].map((f) => `${DATA}/${f}`);
fs.mkdirSync(path.join(profile, DATA, 'logs'), { recursive: true });
for (const f of db) fs.writeFileSync(path.join(profile, f), 'transcripts');
fs.writeFileSync(path.join(profile, DATA, 'logs', 'backchannel.log'), 'evidence');
saved.push(...db);
fs.writeFileSync(path.join(profile, 'stdout.log'), 'evidence');
let r = run(graph(), `harness_guard_drop_recordings ${q(profile)}`);
const left = saved.filter((d) => fs.existsSync(path.join(profile, d)));
if (r.status !== 0 || left.length || !fs.existsSync(path.join(profile, 'stdout.log')) || !fs.existsSync(path.join(profile, DATA, 'logs', 'backchannel.log'))) {
  failures.push(`12a the recordings were not all removed, or the log went with them: exit ${r.status}, left ${JSON.stringify(left)}, log ${fs.existsSync(path.join(profile, 'stdout.log'))}: ${r.stderr}`);
}
// A path that climbs out of the profile is refused; the climb lands in this test's own directory.
fs.mkdirSync(path.join(root, 'sub'));
fs.mkdirSync(path.join(root, 'rec'));
// Concatenated, not `path.join`, which would normalise the climb away.
r = run(graph(), `harness_guard_drop_recordings ${q(`${root}/sub/..`)}`);
if (r.status === 0 || !fs.existsSync(path.join(root, 'rec'))) failures.push(`12e a climbing profile path was not refused: exit ${r.status}, rec ${fs.existsSync(path.join(root, 'rec'))}`);
const outside = fs.mkdtempSync('/tmp/guard-outside-');
fs.mkdirSync(path.join(outside, 'rec'));
r = run(graph(), `harness_guard_drop_recordings ${q(outside)}`);
if (r.status === 0 || !fs.existsSync(path.join(outside, 'rec'))) failures.push(`12b removed recordings outside a gate profile: exit ${r.status}`);
fs.rmSync(outside, { recursive: true, force: true });
// 17. The record pass's own exit path, run as the pass runs it, under `set -euo pipefail`: a failure after
// Start stops the application's group and drops the recordings, whether the group is still there or has
// already gone (round 3: a KILL that found nothing ended the trap there, before the drop).
const REC_SRC = fs.readFileSync(path.join(repo, 'scripts', 'stage2-record-check.sh'), 'utf8');
const onExit = REC_SRC.slice(REC_SRC.indexOf('on_exit() {'), REC_SRC.indexOf('\n}\n', REC_SRC.indexOf('on_exit() {')) + 3);
// The traps the pass sets, as it sets them: every `trap` line right after the function.
const recTraps = REC_SRC.slice(REC_SRC.indexOf('\n}\n', REC_SRC.indexOf('on_exit() {')) + 3).split('\n');
const traps = recTraps.slice(0, recTraps.findIndex((l) => !/^trap /.test(l))).join('\n');
for (const [id, alive] of [['17a', false], ['17b', true]]) {
  const prof = path.join(root, `rec-${id}`);
  fs.mkdirSync(path.join(prof, 'rec'), { recursive: true });
  const group = alive ? spawnSync('bash', ['-c', 'setsid sleep 30 >/dev/null 2>&1 < /dev/null & echo $!'], { encoding: 'utf8' }).stdout.trim() : String(spawnSync('true').pid);
  fs.writeFileSync(path.join(prof, 'pid'), group);
  const r17 = spawnSync('bash', ['-c', `set -euo pipefail\n. ${q(GUARD)}\nPIDFILE=${q(path.join(prof, 'pid'))}; PROFILE=${q(prof)}; STARTED=0; PASSED=0\n${onExit}\n${traps}\nSTARTED=1\nexit 1`],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000 });
  const groupLeft = spawnSync('bash', ['-c', `kill -0 -${group} 2>/dev/null`]).status === 0;
  if (r17.status !== 1 || fs.existsSync(path.join(prof, 'rec')) || groupLeft) {
    failures.push(`${id} the record pass's exit path with the application ${alive ? 'running' : 'gone'}: exit ${r17.status}, recordings left ${fs.existsSync(path.join(prof, 'rec'))}, group left ${groupLeft}: ${r17.stderr}`);
  }
  if (groupLeft) { try { process.kill(-Number(group), 'SIGKILL'); } catch { /* gone */ } }
}

// ... and when the pass is stopped by a signal to its group, as the watch stops it, or by Ctrl-C: the
// exit trap then sees the last command's status, 0, so the drop is keyed on whether the pass passed, and
// the signal ends the pass rather than returning to it (round 4).
// 17e is a signal the pass sets no trap for: closing the terminal. Only keying the drop on PASSED drops
// then, since the exit trap sees status 0; bash then reports the hangup itself (-1 to Python).
for (const [id, sig, code] of [['17c', 'SIGTERM', 143], ['17d', 'SIGINT', 130], ['17e', 'SIGHUP', -1]]) {
  const prof = path.join(root, `rec-${id}`);
  fs.mkdirSync(path.join(prof, 'rec'), { recursive: true });
  const group = spawnSync('bash', ['-c', 'setsid sleep 30 >/dev/null 2>&1 < /dev/null & echo $!'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(prof, 'pid'), group);
  const script = `set -euo pipefail\n. ${q(GUARD)}\nPIDFILE=${q(path.join(prof, 'pid'))}; PROFILE=${q(prof)}; STARTED=0; PASSED=0\n${onExit}\n${traps}\nSTARTED=1\nsleep 10\ntouch ${q(path.join(prof, 'went-on'))}`;
  const r = spawnSync('python3', ['-I', '-c', `import os, signal, subprocess, sys, time
p = subprocess.Popen(['bash', '-c', sys.argv[1]], start_new_session=True, env=dict(os.environ, PATH=sys.argv[2]))
time.sleep(1); os.killpg(p.pid, signal.${sig}); print(p.wait(timeout=20))`, script, `${bin}:${process.env.PATH}`], { encoding: 'utf8', timeout: 30_000 });
  const groupLeft = spawnSync('bash', ['-c', `kill -0 -${group} 2>/dev/null`]).status === 0;
  if (r.stdout.trim() !== String(code) || fs.existsSync(path.join(prof, 'rec')) || groupLeft || fs.existsSync(path.join(prof, 'went-on'))) {
    failures.push(`${id} the record pass stopped by ${sig}: exit ${r.stdout.trim()} (want ${code}), recordings left ${fs.existsSync(path.join(prof, 'rec'))}, group left ${groupLeft}, went on ${fs.existsSync(path.join(prof, 'went-on'))}: ${r.stderr}`);
  }
  if (groupLeft) { try { process.kill(-Number(group), 'SIGKILL'); } catch { /* gone */ } }
}

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - harness guard: accepts a run that kept the default and opened the harness by name, split dumps included; refuses a moved or unreadable default, a changed preference, a second or foreign Backchannel source, a start whose log lacks the harness stream, its creation or its Using line, names another microphone or fails on it, and a start with no link from the harness source into a capture under the root pid; removes the recordings from every save folder of a gate profile, and refuses any other path; and the exit path of the record pass stops the application and drops them under set -e, with the application running or gone, and when the pass is stopped by TERM, INT or a hangup');

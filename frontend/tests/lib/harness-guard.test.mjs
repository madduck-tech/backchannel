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
// the graph in a JSON file: the effective default input, the nodes, and the links.
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
out += [{'id': 900 + i, 'type': 'PipeWire:Interface:Link', 'info': {'output-node-id': l[0], 'input-node-id': l[1]}} for i, l in enumerate(st['links'])]
print(json.dumps(out))
`);

const SRC = 'backchannel_harness_src_1793470000_4242';
const BUILTIN = 'alsa_input.pci-0000_00_1f.3.analog-stereo';
const DESC = 'Backchannel';
const SEED = `${DESC} (input)`;
const APP = 'cpal-pulseaudio-31337';
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
const afterStart = (state, log, secs = 1) => run(state, `harness_guard_after_start ${q(log.p)} ${log.from} ${q(DESC)} ${q(SRC)} ${secs}`);

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

// 12. A failure after Start removes the recordings before the profile is kept, and never outside a gate
// profile; and both passes that record call it on that failure.
const profile = path.join(root, 'profile');
fs.mkdirSync(path.join(profile, 'rec'), { recursive: true });
fs.writeFileSync(path.join(profile, 'rec', 'audio.mp4'), 'x');
fs.writeFileSync(path.join(profile, 'stdout.log'), 'evidence');
let r = run(graph(), `harness_guard_drop_recordings ${q(profile)}`);
if (r.status !== 0 || fs.existsSync(path.join(profile, 'rec')) || !fs.existsSync(path.join(profile, 'stdout.log'))) {
  failures.push(`12a the recordings were not removed, or the log went with them: exit ${r.status}, rec ${fs.existsSync(path.join(profile, 'rec'))}, log ${fs.existsSync(path.join(profile, 'stdout.log'))}: ${r.stderr}`);
}
const outside = fs.mkdtempSync('/tmp/guard-outside-');
fs.mkdirSync(path.join(outside, 'rec'));
r = run(graph(), `harness_guard_drop_recordings ${q(outside)}`);
if (r.status === 0 || !fs.existsSync(path.join(outside, 'rec'))) failures.push(`12b removed recordings outside a gate profile: exit ${r.status}`);
fs.rmSync(outside, { recursive: true, force: true });
const src = (f) => fs.readFileSync(path.join(repo, 'scripts', f), 'utf8');
const core = src('stage2-core-check.sh').split('\n');
const at = core.findIndex((l) => /harness_guard_after_start /.test(l));
if (at < 0 || !/\|\|\s*\{\s*harness_guard_drop_recordings "\$PROFILE";\s*die /.test(core[at + 1] ?? '')) {
  failures.push(`12c the core pass does not drop the recordings when the guard after Start fails: ${core[at]} / ${core[at + 1]}`);
}
const record = src('stage2-record-check.sh');
const trap = /trap '[^']*"\$STARTED" = 1[^']*harness_guard_drop_recordings "\$PROFILE"[^']*' EXIT/.test(record);
const startedBeforeClick = record.indexOf('STARTED=1') >= 0 && record.indexOf('STARTED=1') < record.indexOf('click_labelled "Start recording"');
if (!trap || !startedBeforeClick) failures.push(`12d the record pass does not drop the recordings on a failure after Start: trap ${trap}, STARTED=1 before the click ${startedBeforeClick}`);

fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - harness guard: accepts a run that kept the default and opened the harness by name; refuses a moved or unreadable default, a changed preference, a second or foreign Backchannel source, a start whose log lacks the harness stream, its creation or its Using line, names another microphone or fails on it, and a start with no link from the harness source; removes the recordings on a failure after Start, only from a gate profile, and both recording passes call it');

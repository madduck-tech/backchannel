// The watch that #293's item 2 is measured under, run against PipeWire shims. (#293)
//
// `scripts/stage2-capture-watch.sh` runs one gate entry beside a silent recorder and stops the entry the
// moment someone else starts capturing, so a gate never records beside a call. What it promises, each case
// here holds: it refuses to start beside a capture, or on a graph it cannot read; it runs the entry and
// passes its exit through; and it stops the entry, before the entry's own next step, when a capture that
// is neither the recorder's nor the entry's appears, whether its pid is on this host or, as a sandboxed
// browser's is, not. `scripts/stage2-watched.py --plan` is held to the entries it watches.
//
// The shims keep the graph in a directory: a live `pw-record` shim adds a capture linked from the default
// microphone, and a `foreign-*.json` file adds a capture by another process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCH = path.join(repo, 'scripts', 'stage2-capture-watch.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-watch-'));
const bin = path.join(root, 'bin');
const live = path.join(root, 'live');
fs.mkdirSync(bin);
fs.mkdirSync(live);
const MIC = 'alsa_input.builtin';
const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env python3
import json, os, signal, sys, time
LIVE = os.environ['SHIM_LIVE']
${body}
`, { mode: 0o755 });
// Up until killed, as pw-record is; it gives up after a minute so a test that dies leaves nothing behind.
shim('pw-record', `
mine = os.path.join(LIVE, f'rec-{os.getpid()}')
open(mine, 'w').write('')
def gone(*_):
    try: os.remove(mine)
    finally: sys.exit(0)
signal.signal(signal.SIGTERM, gone)
deadline = time.time() + 60
while time.time() < deadline: time.sleep(0.1)
gone()
`);
shim('pw-dump', `
if os.path.exists(os.path.join(LIVE, 'unreadable')): sys.exit(1)
out = [{'id': 40, 'type': 'PipeWire:Interface:Metadata', 'props': {'metadata.name': 'default'}, 'metadata': [
          {'key': 'default.audio.source', 'value': {'name': '${MIC}'}}, {'key': 'default.configured.audio.source', 'value': {'name': '${MIC}'}}]},
       {'id': 41, 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': '${MIC}', 'media.class': 'Audio/Source'}}}]
i = 100
for f in sorted(os.listdir(LIVE)):
    i += 1
    if f.startswith('rec-'):
        pid = int(f[4:])
        try: os.kill(pid, 0)
        except OSError: continue
        out.append({'id': i, 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': 'pw-record', 'media.class': 'Stream/Input/Audio', 'application.process.id': str(pid)}}})
        out.append({'id': 500 + i, 'type': 'PipeWire:Interface:Link', 'info': {'output-node-id': 41, 'input-node-id': i}})
    elif f.startswith('foreign-'):
        pid = json.load(open(os.path.join(LIVE, f)))['pid']
        out.append({'id': i, 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': 'Chromium input', 'media.class': 'Stream/Input/Audio', 'application.process.id': str(pid)}}})
print(json.dumps(out))
`);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_LIVE: live };
let n = 0;
function watch(command, timeout = 30_000) {
  const out = path.join(root, `out-${++n}`);
  const t = Date.now();
  const r = spawnSync('bash', [WATCH, out, '--', command], { env, encoding: 'utf8', timeout, cwd: root });
  const rows = fs.existsSync(path.join(out, 'graph.jsonl')) ? fs.readFileSync(path.join(out, 'graph.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const log = fs.existsSync(path.join(out, 'watch.log')) ? fs.readFileSync(path.join(out, 'watch.log'), 'utf8') : '';
  return { status: r.status, signal: r.signal, secs: (Date.now() - t) / 1000, rows, log, out, text: r.stdout + r.stderr };
}
const mark = (k) => path.join(root, `mark-${k}`);
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
const clear = () => { for (const f of fs.readdirSync(live)) if (f.startsWith('foreign-') || f === 'unreadable') fs.rmSync(path.join(live, f)); };
const absentPid = () => { for (let p = 4_000_000; p > 3_000_000; p -= 7) if (!fs.existsSync(`/proc/${p}`)) return p; return 0; };
const sleeper = () => Number(spawnSync('bash', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim());
const strays = [];
// Signal only once the watch says the entry runs, not after a fixed sleep: under load the entry starts late.
const whenRunning = (out) => `for i in $(seq 1 200); do grep "runs as session" ${JSON.stringify(path.join(out, 'watch.log'))} >/dev/null 2>&1 && break; sleep 0.05; done; sleep 0.5`;

// 1. Beside a capture already in the graph, the entry never starts.
const other = sleeper(); strays.push(other);
fs.writeFileSync(path.join(live, 'foreign-a.json'), JSON.stringify({ pid: other }));
let r = watch(`touch ${mark(1)}`);
check('1 refuses beside a capture', r.status === 3 && !fs.existsSync(mark(1)) && /already in the graph/.test(r.log), `exit ${r.status}, ran ${fs.existsSync(mark(1))}: ${r.log}${r.text}`);
clear();

// 2. On a graph it cannot read, the entry never starts.
fs.writeFileSync(path.join(live, 'unreadable'), '');
r = watch(`touch ${mark(2)}`);
check('2 refuses an unreadable graph', r.status === 3 && !fs.existsSync(mark(2)) && /could not be read/.test(r.log), `exit ${r.status}, ran ${fs.existsSync(mark(2))}: ${r.log}${r.text}`);
clear();

// 3. A quiet entry runs, its exit comes through, and the recorder was sampled on the default microphone.
r = watch(`touch ${mark(3)}; sleep 1.5; exit 7`);
const linked = r.rows.filter((x) => JSON.stringify(x.recorder_from) === JSON.stringify([MIC]));
check('3 runs the entry and passes its exit through', r.status === 7 && fs.existsSync(mark(3)) && linked.length >= 3 && fs.existsSync(path.join(r.out, 'summary.txt')) && !r.rows.some((x) => x.stopped),
  `exit ${r.status}, ran ${fs.existsSync(mark(3))}, ${linked.length} of ${r.rows.length} samples on ${MIC}: ${r.log}${r.text}`);

// 4. A capture by a live process outside the entry stops it before its next step.
const caller = sleeper(); strays.push(caller);
r = watch(`sleep 1; echo '{"pid": ${caller}}' > ${path.join(live, 'foreign-b.json')}; sleep 15; touch ${mark(4)}`);
check('4 stops the entry when another process captures', r.status === 143 && !fs.existsSync(mark(4)) && r.rows.some((x) => x.stopped) && r.secs < 10,
  `exit ${r.status} after ${r.secs}s, went on ${fs.existsSync(mark(4))}, stopped ${r.rows.some((x) => x.stopped)}: ${r.log}${r.text}`);
clear();

// 5. ... and so does one whose pid is not on this host, once an exit would have removed its node.
const elsewhere = absentPid();
r = watch(`sleep 1; echo '{"pid": ${elsewhere}}' > ${path.join(live, 'foreign-c.json')}; sleep 15; touch ${mark(5)}`);
const ended = r.rows.filter((x) => (x.ended || []).length).length;
check('5 stops the entry when a capture from another pid namespace stays', elsewhere > 0 && r.status === 143 && !fs.existsSync(mark(5)) && r.rows.some((x) => x.stopped) && r.secs < 12,
  `pid ${elsewhere}: exit ${r.status} after ${r.secs}s, went on ${fs.existsSync(mark(5))}, ${ended} samples read it as ended, stopped ${r.rows.some((x) => x.stopped)}: ${r.log}${r.text}`);
clear();

// 7. A watch that is itself stopped takes the entry, the sampler and the recorder with it.
const out7 = path.join(root, 'out-stopped');
const r7 = spawnSync('bash', ['-c', `bash ${JSON.stringify(WATCH)} ${JSON.stringify(out7)} -- 'sleep 20; touch ${mark(7)}' & w=$!; ${whenRunning(out7)}; kill -TERM $w; wait $w; echo "rc=$?"`],
  { env, encoding: 'utf8', timeout: 30_000, cwd: root });
const passGroup = Number(fs.existsSync(path.join(out7, 'pass.pgid')) ? fs.readFileSync(path.join(out7, 'pass.pgid'), 'utf8').trim() : 0);
spawnSync('sleep', ['1']);
const groupAlive = passGroup > 0 && spawnSync('bash', ['-c', `kill -0 -${passGroup} 2>/dev/null`]).status === 0;
const recorders = fs.readdirSync(live).filter((f) => f.startsWith('rec-') && fs.existsSync(`/proc/${f.slice(4)}`));
// The sampler, by its command line naming this watch's output, read from /proc.
const samplers = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
  try { const c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); return c.includes('capture-graph.py') && c.includes(out7); } catch { return false; }
});
check('7 a stopped watch stops what it started', /rc=143/.test(r7.stdout) && passGroup > 0 && !groupAlive && recorders.length === 0 && samplers.length === 0 && !fs.existsSync(mark(7)),
  `${r7.stdout.trim()}, pass group ${passGroup} alive ${groupAlive}, recorders left ${JSON.stringify(recorders)}, samplers left ${JSON.stringify(samplers)}, went on ${fs.existsSync(mark(7))}: ${r7.stderr}`);
for (const pid of samplers) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }

// 8. ... and returns only once the entry's own teardown is done, so the next entry never starts beside it.
const out8 = path.join(root, 'out-teardown');
const r8 = spawnSync('bash', ['-c', `bash ${JSON.stringify(WATCH)} ${JSON.stringify(out8)} -- "trap 'sleep 2; touch ${mark(8)}' EXIT; sleep 20" & w=$!; ${whenRunning(out8)}; kill -TERM $w; wait $w; echo "rc=$?"; [ -e ${JSON.stringify(mark(8))} ] && echo torn-down-first`],
  { env, encoding: 'utf8', timeout: 40_000, cwd: root });
check('8 a stopped watch waits for the entry\'s teardown', /rc=143/.test(r8.stdout) && /torn-down-first/.test(r8.stdout), `${r8.stdout.trim()}: ${r8.stderr}`);

// 8b. ... the whole group's: in the record step the shell ends at once while the pass it ran is still
// dropping its recordings, so waiting for the session leader alone returns too early.
const child8 = path.join(root, 'child8.sh');
fs.writeFileSync(child8, `trap 'sleep 2; touch ${mark('8b')}; exit 143' TERM\nsleep 20 & wait\n`);
const out8b = path.join(root, 'out-group');
const r8b = spawnSync('bash', ['-c', `bash ${JSON.stringify(WATCH)} ${JSON.stringify(out8b)} -- "bash ${child8}; true" & w=$!; ${whenRunning(out8b)}; kill -TERM $w; wait $w; echo "rc=$?"; [ -e ${JSON.stringify(mark('8b'))} ] && echo torn-down-first`],
  { env, encoding: 'utf8', timeout: 40_000, cwd: root });
check('8b a stopped watch waits for the whole group', /rc=143/.test(r8b.stdout) && /torn-down-first/.test(r8b.stdout), `${r8b.stdout.trim()}: ${r8b.stderr}`);

// 9. Under the runner, a Ctrl-C to the terminal's group lets the watched entry tear down, then stops the
// run: subprocess.call would kill the watch 0.25 s after it.
const cfg = path.join(root, 'gopnik-9.json');
fs.writeFileSync(cfg, JSON.stringify({ verification: { stage2: [
  `trap 'sleep 2; touch ${mark(9)}' TERM; sleep 20 & wait; echo stage2-core-check.sh "$APP" x`,
  `touch ${mark('9b')}`,
  ': harness_guard_after_up up --system-only',
  ': stage2-record-check.sh; RC=0; APID=x; scripts/audio-harness.sh down; exit $RC',
] } }));
// The runner runs under a calling shell, which must stop with it rather than carry on.
const r9 = spawnSync('python3', ['-I', '-c', `import os, signal, subprocess, sys, time
p = subprocess.Popen(['bash', '-c', 'python3 -I "$0" "$1" --only 1,2 --config "$2"; echo CALLER-WENT-ON', sys.argv[1], sys.argv[2], sys.argv[3]], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
log = os.path.join(sys.argv[2], 'watch-01', 'watch.log')
for _ in range(200):
    if os.path.exists(log) and 'runs as session' in open(log).read(): break
    time.sleep(0.05)
time.sleep(0.5); os.killpg(p.pid, signal.SIGINT)
out = p.communicate(timeout=60)[0]
print(p.returncode); print(os.path.exists(sys.argv[4])); print(out)`, path.join(repo, 'scripts', 'stage2-watched.py'), path.join(root, 'out-9'), cfg, mark(9)], { env, encoding: 'utf8', timeout: 90_000 });
const [rc9, torn9] = r9.stdout.split('\n');
check('9 a Ctrl-C under the runner waits for the entry, runs nothing after it, and stops its caller', rc9 === '-2' && torn9 === 'True' && !fs.existsSync(mark('9b')) && /interrupted/.test(r9.stdout) && !/CALLER-WENT-ON/.test(r9.stdout),
  `caller exit ${rc9}, torn down when it returned ${torn9}, the next entry ran ${fs.existsSync(mark('9b'))}: ${r9.stdout}${r9.stderr}`);

// 10. A stop by the sampler, the watch's own purpose, also waits for the entry's whole group.
const caller10 = sleeper(); strays.push(caller10);
const child10 = path.join(root, 'child10.sh');
fs.writeFileSync(child10, `trap 'sleep 2; touch ${mark(10)}; exit 143' TERM\nsleep 20 & wait\n`);
r = watch(`bash ${child10} & c=$!; sleep 1; echo '{"pid": ${caller10}}' > ${path.join(live, 'foreign-d.json')}; wait $c; true`);
check('10 a stop by the sampler waits for the whole group', r.status === 143 && fs.existsSync(mark(10)) && r.rows.some((x) => x.stopped),
  `exit ${r.status} after ${r.secs}s, torn down when it returned ${fs.existsSync(mark(10))}, stopped ${r.rows.some((x) => x.stopped)}: ${r.log}${r.text}`);
clear();

// 11. A watch stopped before the entry has become a group leader still stops it: `setsid` here takes a
// second to get there, and the TERM goes to the leader-to-be.
const realSetsid = spawnSync('bash', ['-c', 'command -v setsid'], { encoding: 'utf8' }).stdout.trim();
const slow = path.join(root, 'slowbin');
fs.mkdirSync(slow);
fs.writeFileSync(path.join(slow, 'setsid'), `#!/bin/sh\nsleep 1\nexec ${realSetsid} "$@"\n`, { mode: 0o755 });
const out11 = path.join(root, 'out-early');
const r11 = spawnSync('bash', ['-c', `bash ${JSON.stringify(WATCH)} ${JSON.stringify(out11)} -- 'touch ${mark(11)}; sleep 5; touch ${mark('11b')}' & w=$!; for i in $(seq 1 200); do grep "recorder pid" ${JSON.stringify(path.join(out11, 'watch.log'))} >/dev/null 2>&1 && break; sleep 0.05; done; sleep 0.3; kill -TERM $w; wait $w; echo "rc=$?"; sleep 6`],
  { env: { ...env, PATH: `${slow}:${env.PATH}` }, encoding: 'utf8', timeout: 40_000, cwd: root });
check('11 a watch stopped before the entry leads its group still stops it', /rc=143/.test(r11.stdout) && !fs.existsSync(mark(11)) && !fs.existsSync(mark('11b')),
  `${r11.stdout.trim()}, the entry started ${fs.existsSync(mark(11))}, ran to its end ${fs.existsSync(mark('11b'))}: ${r11.stderr}`);

// 6. The runner watches the entries that bring the harness up, found by what they run.
const p = spawnSync('python3', ['-I', path.join(repo, 'scripts', 'stage2-watched.py'), root, '--plan'], { encoding: 'utf8' });
const steps = p.stdout.trim().split('\n').map((l) => l.split('\t'));
const watched = steps.filter((s) => s[1].startsWith('watched'));
const what = (s) => s[2];
const coreEntries = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification.stage2.filter((e) => /stage2-core-check\.sh "\$APP" \w+$/.test(e)).length;
check('6a the plan watches resumes, the core passes and the record pass, and nothing else',
  p.status === 0 && coreEntries >= 4 && watched.length === coreEntries + 2
    && watched.filter((s) => /onboarding-check\.sh "\$APP" resumes$/.test(what(s)) && /no system device/.test(s[1])).length === 1
    && watched.filter((s) => /stage2-core-check\.sh/.test(what(s)) && /--recording/.test(s[1]) && /backchannel_harness_sink/.test(s[1])).length === coreEntries
    && watched.filter((s) => /^\d+-\d+$/.test(s[0]) && /harness-guard\.sh/.test(what(s)) && /--system-default-sink --recording/.test(s[1]) && /pids /.test(s[1])).length === 1,
  `exit ${p.status}: ${JSON.stringify(watched)} ${p.stderr}`);
check('6b and joins the record pass to its up', steps.some((s) => /^\d+-\d+$/.test(s[0])) && !steps.some((s) => /stage2-record-check\.sh/.test(what(s)) && !/^\d+-\d+$/.test(s[0])),
  `steps: ${JSON.stringify(steps.map((s) => s[0]))}`);

// ... and runs the record pass, joined to its up, under a trap holding the record entry's own tail, so a
// TERM from the watch still stops its application and takes the harness down.
const joined = spawnSync('python3', ['-I', '-c', `import importlib.util, json
s = importlib.util.spec_from_file_location('w', ${JSON.stringify(path.join(repo, 'scripts', 'stage2-watched.py'))}); w = importlib.util.module_from_spec(s); s.loader.exec_module(w)
cmds = json.load(open(${JSON.stringify(path.join(repo, 'gopnik.json'))}))['verification']['stage2']
print(json.dumps([[l, c] for l, c, *_ in w.plan(cmds) if '-' in l]))`], { encoding: 'utf8' });
const [jl, jc] = joined.status === 0 ? (JSON.parse(joined.stdout)[0] ?? []) : [];
const lines = (jc ?? '').split('\n');
check('6c the record pass runs under a trap holding its own tail', lines.length === 3 && /harness_guard_after_up/.test(lines[0])
    && /^trap 'trap "" INT TERM; APID=\$\(cat "\$A2\/pid" 2>\/dev\/null\);.*scripts\/audio-harness\.sh down' EXIT$/.test(lines[1]) && /stage2-record-check\.sh/.test(lines[2]),
  `exit ${joined.status}, ${jl}: ${JSON.stringify(lines)} ${joined.stderr}`);

for (const pid of strays) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
// Whatever a case left behind that still names this test's directory, a sampler above all: once the
// directory and its shims are gone, a leftover would read the real graph and could signal a group that is
// no longer the entry's.
for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
  try { if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(root) && Number(d) !== process.pid) process.kill(Number(d), 'SIGTERM'); } catch { /* gone */ }
}
for (const f of fs.readdirSync(live)) {
  if (f.startsWith('rec-')) { try { process.kill(Number(f.slice(4)), 'SIGTERM'); } catch { /* gone */ } }
}
fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - capture watch: refuses to start beside a capture or on an unreadable graph; runs a quiet entry and passes its exit through with the recorder on the default microphone; stops the entry before its next step when a live process outside it captures, or one whose pid is not on this host stays; stops what it started when it is itself stopped, and returns only after the whole group of the entry has torn down, under a Ctrl-C to the runner too, which then stops its caller; waits the same way when the sampler stops the entry; and stops an entry that does not yet lead its group; and the runner watches resumes, every core pass and the record pass joined to its up under its own tail');

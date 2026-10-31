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

// 6. The runner watches the entries that bring the harness up, found by what they run.
const p = spawnSync('python3', ['-I', path.join(repo, 'scripts', 'stage2-watched.py'), root, '--plan'], { encoding: 'utf8' });
const steps = p.stdout.trim().split('\n').map((l) => l.split('\t'));
const watched = steps.filter((s) => s[1].startsWith('watched'));
const what = (s) => s[2];
check('6a the plan watches resumes, the core passes and the record pass, and nothing else',
  p.status === 0 && watched.length === 6
    && watched.filter((s) => /onboarding-check\.sh "\$APP" resumes$/.test(what(s)) && /no system device/.test(s[1])).length === 1
    && watched.filter((s) => /stage2-core-check\.sh/.test(what(s)) && /--recording/.test(s[1]) && /backchannel_harness_sink/.test(s[1])).length === 4
    && watched.filter((s) => /^\d+-\d+$/.test(s[0]) && /harness-guard\.sh/.test(what(s)) && /--system-default-sink --recording/.test(s[1]) && /pids /.test(s[1])).length === 1,
  `exit ${p.status}: ${JSON.stringify(watched)} ${p.stderr}`);
check('6b and joins the record pass to its up', steps.some((s) => /^\d+-\d+$/.test(s[0])) && !steps.some((s) => /stage2-record-check\.sh/.test(what(s)) && !/^\d+-\d+$/.test(s[0])),
  `steps: ${JSON.stringify(steps.map((s) => s[0]))}`);

for (const pid of strays) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
for (const f of fs.readdirSync(live)) {
  if (f.startsWith('rec-')) { try { process.kill(Number(f.slice(4)), 'SIGTERM'); } catch { /* gone */ } }
}
fs.rmSync(root, { recursive: true, force: true });
assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - capture watch: refuses to start beside a capture or on an unreadable graph; runs a quiet entry and passes its exit through with the recorder on the default microphone; stops the entry before its next step when a live process outside it captures, or one whose pid is not on this host stays; and the runner watches resumes, the four core passes and the record pass joined to its up');

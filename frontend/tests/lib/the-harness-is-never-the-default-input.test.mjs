// The audio harness never becomes the default input, and every pass that records with it names it. (#293)
//
// `stage2-core-check.sh` brought the harness up without `--system-only`, so `audio-harness.sh` wrote
// `default.configured.audio.source` for the whole entry. WirePlumber's `follow` then moved every capture
// that follows the default onto it: measured 2026-10-31 on `main`, a silent `pw-record` with no target
// was linked from the harness source in 683 of 688 samples across one core entry, and back on the built-in
// microphone after `down`. A call's microphone in a browser tab is such a capture.
//
// Stopping the write was not enough. WirePlumber keeps a stack of configured defaults and falls back to a
// stacked name whenever the configured one is absent, so `up --system-only` under the constant name made
// the harness the effective default with no write at all (measured the same day). The source therefore
// gets a per-run name under `--system-only`, and the passes name it as their microphone.
//
// Two halves:
// - **the census**, over the callers: every `audio-harness.sh up` reachable from the core pass, the
//   onboarding pass and `gopnik.json` stage 2 passes `--system-only`, except the two-channel passes, which
//   play into the real output on purpose; no caller looks the source up by a literal name; the core seed
//   and the record pass's seed name `"$HARNESS_DESC (input)"`, the record pass's on every run.
// - **the harness, run**, against PipeWire shims that log their argv: `up --system-only` then `down`
//   writes neither default key, and two cycles give two source names, neither the constant.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS = path.join(repo, 'scripts');
const read = (p) => fs.readFileSync(p, 'utf8');
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };
const code = (src) => src.split('\n').map((l, i) => ({ line: l, n: i + 1 })).filter(({ line }) => !/^\s*#/.test(line));

// --- the census -------------------------------------------------------------------------------------

const gopnik = JSON.parse(read(path.join(repo, 'gopnik.json')));
const stage2 = gopnik.verification.stage2;
assert.ok(Array.isArray(stage2) && stage2.length > 20, `gopnik.json stage 2 has ${stage2?.length} entries; this census has gone stale`);

// The scripts a source runs or sources, by any of the spellings the passes use: `scripts/x.sh`,
// `"$(dirname …)/x.sh"`, `…/lib/x.sh`.
const SCRIPT_REF = /(?:scripts\/|\/)((?:lib\/)?[\w.-]+\.sh)\b/g;
const sources = new Map(stage2.map((e, i) => [`gopnik.json stage 2 [${i + 1}]`, e]));
const queue = ['stage2-core-check.sh', 'stage2-onboarding-check.sh'];
for (const e of stage2) for (const m of e.matchAll(SCRIPT_REF)) queue.push(m[1]);
while (queue.length) {
  const name = queue.shift();
  if (sources.has(name) || !fs.existsSync(path.join(SCRIPTS, name))) continue;
  const src = read(path.join(SCRIPTS, name));
  sources.set(name, src);
  for (const { line } of code(src)) for (const m of line.matchAll(SCRIPT_REF)) queue.push(m[1]);
}
for (const need of ['stage2-core-check.sh', 'stage2-onboarding-check.sh', 'stage2-record-check.sh', 'stage2-two-channel-check.sh', 'audio-harness.sh', 'lib/harness-guard.sh']) {
  assert.ok(sources.has(need), `${need} is not reachable from gopnik.json stage 2; this census has gone blind`);
}

// 1. Every `up`, two-channel excepted, passes `--system-only`.
const TWO_CHANNEL = 'stage2-two-channel-check.sh';
const ups = [];
for (const [where, src] of sources) {
  if (where === TWO_CHANNEL || where === 'audio-harness.sh') continue;
  for (const { line, n } of code(src)) {
    // The arguments stop at a comment too: `up  # --system-only` is a call without the flag.
    for (const m of line.matchAll(/audio-harness\.sh"?\s+up\b([^;|&#]*)/g)) ups.push({ where: `${where}:${n}`, args: m[1] });
  }
}
const upWhere = (w) => ups.filter((u) => u.where.startsWith(w)).length;
check('1a the census finds the calls', upWhere('stage2-core-check.sh:') >= 1 && upWhere('stage2-onboarding-check.sh:') >= 1 && upWhere('gopnik.json') >= 1,
  `core ${upWhere('stage2-core-check.sh:')}, onboarding ${upWhere('stage2-onboarding-check.sh:')}, gopnik.json ${upWhere('gopnik.json')}: ${JSON.stringify(ups)}`);
const writing = ups.filter((u) => !/--system-only\b/.test(u.args));
check('1b every up leaves the default input alone', writing.length === 0,
  `these bring the harness up as the default input: ${writing.map((u) => `${u.where} 'up${u.args}'`).join('; ')}`);

// 2. No caller looks the source up by a literal name: under `--system-only` it is per run.
const literal = [];
for (const [where, src] of sources) {
  if (where === 'audio-harness.sh') continue;
  for (const { line, n } of code(src)) if (/backchannel_harness_src\b/.test(line)) literal.push(`${where}:${n}`);
}
check('2 no literal source name', literal.length === 0, `these name the source by its constant: ${literal.join(', ')}`);

// 3. The seeds. The statement that writes `recording_preferences.json`, joined across its continuations.
function statements(src) {
  const out = [];
  let cur = null;
  let depth = 0;
  code(src).forEach(({ line, n }) => {
    if (cur) cur.text += `\n${line}`;
    else cur = { text: line, n, depth };
    // A shell `if … then`, not a Python `if …:` inside a quoted program.
    if (/^\s*if\b.*;\s*then\b/.test(line) && !/\bfi\b/.test(line)) depth += 1;
    if (/^\s*fi\b/.test(line)) depth -= 1;
    if (!/\\$/.test(line)) { out.push(cur); cur = null; }
  });
  return out;
}
function seedOf(name) {
  const src = sources.get(name);
  const writes = statements(src).filter((s) => /recording_preferences\.json"/.test(s.text) && /preferred_mic_device/.test(s.text));
  const assigns = code(src).filter(({ line }) => /^\s*MIC_SEED=/.test(line)).map(({ line }) => line.trim());
  return { writes, assigns };
}
const core = seedOf('stage2-core-check.sh');
check('3a the core pass names the harness microphone', core.writes.length === 1 && /"preferred_mic_device":"%s"/.test(core.writes[0].text) && /"\$MIC_SEED"/.test(core.writes[0].text),
  `the core seed is ${JSON.stringify(core.writes.map((w) => w.text))}`);
check('3b with the suffix AudioDevice::from_name needs', core.assigns.length === 1 && core.assigns[0] === 'MIC_SEED="$HARNESS_DESC (input)"',
  `MIC_SEED is assigned as ${JSON.stringify(core.assigns)}`);
const rec = seedOf('stage2-record-check.sh');
check('3c the record pass names it', rec.writes.length === 1 && /"preferred_mic_device":sys\.argv\[2\]/.test(rec.writes[0].text) && /"\$MIC_SEED"/.test(rec.writes[0].text),
  `the record seed is ${JSON.stringify(rec.writes.map((w) => w.text))}`);
check('3d with the suffix', rec.assigns.length === 1 && rec.assigns[0] === 'MIC_SEED="$HARNESS_DESC (input)"', `MIC_SEED is assigned as ${JSON.stringify(rec.assigns)}`);
// The program's first line is its own statement; nothing may precede `python3` on it, `&&` included.
const recOpen = sources.get('stage2-record-check.sh').split('\n')[(rec.writes[0]?.n ?? 0) - 2];
check('3e on every run, outside any branch', rec.writes.length === 1 && rec.writes[0].depth === 0 && recOpen === "python3 -c 'import json,sys",
  `the record seed at line ${rec.writes[0]?.n} is inside ${rec.writes[0]?.depth} if-block(s), and opens with '${recOpen}'`);

// 6. The guard, where each pass needs it. Without these the census above can go green on a pass that
// moves the default: the guard after `up` is the only check that sees the default move, since a source
// under the constant name still passes the checks around Start.
const lineOf = (src, re) => code(src).find(({ line }) => re.test(line))?.n ?? -1;
const stmtWith = (src, re) => statements(src).find((st) => re.test(st.text));
const failsClosed = (st) => !!st && /\|\|\s*(die\b|\{)/.test(st.text);
const UP = /audio-harness\.sh"?\s+up\b/;
function wiring(name, sites) {
  const src = sources.get(name);
  for (const [id, what, ok] of sites) check(id, ok(src), `${name}: ${what}`);
}
const CORE_SRC = sources.get('stage2-core-check.sh');
const coreClick = lineOf(CORE_SRC, /click "\$R" "Start recording"/);
wiring('stage2-core-check.sh', [
  ['6a the core pass checks the default after up', 'no harness_guard_after_up after its up, failing closed',
    (src) => { const st = stmtWith(src, /harness_guard_after_up /); return failsClosed(st) && st.n > lineOf(src, UP); }],
  ['6b and checks the seed before Start', 'no harness_guard_before_start before the Start click, failing closed',
    (src) => { const st = stmtWith(src, /harness_guard_before_start /); return failsClosed(st) && coreClick > 0 && st.n < coreClick; }],
  ['6c and what opened after Start', "no harness_guard_after_start after the start's CALLED offset, under the driver's pid, failing closed",
    (src) => { const st = stmtWith(src, /harness_guard_after_start /); return failsClosed(st) && /"\$DRIVER_PID"/.test(st.text) && st.n > lineOf(src, /^N=\$\(grep -n 'CALLED start_recording_with_devices_and_meeting'/); }],
  ['6d and drops the recordings on any failure after Start', 'STARTED=1 is not set before the click, or cleanup() does not drop the recordings when it is',
    (src) => { const body = src.slice(src.indexOf('cleanup() {'), src.indexOf('\n}\n', src.indexOf('cleanup() {')));
      return lineOf(src, /^STARTED=1$/) > 0 && lineOf(src, /^STARTED=1$/) < coreClick && /\[ "\$PASSED" != 1 \] && \[ -n "\$STARTED" \] && \{ harness_guard_drop_recordings "\$PROFILE"/.test(body); }],
]);
wiring('stage2-onboarding-check.sh', [
  ['6e the resumes mode checks the default after up', 'no harness_guard_after_up after its up, failing closed',
    (src) => { const st = stmtWith(src, /harness_guard_after_up /); return failsClosed(st) && st.n > lineOf(src, UP); }],
]);
const REC_SRC = sources.get('stage2-record-check.sh');
const recClick = lineOf(REC_SRC, /click_labelled "Start recording"/);
wiring('stage2-record-check.sh', [
  ['6f the record pass checks the seed before Start', 'no harness_guard_before_start before the Start click, failing closed',
    (src) => { const st = stmtWith(src, /harness_guard_before_start /); return failsClosed(st) && recClick > 0 && st.n < recClick; }],
  ['6g and what opened after Start', "no harness_guard_after_start after the click, under the application's pid, failing closed",
    (src) => { const st = stmtWith(src, /harness_guard_after_start /); return failsClosed(st) && /"\$\(cat "\$PIDFILE"\)"/.test(st.text) && st.n > recClick; }],
  ['6h and drops the recordings on any failure after Start', 'STARTED=1 is not set before the click, or the EXIT trap does not drop the recordings when it is',
    (src) => lineOf(src, /^STARTED=1$/) > 0 && lineOf(src, /^STARTED=1$/) < recClick
      && /trap '[^']*"\$STARTED" = 1[^']*harness_guard_drop_recordings "\$PROFILE"[^']*' EXIT/.test(src)],
]);
const upEntry = stage2.find((e) => UP.test(e) && !/two-channel/.test(e));
check('6i the record pass\'s up entry checks the default, and takes the harness down when it moved',
  !!upEntry && upEntry.indexOf('harness_guard_after_up') > upEntry.search(/up --system-only/)
    && /harness_guard_after_up "\$B"[^}]*\|\|\s*\{[^}]*scripts\/audio-harness\.sh down;\s*exit 1;\s*\}/.test(upEntry),
  `gopnik.json's up entry is ${JSON.stringify(upEntry)}`);

// --- the harness, run -------------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-default-'));
const bin = path.join(root, 'bin');
const live = path.join(root, 'live');
fs.mkdirSync(bin);
fs.mkdirSync(live);
const LOG = path.join(root, 'calls.log');
const CONFIGURED = '{"name":"alsa_input.builtin"}';
// Every shim logs its argv, one JSON array per line.
const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env python3
import json, os, signal, sys, time
a = sys.argv[1:]
with open(os.environ['SHIM_LOG'], 'a') as f: f.write(json.dumps([${JSON.stringify(name)}] + a) + '\\n')
LIVE = os.environ['SHIM_LIVE']
${body}
`, { mode: 0o755 });
// Stays up until killed, as pw-loopback does; its nodes are in the graph only while it lives. It gives up
// after a minute, so a test that dies leaves nothing behind for long.
shim('pw-loopback', `
props = {k: v for k, v in (x.split('=', 1) for x in a) if k in ('--capture-props', '--playback-props')}
names = [dict(p.split('=', 1) for p in v.split(' ') if '=' in p) for v in props.values()]
mine = os.path.join(LIVE, str(os.getpid()))
json.dump([{'name': n.get('node.name'), 'class': n.get('media.class')} for n in names], open(mine, 'w'))
def gone(*_):
    try: os.remove(mine)
    finally: sys.exit(0)
signal.signal(signal.SIGTERM, gone)
deadline = time.time() + 60
while time.time() < deadline: time.sleep(0.1)
gone()
`);
shim('pw-dump', `
out, i = [], 100
for pid in os.listdir(LIVE):
    try: os.kill(int(pid), 0)
    except OSError: continue
    for n in json.load(open(os.path.join(LIVE, pid))):
        i += 1
        out.append({'id': i, 'type': 'PipeWire:Interface:Node', 'info': {'props': {'node.name': n['name'], 'media.class': n['class'], 'node.description': 'Backchannel'}}})
print(json.dumps(out))
`);
// The metadata is kept in a file, so a write is what a later read returns, as WirePlumber's is.
shim('pw-metadata', `
M = os.environ['SHIM_META']
meta = json.load(open(M))
if len(a) >= 5:
    meta[a[3]] = a[4]; json.dump(meta, open(M, 'w'))
elif '-d' not in a:
    for k in ([a[3]] if len(a) >= 4 else list(meta)):
        if k in meta: print(f"update: id:0 key:'{k}' value:'{meta[k]}' type:'Spa:String:JSON'")
`);
// `-p` blocks, as playing a file does, and ends once its loop is killed; `-r` records nothing.
shim('pw-cat', `
if '-p' in a:
    parent = os.getppid()
    deadline = time.time() + 60
    while os.getppid() == parent and time.time() < deadline: time.sleep(0.1)
`);
shim('pw-cli', '');
shim('pkill', '');

const sample = path.join(root, 'sample.wav');
fs.writeFileSync(sample, 'RIFF');
const gitDir = path.join(root, 'git');
spawnSync('git', ['init', '-q', '--bare', gitDir]);
const META = path.join(root, 'meta.json');
fs.writeFileSync(META, JSON.stringify({ 'default.configured.audio.source': CONFIGURED }));
const configured = () => JSON.parse(read(META))['default.configured.audio.source'];
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_LOG: LOG, SHIM_LIVE: live, SHIM_META: META, GIT_DIR: gitDir, XDG_STATE_HOME: path.join(root, 'state') };
const harness = (...args) => spawnSync('bash', [path.join(SCRIPTS, 'audio-harness.sh'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
const calls = () => (fs.existsSync(LOG) ? read(LOG).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const names = [];
for (const cycle of [1, 2]) {
  fs.rmSync(LOG, { force: true });
  const up = harness('up', '--system-only', '--sample', sample);
  const name = harness('src-name');
  const down = harness('down');
  const log = calls();
  const loopback = log.find((c) => c[0] === 'pw-loopback');
  const playback = loopback?.find((x) => x.startsWith('--playback-props='));
  const created = /node\.name=(\S+)/.exec(playback ?? '')?.[1];
  names.push(created);
  // The sentinel: the harness ran, created its source, and read the default, so an absence of writes is
  // an absence in a run that reached them.
  check(`4.${cycle}a cycle ${cycle} ran`, up.status === 0 && down.status === 0 && name.status === 0 && created && log.some((c) => c[0] === 'pw-metadata'),
    `up ${up.status}, src-name ${name.status}, down ${down.status}, source ${created}: ${up.stdout}${up.stderr}${down.stdout}${down.stderr}`);
  check(`4.${cycle}b src-name names the source up made`, name.stdout.trim() === created, `src-name printed '${name.stdout.trim()}', up made '${created}'`);
  const writes = log.filter((c) => c[0] === 'pw-metadata' && (c.includes('-d') || c.slice(1).some((x, i, xs) => /^default\.(configured\.)?audio\.source$/.test(x) && i < xs.length - 1)));
  check(`4.${cycle}c cycle ${cycle} writes no default`, writes.length === 0, `default writes: ${JSON.stringify(writes)}`);
  check(`4.${cycle}d the source is not the constant`, created !== 'backchannel_harness_src' && /^backchannel_harness_src_/.test(created ?? ''), `the source is '${created}'`);
}
check('5 two cycles, two names', names[0] && names[1] && names[0] !== names[1], `both cycles made '${names[0]}' and '${names[1]}'`);

// 7. The mode the two-channel passes use still writes the default, and `down` still puts it back.
fs.rmSync(LOG, { force: true });
const upD = harness('up', '--sample', sample);
const wrote = calls().filter((c) => c[0] === 'pw-metadata' && c.length >= 6 && c[4] === 'default.configured.audio.source');
const during = configured();
const downD = harness('down');
check('7a the default-writing mode writes the constant source as the default', upD.status === 0 && wrote.length === 1 && during === '{"name":"backchannel_harness_src"}',
  `up ${upD.status}, writes ${JSON.stringify(wrote)}, configured during ${during}: ${upD.stdout}${upD.stderr}`);
check('7b and down puts the original back', downD.status === 0 && configured() === CONFIGURED,
  `down ${downD.status}, configured after ${configured()}: ${downD.stdout}${downD.stderr}`);

// Anything a shim left running is stopped, by the pids the shims wrote, and nothing else.
for (const pid of fs.readdirSync(live)) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
fs.rmSync(root, { recursive: true, force: true });

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log(`ok - ${ups.length} harness ups reachable from the gate leave the default input alone, two-channel excepted; no caller names the source by its constant; the core and record passes name "$HARNESS_DESC (input)", the record pass on every run; every pass checks the default after up, the seed before Start and what opened after it, and drops the recordings on a failure after Start; up --system-only then down, twice, wrote no default and made two per-run sources (${names.join(', ')}); and the default-writing mode still writes the default and puts it back`);

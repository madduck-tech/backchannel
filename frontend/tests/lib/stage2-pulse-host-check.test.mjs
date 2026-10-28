// Stage 2 judges the audio host with no PulseAudio cookie anywhere it looks. (#243, ADR 0033)
//
// scripts/stage2-pulse-host-check.sh reads the app entry 6 launched. It may pass only when the first
// host line reads PulseAudio *and* the run had no cookie: none in the process's environment, which the
// gate passes through from the shell, and none in its fresh home. With PULSE_COOKIE at a 256-byte
// file the unfixed CI artifact passes the UI checks (measured on 282f202), so a check that skipped
// the environment would pass on the very build #243 is about. Each cell is a real process whose
// environment is read through /proc, and a log written as the app writes it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repo, 'scripts', 'stage2-pulse-host-check.sh');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-host-'));
const procs = [];
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); fs.rmSync(base, { recursive: true, force: true }); });

const PULSE = '[2026-10-28][03:12:01][app_lib::audio::devices::host][INFO] Audio host selected for this process: PulseAudio';
const ALSA = '[2026-10-28][03:12:01][app_lib::audio::devices::host][WARN] PulseAudio is unavailable (server error: Invalid); using ALSA\n[2026-10-28][03:12:01][app_lib::audio::devices::host][INFO] Audio host selected for this process: Alsa';

function cell(name, { log = PULSE, env = {}, cookie = null, alive = true } = {}) {
  const s2 = path.join(base, name);
  fs.mkdirSync(path.join(s2, 'home', '.config', 'pulse'), { recursive: true });
  if (cookie) fs.writeFileSync(path.join(s2, 'home', cookie), Buffer.alloc(256, 1));
  const e = { ...process.env, ...env };
  if (!('PULSE_COOKIE' in env)) delete e.PULSE_COOKIE;
  const p = spawn('sleep', ['30'], { env: e, stdio: 'ignore' }); p.unref(); procs.push(p);
  if (!alive) p.kill('SIGKILL');
  fs.writeFileSync(path.join(s2, 'pid'), `${alive ? p.pid : 2147483646}\n`);
  if (log !== null) fs.writeFileSync(path.join(s2, 'stdout.log'), `Application setup complete\n${log}\n`);
  const r = spawnSync('bash', [script, s2], { encoding: 'utf8', env: { ...process.env, PULSE_COOKIE: '' } });
  return { status: r.status, out: r.stderr + r.stdout };
}

test('PulseAudio with no cookie anywhere passes, and says so', () => {
  const r = cell('pass');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /with no cookie anywhere: Audio host selected for this process: PulseAudio$/m);
});

test('a fallback to ALSA fails, and shows why', () => {
  const r = cell('alsa', { log: ALSA });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /the first host line reads: Audio host selected for this process: Alsa$/m);
  assert.match(r.out, /server error: Invalid/);
});

test('a process carrying PULSE_COOKIE fails at its own check, even when the host line reads PulseAudio', () => {
  const r = cell('env', { env: { PULSE_COOKIE: '/tmp/some-cookie' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /carries PULSE_COOKIE/);
});

for (const where of ['.config/pulse/cookie', '.pulse-cookie']) {
  test(`a cookie at ${where} in the fresh home fails: the run could not judge`, () => {
    const r = cell(`file-${where.replace(/\W/g, '')}`, { cookie: where });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`${where.replace('.', '\\.')} exists`));
  });
}

test('no host line, and a process that is gone, both fail', () => {
  const none = cell('no-line', { log: 'nothing about hosts' });
  assert.equal(none.status, 1, none.out);
  assert.match(none.out, /logged no host selection line/);
  const gone = cell('gone', { alive: false });
  assert.equal(gone.status, 1, gone.out);
  assert.match(gone.out, /is not running/);
});

test('the gate wires it: entry 5 makes the fresh home\'s pulse directory unwritable, and entry 11 runs the check', () => {
  const { stage1, stage2 } = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification;
  const launch = stage2.findIndex((c) => c.includes('mktemp -d /tmp/backchannel-stage2.'));
  assert.ok(launch >= 0 && stage2[launch].includes('mkdir -p "$S2/home/.config/pulse" && chmod 0500 "$S2/home/.config/pulse"'), 'the launch\'s fresh home can receive a cookie from libcanberra');
  assert.ok(stage2.some((c) => c.includes('Application setup complete') && c.endsWith('&& scripts/stage2-pulse-host-check.sh "$S2"')), 'no Stage 2 entry runs the host check after the launch');
  assert.equal(stage1.filter((c) => c.includes('authenticates_with_no_cookie_on_disk')).length, 1, 'Stage 1 does not run the wiring test by name');
});

// The gate's audio-check helpers, driven against a fake driver. (#167, #168)
//
// `scripts/lib/audio-check.sh` is sourced by two Stage 2 passes, and its failures have to say whose
// they are. The gate's adversary showed three that did not:
//
//   - a failed request ended a `set -euo pipefail` pass with exit 28 and no message;
//   - a driver error after the click read as "the press arrived", and the pass then blamed the
//     product for never answering;
//   - a driver that could not run the probe expression was reported as `dictation_probe` shipping.
//
// And one privacy defect: with no harness, the onboarding pass logged what the room said.
//
// Each scenario sources the real file into bash with `curl` replaced by a function that answers from a
// script of responses, so what is under test is the helper as the passes run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIB = path.join(repo, 'scripts', 'lib', 'audio-check.sh');

const row = (over) => JSON.stringify({
  found: true, button: 'Check by speaking', disabled: false, device: 'Backchannel',
  outcome: '', decoded: '', kind: 'NONE', sampleWords: 0, ...over,
});
const wd = (value) => JSON.stringify({ value });

/**
 * Run `body` with the helper sourced. `reads` answers successive reads of the row (the last repeats);
 * `probe` answers the probe expression; `null` in either makes curl fail as a timeout does.
 */
function run(body, { reads = [], probe = wd('REJECTED:Command dictation_probe not found'), env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-check-harness-'));
  fs.writeFileSync(path.join(dir, 'reads.json'), JSON.stringify(reads));
  fs.writeFileSync(path.join(dir, 'probe'), probe === null ? '' : probe);
  fs.writeFileSync(path.join(dir, 'probe-fails'), probe === null ? '1' : '');
  const script = `
set -euo pipefail
D=${JSON.stringify(dir)}
BASE=http://fake
say() { printf 'say: %s\\n' "$*"; }
die() { printf 'die: %s\\n' "$*"; exit 1; }
find_el() { echo el-1; }
click() { :; }
curl() {
  local data="" a
  for a in "$@"; do case "$prev" in -d) data="$a" ;; esac; prev="$a"; done
  case "$data" in
    *dictation_probe*) [ -s "$D/probe-fails" ] && return 28; cat "$D/probe" ;;
    *) n=$(cat "$D/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$D/n"
       python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); n=int(sys.argv[2]); v=r[min(n, len(r)-1)]; (v is None and sys.exit(28)); print(v)' "$D/reads.json" "$n" ;;
  esac
}
prev=""
sleep() { :; }
. ${JSON.stringify(LIB)}
${body}
echo "reached the end"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// The ordinary path, as a sentinel: the scenarios below fail for their own reason, not the stub's.
{
  const r = run('audio_check_press; audio_check_require_body_answer; probe_stays_out', {
    reads: [wd(row()), wd(row({ button: 'Listening…' })), wd(row({ outcome: 'Nothing arrived. This device is open but silent — pick another.', kind: 'SILENT' }))],
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /answered \(SILENT\)/);
  assert.match(r.out, /dictation_probe is not in this build/);
}

// A request that fails in the waits is the harness failing, said in words, under `set -euo pipefail`.
{
  const r = run('audio_check_press', { reads: [wd(row()), null] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /die: harness: after the click the driver no longer reads the microphone row/, r.out);
}

// A driver error after the click is not "the press arrived".
{
  const r = run('audio_check_press', { reads: [wd(row()), wd({ error: 'no such window' })] });
  assert.match(r.out, /die: harness:/, `a driver error must be named as the harness's: ${r.out}`);
  assert.doesNotMatch(r.out, /never answered/, 'and must not be blamed on the product');
}

// The probe: a driver that cannot run it has learned nothing; a probe answering from its body ships.
{
  const lost = run('probe_stays_out', { probe: null });
  assert.match(lost.out, /die: harness: the driver could not run the probe expression/, lost.out);
  const ships = run('probe_stays_out', { probe: wd('REJECTED:No transcription model is loaded — load one first.') });
  assert.match(ships.out, /die: dictation_probe answered 'REJECTED:No transcription model is loaded/, ships.out);
}

// With no harness, what the room said stays out of the log.
{
  const heard = row({ outcome: 'Heard: the meeting is at noon', decoded: 'the meeting is at noon', kind: 'HEARD', sampleWords: 0 });
  const quiet = run('audio_check_press', { reads: [wd(row()), wd(heard)], env: { AUDIO_CHECK_REDACT: '1' } });
  assert.equal(quiet.code, 0, quiet.out);
  assert.doesNotMatch(quiet.out, /meeting is at noon/, 'the decoded words must not be logged');
  assert.match(quiet.out, /<5 words, not logged/, 'but how many there were is');
  const loud = run('audio_check_press', { reads: [wd(row()), wd(heard)] });
  assert.match(loud.out, /meeting is at noon/, 'the sentinel: without the switch the words are shown, as the core pass needs');
}

console.log(
  'ok - audio check helpers: a failed request, a driver error after the click and a probe the driver ' +
    'could not run are each named as the harness failing; the probe answering from its body is named ' +
    'as shipping; and a pass with no harness does not log what the room said'
);

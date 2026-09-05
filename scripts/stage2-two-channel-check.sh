#!/usr/bin/env bash
#
# Two people speaking at once, on the two channels, and a transcript that says which is
# which.
#
#   scripts/stage2-two-channel-check.sh <AppImage> normal|swapped
#
# This is #30's oracle. Every earlier audio check in this repository put ONE sample on ONE
# channel, so "the label is right" and "the label is a constant" produced identical output.
# Here both channels carry speech at the same time, and the two are different recordings:
#
#   normal    microphone = sample A, system audio = sample B
#   swapped   microphone = sample B, system audio = sample A
#
# The labels must flip between the two runs. That is what separates a channel from a
# loudness guess, from a constant, and from the arrival order of two queues.
#
# The oracle is `transcripts.json` in the meeting folder, not the screen: nothing renders
# the channel yet (the OTHERS chip is #30 item 6, a design question), so the assertion is
# on the data the application wrote. Each segment there carries `channel`, and the check is
# a conjunction:
#
#   * every segment holding a word only sample A says carries A's channel,
#   * every segment holding a word only sample B says carries B's channel,
#   * and neither appears under the other, which is the half a constant label fails.
#
# Two channels means two devices, and they are provided differently on purpose:
#
#   * the microphone is the harness's virtual source, made the default input by
#     `audio-harness.sh up`. Whether that takes has been UNMEASURED since the PulseAudio
#     host landed: the harness sets `default.configured.audio.source` and the application
#     resolves `@DEFAULT_SOURCE@`, i.e. `default.audio.source`. So this script asserts the
#     application's own log names the harness source as the microphone it opened, rather
#     than trusting the harness's success message.
#   * system audio is a REAL sink monitor, picked through the dropdown the way a person
#     picks it, because that is the path #13 shipped and the harness's ALSA system side
#     predates it.
#
# Cost: a full recording per run against the seeded model cache. Minutes, and a live
# PipeWire session, so this is in the by-hand audio pass, never CI.
set -euo pipefail

APP="${1:?usage: stage2-two-channel-check.sh <AppImage> normal|swapped}"
MODE="${2:?missing mode: normal|swapped}"
case "$MODE" in normal|swapped) ;; *) echo "mode must be normal or swapped" >&2; exit 2 ;; esac

PORT="${BC_WD_PORT:-14454}"
NATIVE_PORT="${BC_WD_NATIVE_PORT:-14455}"
CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"

# Two samples with disjoint vocabularies. The words below were measured by transcribing
# each file through the application's own path, not read off the filenames -- an earlier
# round of #30 asserted words inferred from a filename and had to withdraw them.
SAMPLE_A="${BC_SAMPLE_A:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav 2>/dev/null | head -1)}"
SAMPLE_B="${BC_SAMPLE_B:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/dots.wav 2>/dev/null | head -1)}"
WORDS_A=(${BC_WORDS_A:-country ask})
WORDS_B=(${BC_WORDS_B:-connect dots})

say() { printf 'stage2-two-channel: %s\n' "$*"; }
die() { printf 'stage2-two-channel: %s\n' "$*" >&2; exit 1; }

command -v tauri-driver >/dev/null || die "tauri-driver is not installed: cargo install tauri-driver --locked"
[ -x /usr/bin/WebKitWebDriver ] || die "WebKitWebDriver is not installed: apt install webkit2gtk-driver"
[ -x "$APP" ] || die "not an executable AppImage: $APP"
[ -n "$SAMPLE_A" ] && [ -f "$SAMPLE_A" ] || die "sample A missing; set BC_SAMPLE_A"
[ -n "$SAMPLE_B" ] && [ -f "$SAMPLE_B" ] || die "sample B missing; set BC_SAMPLE_B"
[ -d "$CACHE/models" ] || die "no seeded models in $CACHE; recording is gated on them and a cold download is ~4.3 GB"

# Single-instance: `tauri_plugin_single_instance` claims a session-bus name that HOME/XDG
# isolation does not scope, so a second copy hands its argv to the first and exits.
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ] && continue
  case "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" in
    */conversationaly) die "another copy of the application is running (pid $pid); it is single-instance" ;;
  esac
done

case "$MODE" in
  normal)  MIC_SAMPLE="$SAMPLE_A"; SYS_SAMPLE="$SAMPLE_B"; MIC_WORDS=("${WORDS_A[@]}"); SYS_WORDS=("${WORDS_B[@]}") ;;
  swapped) MIC_SAMPLE="$SAMPLE_B"; SYS_SAMPLE="$SAMPLE_A"; MIC_WORDS=("${WORDS_B[@]}"); SYS_WORDS=("${WORDS_A[@]}") ;;
esac
say "mode $MODE: microphone plays $(basename "$MIC_SAMPLE") (${MIC_WORDS[*]}), system audio plays $(basename "$SYS_SAMPLE") (${SYS_WORDS[*]})"

# The sink whose monitor will be picked for system audio.
read -r TARGET_SINK TARGET_DESC <<<"$(pw-dump | python3 -c '
import json, sys
sinks = []
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("media.class") == "Audio/Sink" and not (p.get("node.name") or "").startswith("backchannel_harness"):
        sinks.append((p.get("node.name"), p.get("node.description", "")))
speaker = next((s for s in sinks if "Speaker" in s[1]), None) or (sinks[0] if sinks else None)
print(speaker[0], "|".join(speaker[1].split()) if speaker else "")')"
[ -n "$TARGET_SINK" ] || die "no Audio/Sink to target"
PICK="Monitor of ${TARGET_DESC//|/ }"
say "system audio will be '$PICK' (playing into $TARGET_SINK)"

PROFILE=""; PLAYER=""; PASSED=""; HARNESS_UP=""; PGIDFILE=""
cleanup() {
  [ -n "${SESSION:-}" ] && curl -s -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1 || true
  [ -n "${DRIVER_PID:-}" ] && kill -TERM -"$DRIVER_PID" 2>/dev/null || true
  # The player runs in its own process group and loops forever. Leaving it behind plays a
  # speech sample into the machine's real speakers until somebody notices -- which has
  # happened, for half an hour.
  [ -n "$PLAYER" ] && kill -- -"$PLAYER" 2>/dev/null || true
  [ -n "${PGIDFILE:-}" ] && rm -f "$PGIDFILE"
  sleep 1
  [ -n "${DRIVER_PID:-}" ] && kill -KILL -"$DRIVER_PID" 2>/dev/null || true
  [ -n "$HARNESS_UP" ] && scripts/audio-harness.sh down >/dev/null 2>&1 || true
  if [ -n "$PROFILE" ] && [ "$PASSED" = "1" ]; then rm -rf "$PROFILE"
  elif [ -n "$PROFILE" ]; then printf 'stage2-two-channel: profile kept: %s\n' "$PROFILE" >&2; fi
}
trap cleanup EXIT

# --- the microphone side: the harness's virtual source, made the default input ----------
scripts/audio-harness.sh down >/dev/null 2>&1 || true
scripts/audio-harness.sh up --sample "$MIC_SAMPLE" || die "the audio harness could not come up"
HARNESS_UP=1
# Read the description out of the graph rather than assuming the one the harness asks for.
# Measured 2026-09-05: `audio-harness.sh` passes
# `node.description=Backchannel harness microphone` and PipeWire reports `Backchannel` --
# for the sink too. The application logs the description, so a guard built on the requested
# string refuses a run in which the swap worked perfectly, which is what happened here.
HARNESS_DESC=$(pw-dump | python3 -c '
import json, sys
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("node.name") == "backchannel_harness_src":
        print(p.get("node.description") or "")
        break
')
[ -n "$HARNESS_DESC" ] || die "the harness source is not in the graph after a successful 'up'"
say "the harness source presents itself as '$HARNESS_DESC'"
say "harness up: the default input is now the virtual source playing $(basename "$MIC_SAMPLE")"

# --- the system side: a real sink, played into for the whole run -------------------------
# The loop reports its own pid, and that is what gets killed. `$!` after `setsid ... &` is
# not reliable: when the calling shell is already a process-group leader, setsid forks and
# exits, so `$!` names a dead process and `kill -- -$!` reaches nothing. That is how a
# speech sample was left playing into a machine's speakers for half an hour.
PGIDFILE=$(mktemp /tmp/backchannel-player-pgid.XXXXXX)
setsid bash -c "echo \$\$ > '$PGIDFILE'; while true; do pw-cat -p --target '$TARGET_SINK' '$SYS_SAMPLE' >/dev/null 2>&1 || sleep 1; done" >/dev/null 2>&1 &
for _ in $(seq 1 20); do PLAYER=$(cat "$PGIDFILE" 2>/dev/null); [ -n "$PLAYER" ] && break; sleep 0.2; done
[ -n "${PLAYER:-}" ] || die "the sample player did not report its process group"
say "looping $(basename "$SYS_SAMPLE") into $TARGET_SINK (pgid $PLAYER)"
sleep 2

PROFILE=$(mktemp -d /tmp/backchannel-two-channel.XXXXXX)
APPDATA="$PROFILE/home/.local/share/com.conversationaly.ai"
mkdir -p "$APPDATA" "$PROFILE/rec"
cp -a --reflink=auto "$CACHE/models" "$APPDATA/" 2>/dev/null || cp -a "$CACHE/models" "$APPDATA/"
cp -a "$CACHE/onboarding-status.json" "$APPDATA/" 2>/dev/null || true
printf '{"preferences":{"save_folder":"%s","auto_save":true,"file_format":"mp4","preferred_mic_device":null,"preferred_system_device":null}}' \
  "$PROFILE/rec" > "$APPDATA/recording_preferences.json"
say "seeded models from $CACHE; save_folder pinned to $PROFILE/rec"

DRIVER_LOG="$PROFILE/tauri-driver.log"
HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" \
  setsid tauri-driver --port "$PORT" --native-port "$NATIVE_PORT" > "$DRIVER_LOG" 2>&1 &
DRIVER_PID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/status" && break; sleep 0.25; done

SESSION=""
for attempt in 1 2 3 4 5; do
  RESP=$(curl -s -m 40 -X POST "http://127.0.0.1:$PORT/session" -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$APP\",\"args\":[]}}}}" || true)
  SESSION=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["value"]["sessionId"])
except Exception: print("")' 2>/dev/null)
  [ -n "$SESSION" ] && break
  if printf '%s' "$RESP" | grep -q 'session not created'; then
    printf '%s\n' "$RESP" | sed 's/^/    /' >&2; die "the driver refused to create a session"
  fi
  say "session attempt $attempt produced no answer; retrying"; sleep 2
done
[ -n "$SESSION" ] || { sed 's/^/    /' "$DRIVER_LOG" >&2; die "no WebDriver session after 5 attempts"; }
BASE="http://127.0.0.1:$PORT/session/$SESSION"
say "session up"

js() { curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' \
        -d "{\"script\":$1,\"args\":[]}" | python3 -c 'import json,sys
try: print(json.dumps(json.load(sys.stdin)["value"]))
except Exception: print("null")'; }
# Only a real element reference, never WebDriver's error object -- see stage2-ui-record-check.sh.
find_el() { curl -s -m 20 -X POST "$BASE/element" -H 'Content-Type: application/json' -d "$1" | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value")
print(next((x for k,x in v.items() if k.startswith("element-")), "") if isinstance(v,dict) else "")'; }
click() { curl -s -m 20 -X POST "$BASE/element/$1/click" -H 'Content-Type: application/json' -d '{}' >/dev/null; }
by_text() { find_el "{\"using\":\"xpath\",\"value\":\"//button[normalize-space()=\\\"$1\\\"]\"}"; }
await() { local want="$1" what="$2" secs="${3:-20}" n=0
  while [ "$n" -lt $((secs * 2)) ]; do
    [ "$(js "\"return $want\"")" = "true" ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  die "timed out after ${secs}s waiting for $what"; }

await "document.querySelectorAll('button').length > 0" 'the application to render'

# --- pick the system-audio monitor through the dropdown ----------------------------------
S=$(by_text "Settings"); [ -n "$S" ] || die "no Settings button"
click "$S"
await "document.querySelectorAll('[role=tab]').length > 0" 'the settings screen'
T=$(by_text "Recordings"); [ -n "$T" ] || die "no Recordings tab"
click "$T"
await "[...document.querySelectorAll('[role=tab]')].some(t=>t.textContent.trim()==='Recordings'&&t.getAttribute('data-state')==='active')" \
      'the Recordings tab to become active'
# Wait, do not sample once. The picker renders after `list_audio_devices` returns, and that
# call has been seen to never return: the application's own log ends on "connecting to
# PulseAudio server" after `Reactor error: Client disconnected`, and the list never arrives.
# Distinguish the two failures -- a picker that is gone from the UI, and a device
# enumeration that hung -- because conflating them would make a product regression look
# like a flaky harness.
TRIG=""
for _ in $(seq 1 60); do
  TRIG=$(find_el '{"using":"css selector","value":"#system-selection"}')
  [ -n "$TRIG" ] && break
  sleep 1
done
if [ -z "$TRIG" ]; then
  L=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1 || true)
  if [ -n "$L" ]; then
    say "the application's log ends with:"; tail -5 "$L" | sed 's/^/    /'
    if grep -q "Reactor error: Client disconnected" "$L" && ! grep -q "Audio devices listed\|device_list" "$L"; then
      die "no system-audio picker after 60s, and the log shows the PulseAudio client disconnected with no device list after it: this is the enumeration hang, not a missing control"
    fi
  fi
  die "no system-audio picker after 60s"
fi
click "$TRIG"
await "document.querySelectorAll('[role=option]').length > 0" 'the dropdown to open'
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role=\\\"option\\\"][normalize-space()=\\\"$PICK\\\"]\"}")
[ -n "$OPT" ] || die "the dropdown does not offer '$PICK'; options: $(js '"return [...document.querySelectorAll(\"[role=option]\")].map(o=>o.textContent.trim())"')"
click "$OPT"
for _ in $(seq 1 30); do
  STORED=$(python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1])); print((d.get("preferences") or d).get("preferred_system_device") or "")
except Exception: print("")' "$APPDATA/recording_preferences.json" 2>/dev/null)
  [ -n "$STORED" ] && break; sleep 0.5
done
[ "$STORED" = "$PICK (output)" ] || die "clicked '$PICK' and the app stored '${STORED:-<nothing>}'"
say "picked through the UI, stored as '$STORED'"

B=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Back\"]"}')
[ -n "$B" ] || die "no Back control on the settings screen"
click "$B"
await "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start recording')" \
      'the main screen with a Start recording button'
R=$(by_text "Start recording"); [ -n "$R" ] || die "no Start recording button"
click "$R"
say "recording"

# --- what the application actually opened -------------------------------------------------
# Condition A3. The harness's success message is about `default.configured.audio.source`;
# the application resolves `default.audio.source`. If WirePlumber declined the configured
# value the app opens the real, silent microphone and this whole run would be a system-only
# recording wearing a two-channel label.
sleep 8
LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1 || true)
[ -n "$LOG" ] || die "no application log under $APPDATA/logs"
MIC_OPENED=$(grep -o "Creating microphone stream: [^(]*" "$LOG" | tail -1 | sed 's/Creating microphone stream: //; s/ *$//' || true)
say "the app opened microphone: '${MIC_OPENED:-<none>}'"
[ -n "$MIC_OPENED" ] || die "the application never created a microphone stream; see $LOG"
if [ "$MIC_OPENED" != "$HARNESS_DESC" ]; then
  die "the application opened '$MIC_OPENED', not '$HARNESS_DESC'. The default-input swap did not take, so the microphone channel of this run carries the real device, not sample A. Fix the harness or pin preferred_mic_device; do not read this run as a two-channel result."
fi
if grep -q "Using preferred system audio" "$LOG"; then
  grep -q "Using preferred system audio: '$PICK'" "$LOG" \
    || die "the app opened a different system device than the one clicked; see $LOG"
  say "the app opened system audio: $(grep -o "Using preferred system audio: '[^']*'" "$LOG" | tail -1)"
fi

# --- let both channels accumulate, then stop ----------------------------------------------
say "recording for 90s so both samples are heard more than once"
sleep 90
STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
[ -n "$STOP" ] || die "no Stop recording control"
click "$STOP"
say "stopped; waiting for the meeting folder to be written"
for _ in $(seq 1 60); do
  JSON=$(find "$PROFILE/rec" "$APPDATA" -name transcripts.json 2>/dev/null | head -1)
  [ -n "$JSON" ] && break
  sleep 1
done
[ -n "${JSON:-}" ] || die "no transcripts.json was written under $PROFILE/rec"
say "reading $JSON"

# --- the oracle ---------------------------------------------------------------------------
MIC_WORDS_CSV=$(IFS=,; echo "${MIC_WORDS[*]}")
SYS_WORDS_CSV=$(IFS=,; echo "${SYS_WORDS[*]}")
python3 - "$JSON" "$MIC_WORDS_CSV" "$SYS_WORDS_CSV" <<'PY'
import json, sys

path, mic_csv, sys_csv = sys.argv[1], sys.argv[2], sys.argv[3]
mic_words = [w for w in mic_csv.split(',') if w]
sys_words = [w for w in sys_csv.split(',') if w]

segments = json.load(open(path)).get("segments", [])
print(f"    {len(segments)} segments")
by_channel = {}
for s in segments:
    by_channel.setdefault(s.get("channel"), 0)
    by_channel[s.get("channel")] += 1
print(f"    channels: {by_channel}")

def hits(words, channel):
    return [s for s in segments
            if any(w.lower() in s.get("text", "").lower() for w in words)
            and s.get("channel") == channel]

def any_hits(words):
    return [s for s in segments if any(w.lower() in s.get("text", "").lower() for w in words)]

problems = []

# 1 and 2: each sample's words appear, on its own channel.
for words, channel, name in ((mic_words, "you", "microphone"), (sys_words, "others", "system audio")):
    found = any_hits(words)
    if not found:
        problems.append(
            f"nothing on the {name} channel: no segment contains any of {words}. "
            f"That channel produced no recognisable transcript at all."
        )
        continue
    right = hits(words, channel)
    if not right:
        got = sorted({s.get('channel') for s in found})
        problems.append(
            f"{name}: {len(found)} segment(s) hold {words} but none carries channel "
            f"'{channel}' -- they carry {got}"
        )

# 3: and neither appears under the other. This is the half a constant label fails.
for words, wrong, name in ((mic_words, "others", "microphone"), (sys_words, "you", "system audio")):
    crossed = hits(words, wrong)
    if crossed:
        problems.append(
            f"{name}'s words landed on channel '{wrong}' in {len(crossed)} segment(s): "
            + "; ".join(repr(s.get("text", "")[:60]) for s in crossed[:3])
        )

for s in segments[:12]:
    print(f"    [{s.get('channel')}] {s.get('text','')[:70]}")

if problems:
    print("\n  FAILED:")
    for p in problems:
        print(f"    - {p}")
    sys.exit(1)
print("\n    both channels transcribed, each under its own label, neither under the other")
PY
RC=$?
[ "$RC" -eq 0 ] || die "the channel oracle failed for mode $MODE"

AUDIO=$(find "$PROFILE/rec" "$APPDATA" -type f \( -name "*.mp4" -o -name "*.wav" -o -name "*.m4a" \) 2>/dev/null | head -1)
[ -n "$AUDIO" ] || die "the recording transcribed but wrote no audio file"
say "audio written: $AUDIO ($(du -h "$AUDIO" | cut -f1))"

say "PASS ($MODE) - microphone rows say 'you', system rows say 'others', and nothing crossed"
PASSED=1

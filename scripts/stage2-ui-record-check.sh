#!/usr/bin/env bash
#
# Pick an audio device the way a person does, then record with it, and assert the transcript.
#
#   scripts/stage2-ui-record-check.sh <AppImage> signal|silence|wrong-sink [word...]
#
# This is the conjunction #13's gate had to record as uncrossed. Both halves were already
# asserted separately -- `stage2-ui-check.sh` clicks a device in the dropdown and watches the
# preference land on disk, and `stage2-record-check.sh` records with a preference written by
# hand -- but nothing joined them, so "a person picks a monitor and gets a recording of it"
# rested on an inference across two runs.
#
# They cannot simply be chained. The application is single-instance: `tauri_plugin_single_instance`
# claims a name on the session bus, which HOME/XDG isolation does not scope, so a second copy
# hands its argv to the first and exits. The conjunction needs **one** instance that both
# selects and records, which is why this is a script rather than two lines in gopnik.json.
#
# The transcript alone proves nothing about *which* channel carried the audio -- the pipeline
# mixes microphone and system before STT (pipeline.rs:1106-1118). Three things make it safe:
#
#   * `wrong-sink` plays the sample into a **different** sink than the monitor that was picked.
#     A build capturing "whatever the machine plays" passes `signal` and fails this.
#   * `silence` plays nothing, so a transcript of those words could only be a hallucination.
#   * the run asserts the application's own log names the device that was clicked, so a silent
#     fallback to another device is not mistaken for success.
#
# Cost: recording is hard-gated on the transcription model, so unlike stage2-ui-check.sh this
# needs the seeded model cache (about 1.2 GB) and takes minutes. It belongs in the audio pass
# that is run by hand, not in the cheap one.
set -euo pipefail

APP="${1:?usage: stage2-ui-record-check.sh <AppImage> signal|silence|wrong-sink [word...]}"
MODE="${2:?missing mode}"
shift 2
EXPECTED=("${@:-ask country you}")
[ $# -gt 0 ] && EXPECTED=("$@")

PORT="${BC_WD_PORT:-14444}"
NATIVE_PORT="${BC_WD_NATIVE_PORT:-14445}"
CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"
SAMPLE="${BC_SAMPLE:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav 2>/dev/null | head -1)}"

say() { printf 'stage2-ui-record-check: %s\n' "$*"; }
die() { printf 'stage2-ui-record-check: %s\n' "$*" >&2; exit 1; }

command -v tauri-driver >/dev/null || die "tauri-driver is not installed: cargo install tauri-driver --locked"
[ -x /usr/bin/WebKitWebDriver ] || die "WebKitWebDriver is not installed: apt install webkit2gtk-driver"
[ -x "$APP" ] || die "not an executable AppImage: $APP"
[ -n "$SAMPLE" ] && [ -f "$SAMPLE" ] || die "no speech sample; set BC_SAMPLE"
[ -d "$CACHE/models" ] || die "no seeded models in $CACHE; recording is gated on them and a cold download is ~4.3 GB"
case "$MODE" in signal|silence|wrong-sink) ;; *) die "mode must be signal, silence or wrong-sink" ;; esac

for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ] && continue
  case "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" in
    */conversationaly) die "another copy of the application is running (pid $pid); it is single-instance" ;;
  esac
done

# The sink whose monitor will be picked, and a different one to play into for the control.
read -r TARGET_SINK TARGET_DESC OTHER_SINK <<<"$(pw-dump | python3 -c '
import json, sys
sinks = []
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("media.class") == "Audio/Sink":
        sinks.append((p.get("node.name"), p.get("node.description", "")))
speaker = next((s for s in sinks if "Speaker" in s[1]), None) or (sinks[0] if sinks else None)
other   = next((s for s in sinks if s[0] != (speaker[0] if speaker else None)), None)
print(speaker[0], "|".join(speaker[1].split()), other[0] if other else "")')"
[ -n "$TARGET_SINK" ] || die "no Audio/Sink to target"
PICK="Monitor of ${TARGET_DESC//|/ }"
say "will pick '$PICK'"

PLAY_INTO=""
case "$MODE" in
  signal)     PLAY_INTO="$TARGET_SINK" ;;
  wrong-sink) [ -n "$OTHER_SINK" ] || die "only one sink on this machine; the wrong-sink control needs two"
              PLAY_INTO="$OTHER_SINK"; say "control: playing into $OTHER_SINK, NOT the picked monitor's sink" ;;
  silence)    say "control: playing nothing" ;;
esac

PROFILE=""
PLAYER=""
PASSED=""
cleanup() {
  [ -n "${SESSION:-}" ] && curl -s -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1 || true
  [ -n "${DRIVER_PID:-}" ] && kill -TERM -"$DRIVER_PID" 2>/dev/null || true
  [ -n "$PLAYER" ] && kill -- -"$PLAYER" 2>/dev/null || true
  sleep 1
  [ -n "${DRIVER_PID:-}" ] && kill -KILL -"$DRIVER_PID" 2>/dev/null || true
  if [ -n "$PROFILE" ] && [ "$PASSED" = "1" ]; then rm -rf "$PROFILE"
  elif [ -n "$PROFILE" ]; then printf 'stage2-ui-record-check: profile kept: %s\n' "$PROFILE" >&2; fi
}
trap cleanup EXIT

PROFILE=$(mktemp -d /tmp/backchannel-ui-record.XXXXXX)
APPDATA="$PROFILE/home/.local/share/com.conversationaly.ai"
mkdir -p "$APPDATA" "$PROFILE/rec"
cp -a --reflink=auto "$CACHE/models" "$APPDATA/" 2>/dev/null || cp -a "$CACHE/models" "$APPDATA/"
cp -a "$CACHE/onboarding-status.json" "$APPDATA/" 2>/dev/null || true
# A writable save_folder, so this exercises the configured path rather than the platform
# default. Without it the run tests only what happens when nobody has chosen a folder --
# which is worth testing too, and is what BC_NO_SAVE_FOLDER is for.
if [ -z "${BC_NO_SAVE_FOLDER:-}" ]; then
  printf '{"preferences":{"save_folder":"%s","auto_save":true,"file_format":"mp4","preferred_mic_device":null,"preferred_system_device":null}}' \
    "$PROFILE/rec" > "$APPDATA/recording_preferences.json"
  say "save_folder pinned to $PROFILE/rec"
fi
say "seeded models from $CACHE — no downloads this run"

if [ -n "$PLAY_INTO" ]; then
  setsid bash -c "while true; do pw-cat -p --target '$PLAY_INTO' '$SAMPLE' >/dev/null 2>&1 || sleep 1; done" >/dev/null 2>&1 &
  PLAYER=$!
  say "looping the sample into $PLAY_INTO"
  sleep 2
fi

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
find_el() { curl -s -m 20 -X POST "$BASE/element" -H 'Content-Type: application/json' -d "$1" | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value")
# Only a real element reference, never the error object. WebDriver answers a miss with
# {"value":{"error":"no such element",...}}, and taking its first value yields the *string*
# "no such element" -- non-empty, so every `[ -n "$X" ] || die` guard silently passes and the
# next click goes to a nonsense id. Found when this harness died with no message at all.
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

# --- pick the device the way a person does ----------------------------------------------
S=$(by_text "Settings"); [ -n "$S" ] || die "no Settings button"
click "$S"
await "document.querySelectorAll('[role=tab]').length > 0" 'the settings screen'
T=$(by_text "Recordings"); [ -n "$T" ] || die "no Recordings tab"
click "$T"
await "[...document.querySelectorAll('[role=tab]')].some(t=>t.textContent.trim()==='Recordings'&&t.getAttribute('data-state')==='active')" \
      'the Recordings tab to become active'
TRIG=$(find_el '{"using":"css selector","value":"#system-selection"}'); [ -n "$TRIG" ] || die "no system-audio picker"
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

# --- record with it ----------------------------------------------------------------------
# The back control is an icon button: aria-label, no text, so by_text cannot see it.
B=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Back\"]"}')
[ -n "$B" ] || die "no Back control on the settings screen"
click "$B"
await "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start recording')" \
      'the main screen with a Start recording button'
R=$(by_text "Start recording"); [ -n "$R" ] || die "no Start recording button"
click "$R"
say "recording"

# The application's own log must name the device that was clicked: a transcript cannot say
# which channel carried the audio, and a silent fallback to another device would otherwise
# read as success.
LOG=$(ls -t "$PROFILE"/home/.local/share/com.conversationaly.ai/logs/*.log 2>/dev/null | head -1 || true)

deadline=$((SECONDS + 240))
FOUND=""
while [ $SECONDS -lt $deadline ]; do
  TEXT=$(js '"return document.body.innerText"')
  missing=0
  for w in "${EXPECTED[@]}"; do printf '%s' "$TEXT" | grep -qi -- "$w" || missing=1; done
  [ "$missing" -eq 0 ] && { FOUND=1; break; }
  sleep 5
done

LOG=$(ls -t "$PROFILE"/home/.local/share/com.conversationaly.ai/logs/*.log 2>/dev/null | head -1 || true)
if [ -n "$LOG" ] && grep -q "Using preferred system audio" "$LOG"; then
  say "the app opened: $(grep -o "Using preferred system audio: '[^']*'" "$LOG" | tail -1)"
  grep -q "Using preferred system audio: '$PICK'" "$LOG" \
    || die "the app opened a different device than the one clicked; see $LOG"
fi

# Stop the recording before looking for audio: the file is assembled from checkpoints when
# the recording stops, so asserting while it is still running finds nothing and reads as the
# very defect this check is for. The stop control is an icon button with an aria-label.
STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
if [ -n "$STOP" ]; then
  click "$STOP"
  say "stopped; waiting for the audio to be finalised"
  for _ in $(seq 1 60); do
    [ -n "$(find "$APPDATA" "$PROFILE/rec" -type f \( -name "*.mp4" -o -name "*.wav" -o -name "*.m4a" \) 2>/dev/null | head -1)" ] && break
    sleep 1
  done
else
  say "no Stop recording control found; the audio assertion below will be about that"
fi

# The audio file, not only the transcript. Every audio pass in this repository asserted a
# transcript and none asserted a recording, so they were green while the default save folder
# resolved to a read-only path and nothing was written at all (#11). This is the assertion
# that would have caught it.
AUDIO=$(find "$APPDATA" "$PROFILE/rec" -type f \( -name "*.mp4" -o -name "*.wav" -o -name "*.m4a" \) 2>/dev/null | head -1)
if [ -n "$AUDIO" ]; then
  say "audio written: $AUDIO ($(du -h "$AUDIO" | cut -f1))"
else
  say "no audio file under $APPDATA or $PROFILE/rec"
  # `|| true`: grep exits 1 when it matches nothing, and under `set -e` that kills the script
  # right here -- silently, with no verdict printed. Same class as the guard that returned an
  # error string as an element id: a failure path that ends the run without saying anything.
  { [ -n "$LOG" ] && grep -o "Failed to initialize meeting folder.*" "$LOG" | head -1 | sed "s/^/    /"; } || true
fi

case "$MODE" in
  signal)
    [ -n "$FOUND" ] || die "the transcript never contained: ${EXPECTED[*]}"
    [ -n "$AUDIO" ] || die "the recording transcribed but wrote no audio file"
    say "PASS - picked '$PICK' in the dropdown and its recording transcribed: ${EXPECTED[*]}"
    ;;
  silence|wrong-sink)
    [ -z "$FOUND" ] || die "CONTROL FAILED: the transcript contained ${EXPECTED[*]} although the sample was ${MODE/-/ }"
    say "PASS (control: $MODE) - no transcript of ${EXPECTED[*]}, as required"
    ;;
esac
PASSED=1

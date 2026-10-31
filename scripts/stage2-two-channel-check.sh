#!/usr/bin/env bash
#
# Two people speaking at once, on the two channels, and a transcript that says which is
# which.
#
#   scripts/stage2-two-channel-check.sh <AppImage> normal|swapped|changed
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
#   changed   as normal, but the system device is changed in session (#242): monitor A is stored
#             before launch, monitor B is picked in Settings, and the sample plays only into B's
#             sink. A start that opened the stored-at-launch A records silence on the system side.
#             Then a second start is driven the way the tray drives it (a reload with
#             `autoStartRecording` set), which reaches the app before the frontend has read the store.
#             A and B are null sinks, never the default output: a both-Default start opens the default
#             output's monitor, so a B that was the default would pass the control this mode exists for.
#             Last, B's sink is removed and a start opens the default output's monitor in its place,
#             with a warning naming B (the product owner's rule on #242).
#
# In every mode, what the start opened is read from the app's log only after the start's own
# `CALLED start_recording_with_devices_and_meeting` line: first run's audio check opens the harness
# microphone by name before any start, so a grep over the whole log cannot go red (#242).
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

APP="${1:?usage: stage2-two-channel-check.sh <AppImage> normal|swapped|changed}"
MODE="${2:?missing mode: normal|swapped|changed}"
case "$MODE" in normal|swapped|changed) ;; *) echo "mode must be normal, swapped or changed" >&2; exit 2 ;; esac

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
    */backchannel|*/conversationaly) die "another copy of the application is running (pid $pid); it is single-instance" ;;
  esac
done

case "$MODE" in
  normal|changed) MIC_SAMPLE="$SAMPLE_A"; SYS_SAMPLE="$SAMPLE_B"; MIC_WORDS=("${WORDS_A[@]}"); SYS_WORDS=("${WORDS_B[@]}") ;;
  swapped) MIC_SAMPLE="$SAMPLE_B"; SYS_SAMPLE="$SAMPLE_A"; MIC_WORDS=("${WORDS_B[@]}"); SYS_WORDS=("${WORDS_A[@]}") ;;
esac
say "mode $MODE: microphone plays $(basename "$MIC_SAMPLE") (${MIC_WORDS[*]}), system audio plays $(basename "$SYS_SAMPLE") (${SYS_WORDS[*]})"

# The sink whose monitor will be picked for system audio.
SEEDED=""
if [ "$MODE" = changed ]; then
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/gate-sinks.sh"
  gate_sinks_create
  TARGET_SINK=$GATE_SINK_B
  PICK="Monitor of $GATE_DESC_B"
  SEEDED="Monitor of $GATE_DESC_A (output)"
  say "monitor A '${SEEDED% (output)}' is stored before launch; monitor B '$PICK' is picked in session"
else
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
fi
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
  [ "$MODE" = changed ] && gate_sinks_destroy
  if [ -n "$PROFILE" ] && [ "$PASSED" = "1" ]; then rm -rf "$PROFILE"
  elif [ -n "$PROFILE" ]; then kept_profile_strip "$PROFILE"; printf 'stage2-two-channel: profile kept: %s\n' "$PROFILE" >&2; fi
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

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/kept-profile.sh"
kept_profile_prune /tmp two-channel "$(kept_profile_keep_count stage2-two-channel-check.sh)"
PROFILE=$(mktemp -d /tmp/backchannel-two-channel.XXXXXX)
kept_profile_lock "$PROFILE" || die "cannot lock $PROFILE"
APPDATA="$PROFILE/home/.local/share/tech.madduck.backchannel"
mkdir -p "$APPDATA" "$PROFILE/rec"
seed_copy "$CACHE/models" "$APPDATA/" || die "could not seed $APPDATA from $CACHE/models"
cp -a "$CACHE/onboarding-status.json" "$APPDATA/" 2>/dev/null || true
python3 -c 'import json,sys
print(json.dumps({"preferences":{"save_folder":sys.argv[1],"auto_save":True,"file_format":"mp4","preferred_mic_device":None,"preferred_system_device":sys.argv[2] or None}}))' \
  "$PROFILE/rec" "$SEEDED" > "$APPDATA/recording_preferences.json"
[ -z "$SEEDED" ] || say "stored before launch: preferred_system_device = '$SEEDED'"
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
# `click` comes from the shared helper: it dies naming a refusal the driver reported, after a bounded
# wait for the transient one Radix produces on every Select close. Four passes each owned a
# `curl ... >/dev/null` until #160, and so four passes could not tell a click that landed from one
# that did not.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/webdriver.sh"
by_text() { find_el "{\"using\":\"xpath\",\"value\":\"//button[normalize-space()=\\\"$1\\\"]\"}"; }
await() { local want="$1" what="$2" secs="${3:-20}" n=0
  while [ "$n" -lt $((secs * 2)) ]; do
    [ "$(js "\"return $want\"")" = "true" ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  die "timed out after ${secs}s waiting for $what"; }

await "document.querySelectorAll('button').length > 0" 'the application to render'

# --- what a start opened, read after that start's own CALLED line (#242) ----------------------------
FAILS=()
LOG=""
called_count() { grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" 2>/dev/null || true; }
# In `changed` mode a failed start is recorded and the pass goes on: the control this mode exists for
# can fail the first start too, and only the second start shows whether the tray route holds.
fail_or_record() { if [ "$MODE" = changed ]; then FAILS+=("$1"); say "FAILED, recorded, going on: $1"; else die "$1"; fi; }
start_oracles() {  # <which start> <the CALLED count before it>
  local which=$1 before=$2 n i after line rest ok bad
  for i in $(seq 1 40); do [ "$(called_count)" -gt "$before" ] && break; sleep 0.5; done
  [ "$(called_count)" -gt "$before" ] || { fail_or_record "$which: the app logged no new CALLED line"; return 0; }
  n=$(grep -n 'CALLED start_recording_with_devices_and_meeting' "$LOG" | tail -1 | cut -d: -f1)
  line=$(sed -n "${n}p" "$LOG")
  say "$which: ${line#*\] }"
  case "$line" in *"Meeting: Some("*) ;; *) fail_or_record "$which: the start carried no meeting name" ;; esac
  # The streams are created after the start returns; wait until the system side has said how it went.
  for i in $(seq 1 40); do
    tail -n +"$n" "$LOG" | grep -q -e 'System audio stream created' -e 'Failed to create system audio stream' -e 'No system device specified' -e 'No system audio for this recording' && break
    sleep 0.5
  done
  after=$(tail -n +"$n" "$LOG")
  MIC_OPENED=$(printf '%s\n' "$after" | grep -o "Creating microphone stream: [^(]*" | head -1 | sed 's/Creating microphone stream: //; s/ *$//' || true)
  say "$which: the app opened microphone '${MIC_OPENED:-<none>}'"
  [ "$MIC_OPENED" = "$HARNESS_DESC" ] || fail_or_record "$which: after its CALLED line the app opened microphone '${MIC_OPENED:-<none>}', not the harness's '$HARNESS_DESC'. If it is the real device, the default-input swap did not take; see $LOG"
  SYS_OPENED=$(printf '%s\n' "$after" | grep -o "Creating system audio stream: .* (backend" | head -1 | sed 's/^Creating system audio stream: //; s/ (backend$//' || true)
  say "$which: the app opened system audio '${SYS_OPENED:-<none>}'"
  [ "$SYS_OPENED" = "$PICK" ] || { fail_or_record "$which: after its CALLED line the app opened system audio '${SYS_OPENED:-<none>}', not the device picked, '$PICK'"; return 0; }
  # The Creating line is written before the device is opened; the line after it says whether it was.
  rest=$(printf '%s\n' "$after" | sed -n '/Creating system audio stream: /,$p')
  ok=$(printf '%s\n' "$rest" | grep -n 'System audio stream created' | head -1 | cut -d: -f1 || true)
  bad=$(printf '%s\n' "$rest" | grep -n 'Failed to create system audio stream' | head -1 | cut -d: -f1 || true)
  if [ -z "$ok" ] || { [ -n "$bad" ] && [ "$bad" -lt "$ok" ]; }; then
    fail_or_record "$which: '$PICK' was named and then not opened; see $LOG"
  fi
  return 0
}

# --- pick the system-audio monitor through the dropdown ----------------------------------
S=$(by_text "Settings"); [ -n "$S" ] || die "no Settings button"
click "$S" "the Settings control"
await "document.querySelectorAll('[role=tab]').length > 0" 'the settings screen'
T=$(by_text "Recordings"); [ -n "$T" ] || die "no Recordings tab"
click "$T" "the Recordings tab"
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
    # `Audio devices listed` is logged by `list_audio_devices` on every return (`discovery.rs`).
    # Until #160 this branch grepped for that string and for `device_list`, and the application logged
    # **neither** -- so its condition reduced to "the PulseAudio reactor logged an error", which every
    # healthy run does, including the three that went on to pass. A slow picker was about to be
    # reported as a product defect.
    if ! grep -q "Audio devices listed" "$L"; then
      die "no system-audio picker after 60s, and the application never logged 'Audio devices listed': enumeration did not return, which is a hang rather than a missing control"
    fi
  fi
  die "no system-audio picker after 60s"
fi
click "$TRIG" "the system-audio picker"
await "document.querySelectorAll('[role=option]').length > 0" 'the dropdown to open'
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role=\\\"option\\\"][normalize-space()=\\\"$PICK\\\"]\"}")
[ -n "$OPT" ] || die "the dropdown does not offer '$PICK'; options: $(js '"return [...document.querySelectorAll(\"[role=option]\")].map(o=>o.textContent.trim())"')"
click "$OPT" "the device the pass chose"
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
click "$B" "the Back control on the settings screen"
# A wait must name something **false in the state being left**. `Start recording` is in the sidebar,
# which the settings screen does not cover, so this condition was true before the Back click and after
# it -- and on 2026-09-10 that let this pass sit on the settings screen for the whole recording window
# while reporting that the application never opened a microphone (#160). `[role=tab]` is rendered by
# `src/app/settings/page.tsx:88` and by nothing else reachable, so its absence is the settings screen
# being gone. (`components/SettingTabs.tsx` also renders tabs -- Transcript / Ai Summary / Preferences
# / About -- and is imported by nothing in `src/`.)
await "document.querySelectorAll('[role=tab]').length === 0 && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start recording')" \
      'the settings screen to close and the main screen to offer Start recording'
R=$(by_text "Start recording"); [ -n "$R" ] || die "no Start recording button"
LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1 || true)
[ -n "$LOG" ] || die "no application log under $APPDATA/logs"
if [ "$MODE" = changed ] && gate_sink_is_default "$GATE_SINK_B"; then die "monitor B's sink is the default output, so a both-Default start would open it too; this run cannot judge"; fi
BEFORE=$(called_count)
click "$R" "Start recording"
# A click that landed is a Stop control on screen. Everything below this line reads the application's
# own log, and without this assertion every way of failing to press the button arrives at the same
# sentence about the application (#160). Now the log is read only after the application was asked.
await "[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
      'the recording to start' 30
say "recording"

# --- what the application actually opened ---------------------------------------------------------
# Condition A3, and #242's 3c. The harness's success message is about `default.configured.audio.source`;
# the application resolves `default.audio.source`, so the microphone it opened is read from its own log.
# The system side is asserted unconditionally. It used to sit behind `if grep -q "Using preferred system
# audio"`, a line only one of two start paths wrote, so on the other the check checked nothing.
start_oracles "the start" "$BEFORE"

# --- let both channels accumulate, then stop ----------------------------------------------
say "recording for 90s so both samples are heard more than once"
sleep 90
STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
[ -n "$STOP" ] || die "no Stop recording control"
click "$STOP" "Stop recording"
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
RC=0
python3 - "$JSON" "$MIC_WORDS_CSV" "$SYS_WORDS_CSV" <<'PY' || RC=$?
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
[ "$RC" -eq 0 ] || fail_or_record "the channel oracle failed for mode $MODE"

# The finalised recording, not a checkpoint. `stop_and_save` merges the checkpoints into
# one file (`recording_saver.rs`), and an unsorted `find` will happily return a checkpoint
# instead -- which is how this line first reported "audio written" while naming
# `.checkpoints/audio_chunk_002.mp4`. A build that writes checkpoints and never assembles
# them would pass that, and #11 is exactly what a green audio assertion over a missing
# recording costs.
FINAL=""
for _ in $(seq 1 60); do
  FINAL=$(find "$PROFILE/rec" "$APPDATA" -type f \( -name "*.mp4" -o -name "*.wav" -o -name "*.m4a" \) \
            -not -path "*/.checkpoints/*" 2>/dev/null | head -1)
  [ -n "$FINAL" ] && break
  sleep 1
done
if [ -z "$FINAL" ]; then
  PARTS=$(find "$PROFILE/rec" "$APPDATA" -type f -path "*/.checkpoints/*" 2>/dev/null | wc -l)
  die "no finalised recording after 60s; $PARTS checkpoint file(s) exist, so audio was captured and never assembled"
fi
say "recording finalised: $FINAL ($(du -h "$FINAL" | cut -f1))"

if [ "$MODE" = changed ]; then
  # --- e. A second start, driven the way the tray drives it (#242) ---------------------------------
  # `tray.rs:110-111` sets `autoStartRecording` and reloads the window, so the start runs before the
  # frontend has read the store. Two Execute Script calls make the same two moves; the result is the
  # state after the reload, a Stop control and a new CALLED line, not either call's answer.
  await "![...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
        'the first meeting to stop' 30
  sleep 3
  if gate_sink_is_default "$GATE_SINK_B"; then die "monitor B's sink became the default output before the second start; this run cannot judge it"; fi
  BEFORE=$(called_count)
  js '"sessionStorage.setItem(\"autoStartRecording\", \"true\"); return true"' >/dev/null
  js '"window.location.assign(\"/\"); return true"' >/dev/null || true
  await "[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
        'the tray-route start to show a Stop control' 60
  start_oracles "the second start, by the tray's route" "$BEFORE"
  sleep 10
  STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
  [ -n "$STOP" ] || die "no Stop recording control after the second start"
  click "$STOP" "Stop recording, the second start"
  await "![...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
        'the second meeting to stop' 30

  # --- 4. A start's name is the meeting's name (#242) ----------------------------------------------
  # Started with a name the backend never generates, so its own `Meeting YYYY-MM-DD_HH-MM-SS` cannot
  # pass for it. The name must reach metadata.json, the folder's prefix, and the title saved from
  # `recording-stopped`. No Rust test reaches the command (no Tauri mock runtime), so the step calls
  # it the way the frontend does, through `__TAURI_INTERNALS__`, and reads the expression's own value.
  NAME="Gate meeting $(date +%s)"
  BEFORE=$(called_count)
  BODY=$(python3 -c 'import json,sys; print(json.dumps({"script": "return window.__TAURI_INTERNALS__.invoke(\"start_recording_with_devices_and_meeting\", {meetingName: arguments[0]}).then(function () { return \"RESOLVED\"; }, function (e) { return \"REJECTED:\" + String(e); });", "args": [sys.argv[1]]}))' "$NAME")
  # execute/sync waits for a returned promise, as scripts/lib/audio-check.sh relies on.
  ANSWER=$(curl -s -m 60 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$BODY" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("value"))
except Exception: print("")' || true)
  [ "$ANSWER" = RESOLVED ] || fail_or_record "the named start was refused: '${ANSWER:-<no answer>}'"
  for _ in $(seq 1 40); do [ "$(called_count)" -gt "$BEFORE" ] && break; sleep 0.5; done
  LINE=$(grep 'CALLED start_recording_with_devices_and_meeting' "$LOG" | tail -1 || true)
  case "$LINE" in *"Meeting: Some(\"$NAME\")"*) say "the named start: ${LINE#*\] }" ;; *) fail_or_record "the CALLED line does not carry '$NAME': ${LINE#*\] }" ;; esac
  sleep 8
  STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
  [ -n "$STOP" ] || die "no Stop recording control after the named start"
  click "$STOP" "Stop recording, the named start"
  META=""
  for _ in $(seq 1 60); do
    META=$(find "$PROFILE/rec" -maxdepth 2 -name metadata.json -path "*/$NAME*/*" 2>/dev/null | head -1)
    [ -n "$META" ] && break; sleep 1
  done
  if [ -z "$META" ]; then
    fail_or_record "no meeting folder starting with '$NAME' under $PROFILE/rec: $(ls "$PROFILE/rec" | tr '\n' ' ')"
  else
    say "the folder is '$(basename "$(dirname "$META")")'"
    GOT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("meeting_name") or "")' "$META" 2>/dev/null || true)
    [ "$GOT" = "$NAME" ] || fail_or_record "metadata.json says meeting_name '$GOT', not '$NAME'"
  fi
  # The saved title comes from `recording-stopped`'s meeting_name (useRecordingStop.ts), not from the
  # folder: read it where the person sees it.
  TITLED=""
  for _ in $(seq 1 60); do [ "$(js "\"return document.body.innerText.includes('$NAME')\"")" = "true" ] && { TITLED=1; break; }; sleep 0.5; done
  [ -n "$TITLED" ] && say "the saved title on screen is '$NAME'" || fail_or_record "the title '$NAME' never appeared on screen after the named meeting stopped"

  # --- f. A start whose picked device is gone (the product owner's rule on #242, 2026-10-31) ---------
  # B's sink is removed, so the stored 'Monitor of <B> (output)' names a device that is not there. The
  # start opens the default output's monitor instead and warns naming B. Read after its own CALLED line;
  # the default it resolved is the name the app itself logs, not one this pass works out.
  gate_sink_remove "$GATE_SINK_B"
  say "removed B's sink; the stored device now names nothing"
  NAME="Gate fallback $(date +%s)"
  BEFORE=$(called_count)
  BODY=$(python3 -c 'import json,sys; print(json.dumps({"script": "return window.__TAURI_INTERNALS__.invoke(\"start_recording_with_devices_and_meeting\", {meetingName: arguments[0]}).then(function () { return \"RESOLVED\"; }, function (e) { return \"REJECTED:\" + String(e); });", "args": [sys.argv[1]]}))' "$NAME")
  ANSWER=$({ curl -s -m 60 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$BODY" || true; } | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("value"))
except Exception: print("")')
  [ "$ANSWER" = RESOLVED ] || fail_or_record "the start with B gone was refused: '${ANSWER:-<no answer>}'"
  for _ in $(seq 1 40); do [ "$(called_count)" -gt "$BEFORE" ] && break; sleep 0.5; done
  if [ "$(called_count)" -le "$BEFORE" ]; then
    fail_or_record "the start with B gone logged no CALLED line"
  else
    N=$(grep -n 'CALLED start_recording_with_devices_and_meeting' "$LOG" | tail -1 | cut -d: -f1)
    for _ in $(seq 1 40); do
      tail -n +"$N" "$LOG" | grep -q -e 'System audio stream created' -e 'Failed to create system audio stream' -e 'No system audio for this recording' && break
      sleep 0.5
    done
    AFTER=$(tail -n +"$N" "$LOG")
    printf '%s\n' "$AFTER" | grep -q "The system audio device 'Monitor of $GATE_DESC_B (output)' is not available" \
      || fail_or_record "with B gone, no warning names B after the start's CALLED line"
    DEF_MON=$(printf '%s\n' "$AFTER" | grep -o "Default system audio resolved to the default sink's monitor: '[^']*'" | head -1 | sed "s/.*monitor: '//; s/'$//" || true)
    FB_OPENED=$(printf '%s\n' "$AFTER" | grep -o "Creating system audio stream: .* (backend" | head -1 | sed 's/^Creating system audio stream: //; s/ (backend$//' || true)
    say "with B gone the app resolved the default monitor '${DEF_MON:-<none>}' and opened '${FB_OPENED:-<none>}'"
    [ -n "$DEF_MON" ] && [ "$FB_OPENED" = "$DEF_MON" ] && [ "$FB_OPENED" != "$PICK" ] \
      || fail_or_record "with B gone the app opened '${FB_OPENED:-<none>}', not the default monitor it resolved ('${DEF_MON:-<none>}')"
    printf '%s\n' "$AFTER" | sed -n '/Creating system audio stream: /,$p' | grep -q 'System audio stream created' \
      || fail_or_record "with B gone the default monitor was named and then not opened"
  fi
  sleep 5
  STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
  [ -n "$STOP" ] || die "no Stop recording control after the start with B gone"
  click "$STOP" "Stop recording, the start with B gone"
  await "![...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
        'the meeting with B gone to stop' 30
fi
if [ "${#FAILS[@]}" -gt 0 ]; then
  printf 'stage2-two-channel: %s\n' "${FAILS[@]/#/FAILED: }" >&2
  die "$MODE: ${#FAILS[@]} check(s) failed"
fi

say "PASS ($MODE) - microphone rows say 'you', system rows say 'others', and nothing crossed"
[ "$MODE" = changed ] && say "PASS (changed) - both starts opened '$PICK', picked in session over '${SEEDED% (output)}' stored at launch; with it gone, the default monitor '$DEF_MON'"
PASSED=1

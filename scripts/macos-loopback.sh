#!/usr/bin/env bash
# The local WebRTC loopback peer on the development Mac (#291).
#
#   macos-loopback.sh run --in <label> --out <label> --play <wav> --seconds N
#                         [--play-to <output>] [--capture-out <input label>] [--schedule <json>]
#                         [--test key=value ...] [--no-seed] [--run-dir <dir>] [--lead S]
#                         [--also-play <wav> --also-to <output>]   a second WAV, at the same time
#
# One run, end to end:
#   1. a server on 127.0.0.1 (scripts/macos-loopback/server.py) and a fresh Chrome profile whose
#      microphone permission is seeded for exactly that origin, so labels are readable before any
#      input is opened (--no-seed leaves it out: V5);
#   2. Chrome launched through LaunchServices with -n, so Chrome itself is the process TCC asks
#      about (a binary exec'd from a shell makes the terminal responsible, measured on #281), and
#      its own --user-data-dir keeps it apart from a Chrome the user has running;
#   3. before Chrome starts, --capture-out is recorded independently and the WAV is played with
#      ffmpeg on channels 1-2 (#279), after --lead seconds of silence (default 45), into the --in
#      device (BlackHole's output side feeds its input) or to --play-to (a name or a CoreAudio UID,
#      e.g. BuiltInSpeakerDevice, which ffmpeg lists without a name). Measured on #291: with Chrome
#      holding the devices, ffmpeg opened its own 30-40 s late, so nothing is started after Chrome
#      and nothing is timed from ffmpeg's start. --seconds must cover the lead, Chrome's start and
#      the WAV;
#   4. the soundcore's output format is sampled every second from launch to exit (P6a, L2b, L2c);
#   5. Chrome is killed by its profile path, the profile removed, the tracks written as WAV, the
#      markers' sync located in side A's recording (--schedule) to place the noise window, and the
#      run judged by scripts/macos-loopback/runcheck.py.
#
# Exit: 0 when the run measured what it was asked to, 2 when it is void (the reasons are printed),
# 1 on any other failure. A void run is rerun, never read as a pass or a red.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$HERE/macos-loopback
REPO=$(cd "$HERE/.." && pwd)
CHROME_APP=${CHROME_APP:-/Applications/Google Chrome.app}
FFMPEG=${FFMPEG:-ffmpeg}
die() { echo "macos-loopback: $*" >&2; exit 1; }

[ "${1:-}" = run ] || { sed -n '2,25p' "$0"; exit 64; }
shift
IN= OUT= PLAY= PLAY_TO= SECONDS_= CAPTURE= SCHEDULE= SEED=1 RUN_DIR= LEAD=45 ALSO= ALSO_TO=
TESTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --in) IN=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --play) PLAY=$2; shift 2 ;;
    --play-to) PLAY_TO=$2; shift 2 ;;
    --seconds) SECONDS_=$2; shift 2 ;;
    --capture-out) CAPTURE=$2; shift 2 ;;
    --schedule) SCHEDULE=$2; shift 2 ;;
    --test) TESTS+=("$2"); shift 2 ;;
    --no-seed) SEED=; shift ;;
    --run-dir) RUN_DIR=$2; shift 2 ;;
    --lead) LEAD=$2; shift 2 ;;
    --also-play) ALSO=$2; shift 2 ;;
    --also-to) ALSO_TO=$2; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$IN" ] && [ -n "$OUT" ] && [ -n "$PLAY" ] && [ -n "$SECONDS_" ] || die "--in, --out, --play and --seconds are required"
[ -f "$PLAY" ] || die "no such WAV: $PLAY"
RUN_DIR=${RUN_DIR:-$REPO/experiments/loopback-runs/$(date +%Y%m%d-%H%M%S)-$$}
mkdir -p "$RUN_DIR"
PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/bc-loopback-profile.XXXXXX")

PIDS=()
CHROME_PIDS=
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  # Every process of this profile, and nothing else: the user's own Chrome has another profile.
  pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null || true
  for _ in 1 2 3 4 5; do pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null || break; sleep 1; done
  pkill -9 -f -- "--user-data-dir=$PROFILE" 2>/dev/null || true
  rm -rf "$PROFILE"
}
trap cleanup EXIT

# The input device's own current rate: what the page asks for, and what V3 compares the applied
# rate with. BlackHole 2ch runs at 44100 Hz on this Mac (measured on #291's first live run).
RATE=$(system_profiler SPAudioDataType -json 2>/dev/null | python3 -I -c '
import json, sys
want = sys.argv[1]
for item in json.load(sys.stdin).get("SPAudioDataType", []):
    for dev in item.get("_items", []):
        if dev.get("_name") == want and "coreaudio_device_input" in dev:
            print(int(dev["coreaudio_device_srate"])); sys.exit()
' "$IN") || true
# Not found: left empty, so the page's label match (P4, P5) is what voids the run, before any
# input is opened.
RATE=${RATE:-0}

python3 -I - "$RUN_DIR/params.json" "$IN" "$OUT" "$SECONDS_" "$RATE" "${TESTS[@]:-}" <<'PY'
import json, sys
path, inp, out, seconds, rate, *tests = sys.argv[1:]
test = {}
for t in tests:
    if not t:
        continue
    k, _, v = t.partition("=")
    test[k] = json.loads(v) if v else True
json.dump({"in": inp, "out": out, "seconds": float(seconds), "rate": int(rate) or None, "test": test}, open(path, "w"))
PY

python3 -I "$LIB/server.py" "$RUN_DIR" "$RUN_DIR/params.json" &
PIDS+=($!)
for _ in $(seq 1 50); do [ -s "$RUN_DIR/port" ] && break; sleep 0.1; done
PORT=$(cat "$RUN_DIR/port" 2>/dev/null) || die "the server did not start"
ORIGIN="http://127.0.0.1:$PORT"

mkdir -p "$PROFILE/Default"
if [ -n "$SEED" ]; then
  python3 -I - "$PROFILE/Default/Preferences" "$ORIGIN" <<'PY'
import json, sys
path, origin = sys.argv[1:]
grant = {f"{origin},*": {"setting": 1}}
json.dump({"profile": {"content_settings": {"exceptions": {
    "media_stream_mic": grant, "media_stream_camera": {}}}}}, open(path, "w"))
PY
fi

# The soundcore's output format, every second (HFP is 16000 Hz, 1 channel; A2DP 44100 Hz, 2).
(
  while :; do
    system_profiler SPAudioDataType -json 2>/dev/null | python3 -I -c '
import json, sys, time
d = json.load(sys.stdin)
row = {"t": time.time(), "soundcore_output": None, "steam_speakers": None}
for item in d.get("SPAudioDataType", []):
    for dev in item.get("_items", []):
        name = dev.get("_name", "")
        if name.startswith("soundcore") and "coreaudio_device_output" in dev:
            row["soundcore_output"] = [dev.get("coreaudio_device_srate"), dev.get("coreaudio_device_output")]
        if name == "Steam Streaming Speakers":
            row["steam_speakers"] = {k: dev.get(k) for k in sorted(dev) if k.startswith("coreaudio")}
print(json.dumps(row))' >> "$RUN_DIR/audio-samples.jsonl" || true
    sleep 1
  done
) &
PIDS+=($!)

wait_event() {  # wait_event <type> <seconds>
  local i
  for i in $(seq 1 "$2"); do
    grep -q "\"type\": *\"$1\"" "$RUN_DIR/events.jsonl" 2>/dev/null && return 0
    grep -q '"type": *"done"' "$RUN_DIR/events.jsonl" 2>/dev/null && return 1
    sleep 1
  done
  return 1
}

audiotoolbox_index() {  # the ffmpeg audiotoolbox output index of a device name or CoreAudio UID
  local list
  # The listing can block on the LG display's output, so it is cut off after a second (step 1).
  list=$("$FFMPEG" -nostdin -hide_banner -f lavfi -i anullsrc -t 0.01 -f audiotoolbox -list_devices true -audio_device_index 0 - 2>&1 &
         pid=$!; sleep 1; kill -9 $pid 2>/dev/null; true)
  printf '%s\n' "$list" | python3 -I -c '
import re, sys
want = sys.argv[1]
for line in sys.stdin:
    m = re.search(r"\[(\d+)\]\s*(.+?),\s*(\S+)\s*$", line)
    # A device with an input and an output is listed twice under one name; ":input" is not a sink.
    if m and want in (m.group(2).strip(), m.group(3)) and not m.group(3).endswith(":input"):
        print(m.group(1)); break' "$1"
}

PLAY_START=
if [ -n "$CAPTURE" ]; then
  # AUHAL, not ffmpeg's avfoundation input: that lost about 11 s in 100 s from BlackHole 16ch
  # (#291). The recorder counts its own gaps; a capture with any is void.
  RECORD=$REPO/experiments/bin/record
  if [ ! -x "$RECORD" ] || [ "$LIB/record.swift" -nt "$RECORD" ]; then
    mkdir -p "$(dirname "$RECORD")"
    swiftc -O -o "$RECORD" "$LIB/record.swift" || die "could not build the recorder"
  fi
  "$RECORD" "$CAPTURE" "$RUN_DIR/capture.wav" > "$RUN_DIR/capture.json" &
  RECORD_PID=$!
fi
target=${PLAY_TO:-$IN}
pi=$(audiotoolbox_index "$target"); [ -n "$pi" ] || die "no audiotoolbox output named '$target'"
PLAY_START=$(python3 -I -c 'import time; print(time.time())')
"$FFMPEG" -nostdin -hide_banner -loglevel error -i "$PLAY" \
  -af "adelay=$((LEAD * 1000)):all=1,aresample=48000,pan=stereo|c0=c0|c1=c0" \
  -f audiotoolbox -audio_device_index "$pi" - &
PIDS+=($!)
echo "{\"type\": \"play\", \"t\": $PLAY_START, \"device\": \"$target\", \"lead\": $LEAD}" >> "$RUN_DIR/events.jsonl"
if [ -n "$ALSO" ]; then
  [ -n "$ALSO_TO" ] || die "--also-play needs --also-to"
  ai=$(audiotoolbox_index "$ALSO_TO"); [ -n "$ai" ] || die "no audiotoolbox output named '$ALSO_TO'"
  "$FFMPEG" -nostdin -hide_banner -loglevel error -i "$ALSO" \
    -af "adelay=$((LEAD * 1000)):all=1,aresample=48000,pan=stereo|c0=c0|c1=c0" \
    -f audiotoolbox -audio_device_index "$ai" - &
  PIDS+=($!)
  echo "{\"type\": \"also-play\", \"device\": \"$ALSO_TO\"}" >> "$RUN_DIR/events.jsonl"
fi

open -n -a "$CHROME_APP" --args --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required "$ORIGIN/"
for _ in $(seq 1 30); do pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null && break; sleep 1; done
pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null || die "Chrome did not start"
"$CHROME_APP/Contents/MacOS/Google Chrome" --version > "$RUN_DIR/chrome-version" 2>/dev/null || true

wait_event ready 180 || true
SECS_INT=$(python3 -I -c "import math; print(math.ceil($SECONDS_))")
wait_event done $((SECS_INT + 120)) || true
sleep 1
if [ -n "${RECORD_PID:-}" ]; then kill -TERM "$RECORD_PID" 2>/dev/null || true; wait "$RECORD_PID" 2>/dev/null || true; fi
cleanup
trap - EXIT

for track in pre_send side_b; do
  [ -s "$RUN_DIR/$track.f32" ] && "$FFMPEG" -nostdin -loglevel error -y -f f32le -ar 48000 -ac 1 \
    -i "$RUN_DIR/$track.f32" -c:a pcm_s16le "$RUN_DIR/$track.wav" && rm -f "$RUN_DIR/$track.f32"
done

if [ -n "$SCHEDULE" ] && [ -f "$RUN_DIR/pre_send.wav" ]; then
  python3 -I "$LIB/markers.py" detect "$RUN_DIR/pre_send.wav" "$SCHEDULE" > "$RUN_DIR/det-pre_send.json" || true
fi
ifconfig | awk '/inet6? /{print $2}' | sed 's/%.*//' > "$RUN_DIR/interfaces"
python3 -I - "$RUN_DIR" "${SCHEDULE:-}" "${PLAY_START:-}" <<'PY'
import json, os, sys
run, schedule, play_start = sys.argv[1], sys.argv[2], sys.argv[3]
page = json.load(open(os.path.join(run, "page-record.json"))) if os.path.exists(os.path.join(run, "page-record.json")) else {}
rec = dict(page)
rec.setdefault("requested", {})
rec["interfaces"] = open(os.path.join(run, "interfaces")).read().split()
rec["chrome"] = open(os.path.join(run, "chrome-version")).read().strip() if os.path.exists(os.path.join(run, "chrome-version")) else None
rec["play_start"] = float(play_start) if play_start else None
cap = os.path.join(run, "capture.json")
if os.path.exists(cap):
    text = open(cap).read().strip()
    rec["capture"] = json.loads(text) if text else {"gaps": None, "error": "the recorder printed nothing"}
rec["events"] = [json.loads(l) for l in open(os.path.join(run, "events.jsonl"))] if os.path.exists(os.path.join(run, "events.jsonl")) else []
tap = next((e["t"] for e in rec["events"] if e.get("type") == "tap-start"), None)
det_path = os.path.join(run, "det-pre_send.json")
if schedule and tap is not None and os.path.exists(det_path):
    s = json.load(open(schedule))
    det = json.load(open(det_path))
    rec["sync_in_pre_send"] = det.get("sync_at")
    if s.get("noise_segment") is not None and det.get("sync_at") is not None:
        # The sync, found in side A's own recording, places the WAV on the page's clock.
        t0 = tap + det["sync_at"] - s["sync"] + s["noise_segment"]
        rec["noise_window"] = [t0 + 2.0, t0 + 28.0]
json.dump(rec, open(os.path.join(run, "record.json"), "w"), indent=1)
PY

echo "run: $RUN_DIR"
set +e
python3 -I "$LIB/runcheck.py" void "$RUN_DIR/record.json"
rc=$?
[ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || exit 1
exit "$rc"

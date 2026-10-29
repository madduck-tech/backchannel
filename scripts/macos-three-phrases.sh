#!/usr/bin/env bash
# #275's precondition run with no person (#281, test 4 and test 5). Needs BlackHole 2ch and
# BlackHole 16ch installed and the app running through `macos-control.sh launch`.
#
#   macos-three-phrases.sh selected   backend "Selected device"; expects P1 only in YOU,
#                                     P2 only in OTHERS, P3 in neither
#   macos-three-phrases.sh tap        backend "All system audio"; expects P3 in OTHERS (the
#                                     red signature of a global tap)
#
# Phrase matching (#281): lowercase, fold ё to е, words of four letters or more. Present = one
# row of the channel holds all of them; absent = none of them in any row of the channel;
# anything else is inconclusive and fails the run.
#
# P4 into BlackHole 2ch and P5 into BlackHole 16ch, both after P3, are the sentinels that each
# channel was still being transcribed when P3 played: without them, P3's absence could be a
# transcript that ended early (P4, YOU) or a system stream that died after P2 (P5, OTHERS; the
# gate's round 2, M2). In selected mode both must be present in their channel; P4 always.
#
# On any exit, a recording this script started is stopped and the backend is restored
# afterwards, never under it. Cleanup waits up to CLEANUP_WAIT seconds (default 1200) for a
# command still in flight: one start was measured held for 9 minutes by a TCC prompt.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CTL=$HERE/macos-control.sh
MODE=${1:?selected or tap}
case "$MODE" in selected) BACKEND=screencapturekit ;; tap) BACKEND=coreaudio ;; *) echo "selected or tap" >&2; exit 2 ;; esac

P1="Первая фраза про зелёный трактор на рассвете."
P2="Вторая реплика о синем океане и старом маяке."
P3="Третий голос считает апельсины в плетёной корзине."
P4="Четвёртая контрольная отметка завершает проверку."
P5="Пятый сигнал целиком проходит системный канал."
SPEAKERS=${SPEAKERS:-Динамики MacBook Pro}
FFMPEG=${FFMPEG:-ffmpeg}

field() { python3 -I -c 'import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"; }

before=$("$CTL" send status)
previous=$(field "$before" backend)
[ "$(field "$before" phase)" = idle ] || { echo "the app is not idle: $before" >&2; exit 1; }
work=$(mktemp -d)
cleanup() {
  local phase line deadline=$((SECONDS + ${CLEANUP_WAIT:-1200}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    line=$("$CTL" send status 2>/dev/null) || break
    phase=$(field "$line" phase)
    case "$phase" in
      starting|stopping|setting-backend) sleep 5 ;;
      recording) TIMEOUT=600 "$CTL" send stop >/dev/null || echo "cleanup: stop failed" >&2 ;;
      *) break ;;
    esac
  done
  [ "${phase:-}" != starting ] && [ "${phase:-}" != stopping ] || echo "cleanup: gave up after ${CLEANUP_WAIT:-1200}s with the app still $phase; stop it by hand" >&2
  [ -z "$previous" ] || "$CTL" send set-backend --backend "$previous" >/dev/null || echo "cleanup: could not restore backend $previous" >&2
  rm -rf "$work"
}
trap cleanup EXIT

"$CTL" send set-backend --backend "$BACKEND" >/dev/null
started=$("$CTL" send start --mic "BlackHole 2ch (input)" --system "BlackHole 16ch (output)" --meeting "three phrases $MODE")
echo "start: $started"
transcripts=$(field "$started" transcripts)

say -v Milena -o "$work/p2.aiff" "$P2"
say -v Milena -o "$work/p5.aiff" "$P5"
sleep 4
say -v Milena -a "BlackHole 2ch" "$P1"
sleep 4
# Stereo on channels 1-2: `say` into a 16-channel device writes channel 3 (#279).
index=$("$FFMPEG" -nostdin -hide_banner -f lavfi -i anullsrc -t 0.01 -f audiotoolbox -list_devices true -audio_device_index 0 - 2>&1 &
        pid=$!; sleep 1; kill -9 $pid 2>/dev/null; true)
index=$(printf '%s\n' "$index" | sed -n 's/.*\[\([0-9][0-9]*\)\] *BlackHole 16ch,.*/\1/p' | head -1)
[ -n "$index" ] || { echo "no BlackHole 16ch output" >&2; exit 1; }
to_16ch() { "$FFMPEG" -nostdin -hide_banner -loglevel error -i "$1" -af "aresample=48000,pan=stereo|c0=c0|c1=c0" -f audiotoolbox -audio_device_index "$index" -; }
to_16ch "$work/p2.aiff"
sleep 4
say -v Milena -a "$SPEAKERS" "$P3"
sleep 4
say -v Milena -a "BlackHole 2ch" "$P4"
sleep 4
to_16ch "$work/p5.aiff"
sleep 8
# Assigned, not interpolated into echo, so a failed or timed-out stop fails the run here.
stopped=$(TIMEOUT=600 "$CTL" send stop)
echo "stop: $stopped"

python3 -I - "$transcripts" "$MODE" "$P1" "$P2" "$P3" "$P4" "$P5" <<'PY'
import json, re, sys
path, mode, *phrases = sys.argv[1:]
def words(text):
    return {w for w in re.findall(r"\w+", text.lower().replace("ё", "е")) if len(w) >= 4}
sets = [words(p) for p in phrases]
for i in range(len(sets)):
    for j in range(i + 1, len(sets)):
        assert not sets[i] & sets[j], f"P{i+1} and P{j+1} share {sets[i] & sets[j]}"
rows = json.load(open(path))["segments"]
def state(ws, channel):
    texts = [words(r.get("text", "")) for r in rows if r.get("channel") == channel]
    if any(ws <= t for t in texts):
        return "present"
    if not any(ws & t for t in texts):
        return "absent"
    return "inconclusive"
got = {f"P{i+1}": {ch: state(ws, ch) for ch in ("you", "others")} for i, ws in enumerate(sets)}
print(json.dumps({"rows": len(rows), "channels": sorted({r.get("channel") for r in rows}, key=str), **got}, ensure_ascii=False))
if any("inconclusive" in v.values() for v in got.values()):
    sys.exit("inconclusive")
if got["P4"]["you"] != "present":
    sys.exit("void: the sentinel P4 is not in YOU, so the transcript may end before P3 was played")
if None in {r.get("channel") for r in rows}:
    sys.exit("void: rows without a channel, so the segmented path did not run")
expect = {
    "selected": {"P1": {"you": "present", "others": "absent"},
                 "P2": {"you": "absent", "others": "present"},
                 "P3": {"you": "absent", "others": "absent"},
                 "P4": {"you": "present", "others": "absent"},
                 "P5": {"you": "absent", "others": "present"}},
}
if mode == "selected":
    ok = got == expect["selected"]
else:  # the global tap's signature: what played to the speakers lands in OTHERS
    ok = got["P3"]["others"] == "present"
print("PASS" if ok else "FAIL", mode)
sys.exit(0 if ok else 1)
PY

#!/usr/bin/env bash
# The core, end to end: record -> a transcript on screen -> a summary. (#162)
#
# **This is the half the gate never had.** `stage2-onboarding-check.sh:22` said it in as many words --
# *"The gate never summarises"* -- and no pass had ever read a transcript on screen either: the
# recording passes read `transcripts.json`, which is the right oracle for what was captured and says
# nothing about what a person sees. Twenty Stage 2 items, and the product owner found a red `0%` on
# every line of every recording by walking the application.
#
# **It runs on a model that is not the default.** Every other transcribing pass takes
# `DEFAULT_TRANSCRIBE_MODEL`, and `parakeet` is the one family in this catalogue that reports real
# token probabilities -- so the defect this pass exists for was invisible to all of them.
# `.claude/rules/testing.md`: *"a check must not accept the default when the defect is a hardcoded
# default"*. The model is picked through the Settings UI, which nothing else drives either.
#
# **What it leaves on defaults:** the summariser (`builtin-ai` / `gemma4:e2b`), the window size, the
# template, and the summary language (Auto).
#
# **It never records the room.** The probe that found #162 left `preferred_system_device` unset, so
# system capture took the machine's real output and real speech from the room reached the transcript.
# A check that records a person's desk is a defect of its own, so the system side is pinned to the
# harness's own sink: the only thing playing into it is this pass's own sample.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
say() { printf 'stage2-core: %s\n' "$*"; }
die() { printf 'stage2-core: %s\n' "$*" >&2; exit 1; }

APP="${1:-}"; [ -n "$APP" ] || die "usage: $0 <AppImage> [scores|unscored|empty]"
MODE="${2:-scores}"
PORT="${BC_CORE_PORT:-4448}"; NATIVE_PORT="${BC_CORE_NATIVE_PORT:-4449}"
CACHE="${BC_CORE_MODELS:-$HOME/.cache/backchannel-core-models}"
# **Two modes, because one model cannot show both halves.** Neither is the default: this pass exists
# to leave `DEFAULT_TRANSCRIBE_MODEL`, which is `parakeet-tdt-0.6b-v3-q8` and is the one family in the
# catalogue that reports real token probabilities.
#
#   scores    parakeet-tdt-0.6b-v3-q4 (502 MB). **The positive sentinel, and not the default.** Of
#             eighteen architectures only four that reach the catalogue build a token row, and only
#             `parakeet` assigns a real probability (`arch/parakeet/decoder.cpp:1640`,
#             `std::exp(row[label])`). `DEFAULT_TRANSCRIBE_MODEL` is the q8 of this same family; the
#             q4 is the same architecture and the same code path, measured at mean 0.9958 over this
#             sample, so this mode proves a confidence is producible **without** taking the default.
#             An earlier draft used `moonshine-tiny-q8` here and claimed "one badge at 50%". That
#             family builds no `TokenEntry` and sets `result_kind = TRANSCRIBE_TIMESTAMPS_NONE`, so it
#             returns no tokens at any length and **cannot carry a confidence badge** — that much is
#             read from source. What the 50% was is inference: most likely the microphone meter, per
#             the selector bug recorded further down this file.
#   unscored  gigaam-v3-ctc-q8 (259 MB), reached through the catalogue. It leaves every `p` at the
#             zero sentinel, which is the family #162 was found on and the mode that goes red when
#             that fix is reverted. Russian-only, so the English sample comes back as phonetic
#             Cyrillic -- correct behaviour of that model, and why this mode asserts that rows
#             arrived rather than what they say.
#   empty     moonshine-tiny-q8 (34 MB). The **larger** half of #162 and the one the other two cannot
#             reach: both of them build token rows, so reverting the `tokens.is_empty()` guard turns
#             neither red. 53 of the catalogue's 86 rows come from an architecture that builds none,
#             and for all of them a fabricated 1.0 used to reach the tooltip as *"Decode confidence
#             100%"*. This mode is that class.
#
# **What no mode here drives.** A *rendered* badge. Every family that scores at all scores above the
# 0.8 quiet threshold on this sample, deliberately — `ConfidenceIndicator` renders nothing above it —
# and a low-confidence decode cannot be arranged from a clean recording. The rendering path has its
# positive sentinel in `a-score-nobody-gave-is-not-rendered.test.mjs`, which renders 0.45 as `45%` in
# a real DOM. So: this file proves the **value**, that file proves the **rendering**, and the tooltip
# at `VirtualizedTranscriptView.tsx:156` is driven by neither.
case "$MODE" in
  scores)   MODEL_ID="${BC_CORE_MODEL:-parakeet-tdt-0.6b-v3-q4}"; WORDS=(country "ask what you can do") ;;
  unscored) MODEL_ID="${BC_CORE_MODEL:-gigaam-v3-ctc-q8}";        WORDS=() ;;
  empty)    MODEL_ID="${BC_CORE_MODEL:-moonshine-tiny-q8}";       WORDS=(country "ask what you can do") ;;
  *) die "unknown mode '$MODE' (scores|unscored|empty)" ;;
esac
SAMPLE="${BC_SAMPLE_A:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav 2>/dev/null | head -1)}"

[ -d "$CACHE/models/summary" ] || die "no summary model in $CACHE/models/summary; this pass summarises and will not download 2.7 GB inside a gate"
[ -n "$SAMPLE" ] && [ -f "$SAMPLE" ] || die "no jfk.wav sample to play"

PROFILE=""; SESSION=""; DRIVER_PID=""; HARNESS_UP=""; PASSED=""
cleanup() {
  [ -n "$SESSION" ] && curl -s -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1
  [ -n "$DRIVER_PID" ] && kill -TERM -"$DRIVER_PID" 2>/dev/null
  sleep 1
  [ -n "$DRIVER_PID" ] && kill -KILL -"$DRIVER_PID" 2>/dev/null
  [ -n "$HARNESS_UP" ] && scripts/audio-harness.sh down >/dev/null 2>&1
  if [ -n "$PROFILE" ] && [ "$PASSED" = 1 ]; then rm -rf "$PROFILE"
  elif [ -n "$PROFILE" ]; then printf 'stage2-core: profile kept: %s\n' "$PROFILE" >&2; fi
}
trap cleanup EXIT

scripts/audio-harness.sh down >/dev/null 2>&1
scripts/audio-harness.sh up --sample "$SAMPLE" || die "the audio harness could not come up"
HARNESS_UP=1

# The system side is the harness's own sink, so nothing from the machine's speakers is recorded.
SINK_DESC=$(pw-dump | python3 -c '
import json, sys
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("node.name") == "backchannel_harness_sink":
        print(p.get("node.description") or ""); break
')
[ -n "$SINK_DESC" ] || die "the harness sink is not in the graph after a successful 'up'"
PICK="Monitor of $SINK_DESC"
say "system audio pinned to '$PICK' — this pass records its own sample, never the room"

PROFILE=$(mktemp -d /tmp/backchannel-core.XXXXXX)
APPDATA="$PROFILE/home/.local/share/com.conversationaly.ai"
mkdir -p "$APPDATA" "$PROFILE/rec"
cp -a --reflink=auto "$CACHE/models" "$APPDATA/" 2>/dev/null || cp -a "$CACHE/models" "$APPDATA/"
# **No onboarding marker.** The Settings catalogue lists every model but offers no control to select
# one already on disk, so first run is where a non-default transcription model is chosen — the same
# path `stage2-onboarding-check.sh chooses` drives. It also makes this the one pass that carries a
# person from first run through to a summary without restarting the application.
printf '{"preferences":{"save_folder":"%s","auto_save":true,"file_format":"mp4","preferred_mic_device":null,"preferred_system_device":"%s (output)"}}' \
  "$PROFILE/rec" "$PICK" > "$APPDATA/recording_preferences.json"
say "seeded models from $CACHE; save_folder pinned to $PROFILE/rec"

DRIVER_LOG="$PROFILE/tauri-driver.log"
HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" \
  setsid tauri-driver --port "$PORT" --native-port "$NATIVE_PORT" > "$DRIVER_LOG" 2>&1 &
DRIVER_PID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/status" && break; sleep 0.25; done
for attempt in 1 2 3; do
  RESP=$(curl -s -m 60 -X POST "http://127.0.0.1:$PORT/session" -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$APP\",\"args\":[]}}}}" || true)
  SESSION=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["value"]["sessionId"])
except Exception: print("")' 2>/dev/null)
  [ -n "$SESSION" ] && break
  say "session attempt $attempt produced no answer; retrying"; sleep 2
done
[ -n "$SESSION" ] || { sed 's/^/    /' "$DRIVER_LOG" >&2; die "no WebDriver session"; }
BASE="http://127.0.0.1:$PORT/session/$SESSION"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/webdriver.sh"

js() { curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' \
        -d "{\"script\":$1,\"args\":[]}" | python3 -c 'import json,sys
try: print(json.dumps(json.load(sys.stdin)["value"]))
except Exception: print("null")'; }
find_el() { curl -s -m 20 -X POST "$BASE/element" -H 'Content-Type: application/json' -d "$1" | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value")
print(next((x for k,x in v.items() if k.startswith("element-")), "") if isinstance(v,dict) else "")'; }
by_text() { find_el "{\"using\":\"xpath\",\"value\":\"//button[normalize-space()=\\\"$1\\\"]\"}"; }
text() { js '"return document.body.innerText"' | python3 -c 'import json,sys
try: print(json.load(sys.stdin) or "")
except Exception: print("")'; }
await() { local want="$1" what="$2" secs="${3:-20}" n=0
  while [ "$n" -lt $((secs * 2)) ]; do
    [ "$(js "\"return $want\"")" = "true" ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  die "timed out after ${secs}s waiting for $what"; }

await "document.querySelectorAll('button').length > 0" 'the application to render' 60
say "session up"

# --- first run: choose a transcription model that is not the default ------------------------------
await "document.body.innerText.includes('Choose a transcription model')" "the first-run screen" 90

# The recommended list is short and `gigaam` is not on it; the catalogue is where every family lives.
# Opening it is also the only way this pass can reach a family that scores nothing, which is the whole
# point of the `unscored` mode.
if ! printf '%s' "$(text)" | grep -q -- "$MODEL_ID"; then
  CAT=$(by_text "Browse every model")
  [ -n "$CAT" ] || die "$MODEL_ID is not among the recommended options and there is no 'Browse every model' button"
  click "$CAT" "the catalogue button"
  await "document.querySelector('input[type=search], input[placeholder*=Search i]') !== null" "the catalogue's search field" 20
  FIELD=$(find_el '{"using":"css selector","value":"input[type=search]"}')
  [ -n "$FIELD" ] || FIELD=$(find_el '{"using":"css selector","value":"input[placeholder*=Search i]"}')
  [ -n "$FIELD" ] || die "the catalogue has no search field to narrow it with"
  # The catalogue lists display names (`gigaam-v3-ctc (Q8)`), not catalogue ids, so the query is the
  # family part of the id. Searching for the whole id returns "no models match" — measured.
  QUERY="${MODEL_ID%-q[0-9]*}"
  curl -s -m 20 -X POST "$BASE/element/$FIELD/value" -H 'Content-Type: application/json' \
    -d "{\"text\":\"$QUERY\"}" > /dev/null
  await "document.body.innerText.includes('$QUERY')" "the catalogue row for $QUERY" 20
  say "searched the catalogue for '$QUERY'"
  # A catalogue row for a model already on disk offers `Use`; that is its selection control, and the
  # recommended list has no equivalent because its rows are radios.
  USE=$(by_text "Use")
  [ -n "$USE" ] || die "the catalogue row for $QUERY offers no 'Use' control; controls: $(js '"return [...document.querySelectorAll(\"button\")].map(b=>b.textContent.trim()).filter(Boolean).join(\" / \")"')"
  click "$USE" "the catalogue's Use control for $QUERY"
  CATALOGUE_USED=1
fi

# The recommended list wraps each option in a `<label>` around an `sr-only` radio. The catalogue has
# already made the choice through `Use`, so this whole block is skipped there.
if [ -z "${CATALOGUE_USED:-}" ]; then
MATCH="$MODEL_ID"
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//label[.//text()[contains(.,\\\"$MATCH\\\")]]\"}")
[ -n "$OPT" ] || OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radio'][.//text()[contains(.,\\\"$MATCH\\\")]]\"}")
[ -n "$OPT" ] || OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//button[.//text()[contains(.,\\\"$MATCH\\\")]]\"}")
if [ -z "$OPT" ]; then
  say "what carries the name: $(js '"return [...document.querySelectorAll(\"*\")].filter(e=>e.textContent.includes(\"'"$MODEL_ID"'\")&&e.children.length<4).slice(-3).map(e=>e.tagName+\".\"+String(e.className).slice(0,40)+\" role=\"+(e.getAttribute(\"role\")||\"-\")).join(\" | \")"')"
  die "no selectable control for $MODEL_ID on the first-run screen"
fi
click "$OPT" "the $MODEL_ID row"
# The checked option must be the one this pass clicked: `OnboardingContext.tsx:120` preselects
# `parakeet-tdt-0.6b-v3-q8`, so "something is checked" is true on arrival (#160).
await "(function(){var r=document.querySelector('input[name=transcription-model]:checked');var l=r&&r.closest('label');return !!l&&l.textContent.indexOf('$MODEL_ID')>=0;})()" \
      "$MODEL_ID to become the checked option" 10
fi
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue on the model screen"
click "$CONT" "Continue on the transcription screen"

# The summariser stays on its default, `builtin-ai`, whose model is seeded whole -- this pass
# summarises, so a partial one would turn a gate run into a 2.7 GB download.
await "document.body.innerText.includes('Where should the summary be written')" "the summariser screen" 30
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue on the summariser screen"
click "$CONT" "Continue on the summariser screen"

# Everything is on disk, so Continue is available without a download.
await "[...document.querySelectorAll('footer button')].some(b=>b.textContent.trim()==='Continue' && !b.disabled)" \
      "Continue on the download screen" 180
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue on the download screen"
click "$CONT" "Continue on the download screen"

await "document.body.innerText.includes('Check your audio')" "the audio check" 30
FIN=$(by_text "Continue"); [ -n "$FIN" ] || FIN=$(by_text "Finish"); [ -n "$FIN" ] || FIN=$(by_text "Done")
[ -n "$FIN" ] || die "nothing finishes the audio check; buttons: $(js '"return [...document.querySelectorAll(\"button\")].map(b=>b.textContent.trim()).filter(Boolean).join(\" / \")"')"
click "$FIN" "the control that finishes first run"

# First run ends by reloading the window, so wait for the application it comes back as.
await "document.body.innerText.includes('MEETINGS')" "the main screen after first run" 90
say "first run finished with $MODEL_ID chosen; the default is parakeet-tdt-0.6b-v3-q8"

# What settles the choice is the application's own stored config, not the screen.
for _ in $(seq 1 40); do
  STORED=$(python3 -c '
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    r = c.execute("select model from transcript_settings").fetchone()
    print(r[0] if r else "")
except Exception:
    print("")' "$APPDATA/meeting_minutes.sqlite")
  [ "$STORED" = "$MODEL_ID" ] && break
  sleep 0.5
done
[ "$STORED" = "$MODEL_ID" ] \
  || die "chose $MODEL_ID and the application stored '${STORED:-<nothing>}' -- this run would have transcribed with the default, which is the one family in the catalogue that reports real token probabilities"
say "stored as '$STORED'"

# --- record ---------------------------------------------------------------------------------------
# The button is gated on `hasMicrophone` (page.tsx:197), which `usePermissionCheck` probes with a
# fixed 1s backoff over 5 tries, so it can be up to five seconds late.
await "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start recording')" \
      'the Start recording control' 30
R=$(by_text "Start recording"); [ -n "$R" ] || die "no Start recording control"
click "$R" "Start recording"
await "[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
      'the recording to start' 30
say "recording for ${BC_CORE_SECONDS:-70}s"
sleep "${BC_CORE_SECONDS:-70}"

# --- the transcript, on screen ---------------------------------------------------------------------
SCREEN=$(text)
for w in "${WORDS[@]+"${WORDS[@]}"}"; do
  printf '%s' "$SCREEN" | grep -qi -- "$w" \
    || die "the transcript on screen does not contain '$w'. What is on screen: $(printf '%s' "$SCREEN" | tr '\n' ' ' | cut -c1-400)"
done
# Rows, not words: `unscored` runs a Russian-only model on an English sample, so what it decodes is
# phonetic mush and asserting on its content would be asserting on that model's failure mode. What
# matters here is that lines arrived at all -- an empty transcript makes every badge assertion below
# vacuously true, which is the shape of a check that proves nothing.
LINES=$(js '"return document.querySelectorAll(\"p\").length"')
[ "${LINES:-0}" -ge 4 ] \
  || die "only ${LINES:-0} transcript rows reached the screen; with fewer than four the badge assertions below cannot fail"
if [ "${#WORDS[@]}" -gt 0 ]; then
  say "the transcript is on screen in $LINES rows and carries: ${WORDS[*]}"
else
  say "the transcript is on screen in $LINES rows"
fi

# --- what the badges say ----------------------------------------------------------------------------
# The defect this pass was built for. `gigaam-v3-ctc` leaves every `p` at the zero sentinel
# (`transcribe-session.h:93` declares `float p = 0.0f;` and the arch never assigns it), so the mean is
# a perfectly finite 0.0 and every line carried a red `0%` reading *Low confidence*.
# A badge is legitimate when a model actually scored the line low. What is never legitimate is a badge
# on a line nobody scored, and `NaN%` on any line at all.
# Selected by the badge's own accessible name, not by `span.readout` + a percentage: the live
# microphone meter (`AudioLevelMeter.tsx:76`) renders `{rms}%` in a `span.readout` too, and a first
# version of this assertion counted the meter's `3%` as a confidence. A check that measures the wrong
# element is the same defect as the one it is guarding against.
BADGES=$(js '"return [...document.querySelectorAll(\"[aria-label^=\\\"Transcription confidence\\\"]\")].map(s=>s.textContent.trim()).join(\" \")"' \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin) or "")
except Exception: print("")')
say "confidence badges on screen: '${BADGES:-(none)}'"
printf '%s' "$BADGES" | grep -q "NaN" \
  && die "a badge reads NaN%%: a number nobody computed reached the screen"
ROWS=$(js '"return document.querySelectorAll(\"span.readout\").length"')
COUNT=$(printf '%s' "$BADGES" | tr ' ' '\n' | grep -c '%' || true)
if [ "$COUNT" -gt 0 ]; then
  ZEROS=$(printf '%s' "$BADGES" | tr ' ' '\n' | grep -c '^0%$' || true)
  [ "$ZEROS" -eq 0 ] \
    || die "$ZEROS of $COUNT badges read 0%. $MODEL_ID reports no token probabilities, so a score of zero is a number nobody computed (#162)"
fi
say "$COUNT badge(s), none of them 0%, none NaN"

STOP=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Stop recording\"]"}')
[ -n "$STOP" ] || die "no Stop control"
click "$STOP" "Stop recording"
await "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Start recording')" \
      'the recording to finish' 90
say "stopped"

# --- the disk oracle, and the positive sentinel this mode owes -------------------------------------
#
# The screen assertion above is an absence, and an absence with nothing positive beside it is
# satisfied by a run that produced no confidences at all -- which is exactly what every family except
# `parakeet` now does, correctly. So each mode asserts what `transcripts.json` carries, and the two
# assertions are opposites of each other from the same instrument:
#
#   scores    at least one row carries `confidence`, and it is a real number -- the proof that the
#             field can be produced at all, without which `unscored` proves nothing.
#   unscored  no row carries it. Reverting `scored_confidence` puts a 0.0 on every row here.
STOPPED_JSON=""
for _ in $(seq 1 60); do
  STOPPED_JSON=$(find "$PROFILE/rec" -name transcripts.json 2>/dev/null | head -1)
  [ -n "$STOPPED_JSON" ] && break
  sleep 1
done
[ -n "$STOPPED_JSON" ] || die "no transcripts.json was written under $PROFILE/rec"
CONF=$(python3 -c '
import json, sys
rows = json.load(open(sys.argv[1]))
rows = rows if isinstance(rows, list) else rows.get("transcripts", rows.get("segments", []))
have = [r["confidence"] for r in rows if isinstance(r, dict) and r.get("confidence") is not None]
print(f"{len(rows)} {len(have)} {min(have) if have else -1} {max(have) if have else -1}")' "$STOPPED_JSON")
set -- $CONF; ROWS_JSON=$1; WITH_CONF=$2; CONF_MIN=$3; CONF_MAX=$4
say "transcripts.json: $ROWS_JSON rows, $WITH_CONF of them carrying a confidence (min $CONF_MIN, max $CONF_MAX)"
[ "$ROWS_JSON" -ge 3 ] || die "only $ROWS_JSON rows in transcripts.json; too few for either assertion below to fail"
case "$MODE" in
  scores)
    [ "$WITH_CONF" -ge 1 ] \
      || die "not one row carries a confidence. $MODEL_ID is the only family that assigns a real per-token probability, so if it produces none the field is unproducible and this pass proves nothing about the absence the other mode asserts"
    # A numeric range, not a leading `0.`: parakeet's measured values run 0.92..1.0, and a run whose
    # lowest row is exactly 1.0 would fail a string match and die on a legitimate result.
    python3 -c '
import sys
lo, hi = float(sys.argv[1]), float(sys.argv[2])
sys.exit(0 if 0.0 <= lo <= hi <= 1.0 else 1)' "$CONF_MIN" "$CONF_MAX" \
      || die "the confidences in transcripts.json run $CONF_MIN..$CONF_MAX, which is not a probability"
    say "the sentinel holds: a real confidence is producible, and $WITH_CONF of $ROWS_JSON rows carry one"
    ;;
  unscored | empty)
    [ "$WITH_CONF" -eq 0 ] \
      || die "$WITH_CONF of $ROWS_JSON rows were persisted with a confidence, and $MODEL_ID scores nothing: a number nobody computed reached the disk (#162)"
    say "no row was persisted with a score nobody gave"
    ;;
esac


# --- the summary ------------------------------------------------------------------------------------
G=$(by_text "Generate Summary"); [ -n "$G" ] || G=$(by_text "Generate summary")
[ -n "$G" ] || die "no Generate Summary control after a recording; buttons: $(js '"return [...document.querySelectorAll(\"button\")].map(b=>b.textContent.trim()).filter(Boolean).slice(0,30).join(\" / \")"')"
click "$G" "Generate Summary"
say "summarising with the default summariser (builtin-ai / gemma4:e2b)"
DEADLINE=$((SECONDS + ${BC_CORE_SUMMARY_SECONDS:-420}))
SUMMARY=""
while [ $SECONDS -lt $DEADLINE ]; do
  SCREEN=$(text)
  if printf '%s' "$SCREEN" | grep -qiE "failed to (generate|process)|summary (failed|error)|no transcript text"; then
    die "the application reports a summary failure: $(printf '%s' "$SCREEN" | tr '\n' ' ' | grep -oiE '.{0,80}(failed|error).{0,80}' | head -1)"
  fi
  if printf '%s' "$SCREEN" | grep -q "Regenerate Summary"; then SUMMARY="$SCREEN"; break; fi
  sleep 10
done
[ -n "$SUMMARY" ] || die "no summary after $((${BC_CORE_SUMMARY_SECONDS:-420}))s; the screen ends: $(text | tail -c 300 | tr '\n' ' ')"

# A summary that exists is not a summary that says anything: the panel renders its headings whether or
# not the model wrote under them, so the assertion is on prose the model produced.
BODY=$(printf '%s' "$SUMMARY" | sed -n '/Regenerate Summary/,$p' | tr '\n' ' ')
LEN=$(printf '%s' "$BODY" | tr -d ' ' | wc -c)
[ "$LEN" -ge 120 ] || die "the summary panel is on screen but holds only $LEN characters of text: '$BODY'"
say "a summary was written, $LEN characters: $(printf '%s' "$BODY" | cut -c1-200)"

PASSED=1
say "PASS ($MODE) - $MODEL_ID picked through first run, its transcript is on screen with no invented score, and a summary came out of it"

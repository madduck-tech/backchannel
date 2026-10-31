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

APP="${1:-}"; [ -n "$APP" ] || die "usage: $0 <AppImage> [scores|unscored|empty|long]"
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
#   long      moonshine-streaming-small-q8 (199 MB), one of first run's four, over dots-full.wav (305 s)
#             for about 150 s of recording. **#200's run.** That family streams natively, but one stream
#             holds at most 81.9 s and committed only a meeting's first seconds, so the application
#             decodes it in VAD segments. The oracle: rows whose recording-relative audio starts past
#             100 s carry words, and the rows carry a channel, `you` among them, which only the
#             segmented path writes (`streaming.rs` sets `channel: None`). The row is chosen in the
#             catalogue, not on the recommended list it also sits on, and the pass does not summarise.
#             What it leaves alone: small only (tiny and medium reach first run through the instrument
#             `a_capped_stream_keeps_the_whole_meeting`), the CPU, and the same sample on both channels.
#             What its seeding hides: the first-run download of the 199 MB row, which is on disk before
#             first run starts.
#   empty     moonshine-tiny-q8 (35 MB). The **larger** half of #162 and the one the other two cannot
#             reach: both of them build token rows, so reverting the `tokens.is_empty()` guard turns
#             neither red. 53 of the 86 rows the catalogue had at #162 come from an architecture that builds none,
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
  # No vocabulary: which words fall inside the recording depends on how long first run took to reach it.
  long)     MODEL_ID="${BC_CORE_MODEL:-moonshine-streaming-small-q8}"; WORDS=() ;;
  *) die "unknown mode '$MODE' (scores|unscored|empty|long)" ;;
esac
if [ "$MODE" = long ]; then
  SAMPLE="${BC_SAMPLE_A:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/dots-full.wav 2>/dev/null | head -1)}"
  [ -n "$SAMPLE" ] && [ -f "$SAMPLE" ] || die "no dots-full.wav sample to play"
  ls "$CACHE"/models/moonshine-streaming-small-Q8_0.gguf >/dev/null 2>&1 \
    || die "no moonshine-streaming-small-Q8_0.gguf in $CACHE/models; this pass seeds its model and will not download inside a gate"
else
  SAMPLE="${BC_SAMPLE_A:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav 2>/dev/null | head -1)}"
fi

[ -d "$CACHE/models/summary" ] || die "no summary model in $CACHE/models/summary; this pass summarises and will not download 2.7 GB inside a gate"
[ -n "$SAMPLE" ] && [ -f "$SAMPLE" ] || die "no jfk.wav sample to play"

PROFILE=""; SESSION=""; DRIVER_PID=""; HARNESS_UP=""; PASSED=""; GRAPH_PID=""; STARTED=""
cleanup() {
  # A second TERM or INT during the teardown would end the shell before the recordings are dropped.
  trap '' INT TERM
  # Bounded, since INT and TERM no longer end a hung teardown.
  [ -n "$SESSION" ] && curl -s -m 10 -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1
  [ -n "$DRIVER_PID" ] && kill -TERM -"$DRIVER_PID" 2>/dev/null
  sleep 1
  [ -n "$DRIVER_PID" ] && kill -KILL -"$DRIVER_PID" 2>/dev/null
  # From the Start click on, any failure may have recorded a microphone the guard did not prove, so the
  # recordings go as soon as the application can no longer write them, before the profile is kept (#293).
  [ -n "$PROFILE" ] && [ "$PASSED" != 1 ] && [ -n "$STARTED" ] && { harness_guard_drop_recordings "$PROFILE" || say "the recordings in $PROFILE were NOT removed"; }
  [ -n "$GRAPH_PID" ] && kill -TERM "$GRAPH_PID" 2>/dev/null
  # Not silenced: a restore that fails on a dying run must say so here, not only in the next run.
  type tone_sink_destroy >/dev/null 2>&1 && { tone_sink_destroy || say "the default output was NOT put back; run 'bash scripts/lib/tone-sink.sh restore'"; }
  [ -n "$HARNESS_UP" ] && scripts/audio-harness.sh down >/dev/null 2>&1
  if [ -n "$PROFILE" ] && [ "$PASSED" = 1 ]; then rm -rf "$PROFILE"
  elif [ -n "$PROFILE" ]; then kept_profile_strip "$PROFILE"; printf 'stage2-core: profile kept: %s\n' "$PROFILE" >&2; fi
}
trap cleanup EXIT

# The harness never becomes the default input (#293): it comes up with `--system-only`, under a source name
# no WirePlumber stack holds, and the microphone is named in the seed below. A capture that follows the
# default, a call's microphone in a browser tab, stays on the person's own device for the whole entry.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/harness-guard.sh"
scripts/audio-harness.sh down >/dev/null 2>&1
DEFAULT_SRC_BEFORE=$(harness_effective_source)
scripts/audio-harness.sh up --system-only --sample "$SAMPLE" || die "the audio harness could not come up"
HARNESS_UP=1
GUARD=$(harness_guard_after_up "$DEFAULT_SRC_BEFORE" 2>&1) || die "the harness moved the default input (#293): $GUARD"
HARNESS_SRC=$(scripts/audio-harness.sh src-name) || die "the harness names no source"
# Its description, read from the graph: pw-loopback keeps only `Backchannel` of the one it asks for.
HARNESS_DESC=$(harness_description "$HARNESS_SRC") || die "the audio graph could not be read"
[ -n "$HARNESS_DESC" ] || die "the harness source $HARNESS_SRC is not in the graph"
MIC_SEED="$HARNESS_DESC (input)"
# Before the application starts, so the audio check's device list contains the tone sink's monitor.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/tone-sink.sh"
tone_sink_create

# The system side is the harness's own sink, so nothing from the machine's speakers is recorded.
# Through the shared reader: one `json.load` of a split `pw-dump` failed entry 27 on 2026-10-31.
SINK_DESC=$(harness_description backchannel_harness_sink) || die "the audio graph could not be read"
[ -n "$SINK_DESC" ] || die "the harness sink is not in the graph after a successful 'up'"
PICK="Monitor of $SINK_DESC"
say "system audio pinned to '$PICK' — this pass records its own sample, never the room"

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/kept-profile.sh"
kept_profile_prune /tmp core "$(kept_profile_keep_count stage2-core-check.sh)"
PROFILE=$(mktemp -d /tmp/backchannel-core.XXXXXX)
kept_profile_lock "$PROFILE" || die "cannot lock $PROFILE"
APPDATA="$PROFILE/home/.local/share/tech.madduck.backchannel"
mkdir -p "$APPDATA" "$PROFILE/rec"
seed_copy "$CACHE/models" "$APPDATA/" || die "could not seed $APPDATA from $CACHE/models"
# **No onboarding marker.** The Settings catalogue lists every model but offers no control to select
# one already on disk, so first run is where a non-default transcription model is chosen — the same
# path `stage2-onboarding-check.sh chooses` drives. It also makes this the one pass that carries a
# person from first run through to a summary without restarting the application.
printf '{"preferences":{"save_folder":"%s","auto_save":true,"file_format":"mp4","preferred_mic_device":"%s","preferred_system_device":"%s (output)"}}' \
  "$PROFILE/rec" "$MIC_SEED" "$PICK" > "$APPDATA/recording_preferences.json"
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
if [ "$MODE" = long ] || ! printf '%s' "$(text)" | grep -q -- "$MODEL_ID"; then
  CAT=$(by_text "Browse every model")
  [ -n "$CAT" ] || die "$MODEL_ID is not among the recommended options and there is no 'Browse every model' button"
  click "$CAT" "the catalogue button"
  # False before the click: the catalogue is not on screen until it is asked for.
  await "document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]').length > 1" "the catalogue's rows" 20
  FIELD=$(find_el '{"using":"css selector","value":"input[type=search]"}')
  [ -n "$FIELD" ] || die "the catalogue has no search field to narrow it with"
  # First run's search matches the whole id since #166. It used to match display names
  # (`gigaam-v3-ctc (Q8)`), so this typed the family part of the id instead.
  type_into "$FIELD" "$MODEL_ID" "the catalogue's search field"
  # False before typing: the unfiltered list holds rows that do not carry the id. The wait that stood
  # here, for the page to contain the query, was true before anything was typed (#166).
  await "(function(){var r=[...document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]')];return r.length>0&&r.every(function(e){return e.textContent.indexOf('$MODEL_ID')>=0;});})()" \
        "the search to narrow the catalogue to $MODEL_ID" 20
  say "searched the catalogue for '$MODEL_ID'"
  # The row is the choice, inside the catalogue's own radiogroup. This pressed `Use`, which the
  # Settings card offered only because the pass had seeded the file; a row not on disk had no control.
  ROW=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radiogroup'][@aria-label='Models']//*[@role='radio'][.//text()[.='$MODEL_ID']]\"}")
  [ -n "$ROW" ] || die "no row for $MODEL_ID inside the catalogue's radiogroup"
  CHECKED=$(curl -s -m 20 "$BASE/element/$ROW/attribute/aria-checked" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))')
  [ "$CHECKED" = "false" ] || die "the $MODEL_ID row reads aria-checked=$CHECKED before it was chosen"
  click "$ROW" "the catalogue row for $MODEL_ID"
  await "(function(){var r=[...document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]')].find(function(e){return e.textContent.indexOf('$MODEL_ID')>=0;});return !!r&&r.getAttribute('aria-checked')==='true';})()" \
        "the $MODEL_ID row to read aria-checked=true" 10
  CATALOGUE_USED=1
fi

# The recommended list wraps each option in a `<label>` around an `sr-only` radio. The catalogue has
# already made the choice through its row, so this whole block is skipped there.
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

# --- the audio check, with a microphone speaking a known sentence (#168) ---------------------------
#
# The one pass that can hold this screen to its promise, *"This proves each one with words, not a
# moving bar"*, because the harness is speaking `jfk.wav` into a virtual source. The onboarding pass
# presses the same control with no signal and accepts silence (#167); here silence is a failure.
#
# Pick the harness's own source, by name: this screen checks the device in its picker, whose first entry
# is whatever the machine lists first, and the harness is not the default input (#293). The description
# PipeWire reports was read back from the graph by this run's source name, above, never assumed (see the
# two-channel note in `gopnik.json`). The picker is a Radix `Select`, so it is opened and its option
# clicked, as a person does it.
TRIG=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Microphone\"]"}')
[ -n "$TRIG" ] || die "no microphone picker on the audio check"
click "$TRIG" "the microphone picker"
await "document.querySelectorAll('[role=option]').length > 0" "the microphone list to open" 15
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='option'][contains(normalize-space(),\\\"$HARNESS_DESC\\\")]\"}")
[ -n "$OPT" ] || die "the audio check does not offer the harness microphone '$HARNESS_DESC'; it offers: $(js '"return [...document.querySelectorAll(\"[role=option]\")].map(o=>o.textContent.trim()).join(\" | \")"')"
click "$OPT" "the harness microphone"
await "(function(){var t=document.querySelector('button[aria-label=Microphone]');return !!t&&t.textContent.indexOf('$HARNESS_DESC')>=0;})()" \
      "the picker to show the harness microphone" 10

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/audio-check.sh"
audio_check_press
[ "$(audio_check_field "$AUDIO_CHECK" kind)" = HEARD ] \
  || die "the harness microphone is speaking and the check did not return words: '$(audio_check_field "$AUDIO_CHECK" outcome)'"

# The application's own log, read through `$LOG` so `a-gate-oracle-reads-a-line-the-app-writes.test.mjs`
# holds every pattern below to a string the Rust writes.
LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1)
[ -n "$LOG" ] || die "the application wrote no log under $APPDATA/logs"

# **One side, by count.** Decoders and the loop position cannot move this number, so it is what holds
# the interleaving (#168). `LISTEN` is read from the source the AppImage was built from, and the pass
# fails closed without it. The band is (LISTEN - 1 s) .. (LISTEN + 0.5 s) at 16 kHz, and it assumes
# pipewire-pulse delivery, which the harness requires. Both sides interleaved measured 195 198 for
# six seconds.
BUILT_FROM=$(tr -d '[:space:]' < "$APP.built-from" 2>/dev/null)
[ -n "$BUILT_FROM" ] || die "no $APP.built-from, so this pass cannot read the LISTEN the binary was built with"
LISTEN_S=$(git show "$BUILT_FROM:frontend/src-tauri/src/audio/device_check.rs" 2>/dev/null \
  | grep -oE 'const LISTEN: Duration = Duration::from_secs\([0-9]+\)' | grep -oE '[0-9]+\)' | tr -d ')')
[ -n "$LISTEN_S" ] || die "could not read LISTEN from device_check.rs at $BUILT_FROM"
SAMPLES=$(grep -oE "Device check on [^:]+: [0-9]+ samples" "$LOG" | tail -1 | grep -oE '[0-9]+ samples' | grep -oE '[0-9]+')
[ -n "$SAMPLES" ] || die "the application logged no 'Device check on' line, so nothing says what the decoder was handed"
LO=$(( (LISTEN_S - 1) * 16000 )); HI=$(( LISTEN_S * 16000 + 8000 ))
say "the check handed the decoder $SAMPLES samples for a ${LISTEN_S}s window (one side: $LO..$HI)"
[ "$SAMPLES" -ge "$LO" ] && [ "$SAMPLES" -le "$HI" ] \
  || die "the decoder was handed $SAMPLES samples for a ${LISTEN_S}s window. One side is $LO..$HI; both sides interleaved is about $((LISTEN_S * 32000)). The check is not hearing one device"

# **Which model.** `engine.rs:224` logs `Loading model <id> from <path>` before every load. A check that
# loads the default for someone who chose another passes every assertion that takes the default.
LOADED=$(grep -oE "Loading model [a-z0-9._-]+" "$LOG" | tail -1 | awk '{print $3}')
say "the model the application loaded for the check: '${LOADED:-<not stated in the log>}'"
[ "$LOADED" = "$MODEL_ID" ] \
  || die "the audio check decoded with '${LOADED:-<unknown>}' and the person chose '$MODEL_ID'"

# **Words, from the decoded text alone.** `gigaam-v3-ctc` is Russian-only and answers this English
# sample in phonetic Cyrillic, so `unscored` asserts the count and the model and not the vocabulary.
if [ ${#WORDS[@]} -gt 0 ]; then
  N=$(audio_check_field "$AUDIO_CHECK" sampleWords)
  [ "$N" -ge 3 ] \
    || die "the check decoded '$(audio_check_field "$AUDIO_CHECK" decoded)', which holds $N distinct words of the sample; three are required"
  say "the decoded text holds $N distinct words of the sample: $(audio_check_field "$AUDIO_CHECK" decoded)"
fi

# --- the system row: the tone, pressed in the running application (#168, #173) ---------------------
#
# The tone plays through the default output, which for this one press is `lib/tone-sink.sh`'s null
# sink, so it never sounds in the person's speakers; the row listens on that sink's monitor. Until
# #173 the AppImage had no GStreamer plugins, Web Audio had no output, and this press answered
# `Nothing arrived`. The row's answer alone cannot say *what* arrived, because WirePlumber moves
# streams already playing into a new default output; so the graph is sampled across the press
# (`lib/tone-graph.py`) and every link into the sink must come from WebKit.
STRIG=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"The other side is heard through\"]"}')
[ -n "$STRIG" ] || die "no system picker on the audio check"
click "$STRIG" "the system picker"
await "document.querySelectorAll('[role=option]').length > 0" "the system list to open" 15
SOPT=$(find_el '{"using":"xpath","value":"//*[@role=\"option\"][contains(normalize-space(),\"Backchannel tone sink\")]"}')
[ -n "$SOPT" ] || die "the audio check does not offer the tone sink's monitor; it offers: $(js '"return [...document.querySelectorAll(\"[role=option]\")].map(o=>o.textContent.trim()).join(\" | \")"')"
click "$SOPT" "the tone sink's monitor"
await "(function(){var t=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')==='The other side is heard through');return !!t&&t.textContent.indexOf('Backchannel tone sink')>=0;})()" \
      "the system picker to show the tone sink's monitor" 10

GRAPH="$PROFILE/tone-graph.jsonl"
# The driver's pid is the root of the application's process tree: a link counts as the tone only
# from a WebKitWebProcess under it, not from any WebKitGTK program on the machine.
python3 -I scripts/lib/tone-graph.py watch "$TONE_SINK_ID" "$DRIVER_PID" "$GRAPH" &
GRAPH_PID=$!
tone_sink_make_default
audio_check_press "The other side is heard through" "Play a tone and listen"
kill -TERM "$GRAPH_PID" 2>/dev/null; wait "$GRAPH_PID" 2>/dev/null; GRAPH_PID=""

# What Web Audio does here, after the press so the tone was the web process's first context: the
# context's states and what `resume()` did. It is a check, not only a record: a context that does not
# reach `running` here means the tone above did not play either, whatever the row said. It runs after
# the sampler stops, so its own link cannot stand in for the tone's. It runs before the restore, so
# its silent stream opens in the null sink, not in the person's headset.
PROBE=$(python3 -c 'import json,sys; print(json.dumps({"script": open(sys.argv[1]).read(), "args": []}))' scripts/lib/web-audio-probe.js \
  | curl -s -m 20 -X POST "$BASE/execute/async" -H 'Content-Type: application/json' -d @- \
  | python3 -c 'import json,sys
try: v = json.load(sys.stdin).get("value")
except Exception: v = None
print(v if isinstance(v, str) else "the probe did not answer: " + repr(v)[:200])')
say "Web Audio in this build: $PROBE"
tone_sink_restore || die "the default output could not be put back; run 'bash scripts/lib/tone-sink.sh restore'"

# Every judgement is made before any of them fails the pass, so a red run shows all of them.
TONE_FAILS=()
case "$(audio_check_field "$AUDIO_CHECK" kind)" in
  NO_WORDS|HEARD) ;;
  *) TONE_FAILS+=("the row: '$(audio_check_field "$AUDIO_CHECK" outcome)'") ;;
esac
# Pinned to the tone sink's monitor: the microphone row's line says audio=true too.
SYS_LINE=$(grep -oE "Device check on Monitor of Backchannel tone sink: [0-9]+ samples, audio=(true|false)" "$LOG" | tail -1)
SYS_SAMPLES=$(printf '%s' "$SYS_LINE" | grep -oE '[0-9]+ samples' | grep -oE '[0-9]+')
say "the system check: ${SYS_LINE:-no line in the log for the monitor of the tone sink} (one side: $LO..$HI)"
[ -n "$SYS_SAMPLES" ] && [ "$SYS_SAMPLES" -ge "$LO" ] && [ "$SYS_SAMPLES" -le "$HI" ] \
  || TONE_FAILS+=("${SYS_SAMPLES:-no} samples for a ${LISTEN_S}s window; one side is $LO..$HI")
case "$SYS_LINE" in *audio=true) ;; *) TONE_FAILS+=("the application heard no audio: '${SYS_LINE:-no line}'") ;; esac
VERDICT=$(python3 -I scripts/lib/tone-graph.py judge "$GRAPH") || TONE_FAILS+=("the graph: $VERDICT")
say "the tone sink, across the press: $VERDICT"
printf '%s' "$PROBE" | python3 -c 'import json,sys
v = json.loads(sys.stdin.read())
sys.exit(0 if v.get("final") == "running" and v.get("resume") == "resolved" else 1)' 2>/dev/null \
  || TONE_FAILS+=("Web Audio did not start: $PROBE")
[ ${#TONE_FAILS[@]} -eq 0 ] || die "the tone did not play into the default output and reach its monitor: $(printf '%s | ' "${TONE_FAILS[@]}")"

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
GUARD=$(harness_guard_before_start "$APPDATA/recording_preferences.json" "$MIC_SEED" "$HARNESS_SRC" 2>&1) \
  || die "before Start (#293): $GUARD"
BEFORE=$(grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" || true)
STARTED=1
click "$R" "Start recording"
await "[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Stop recording')" \
      'the recording to start' 30
# The microphone the start opened, read only after the start's own CALLED line (#242). First run's audio
# check opens the harness microphone by name before any start, so a grep over the whole log could not go
# red.
for _ in $(seq 1 40); do [ "$(grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" || true)" -gt "$BEFORE" ] && break; sleep 0.5; done
[ "$(grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" || true)" -gt "$BEFORE" ] || die "the app logged no CALLED line for this start; see $LOG"
N=$(grep -n 'CALLED start_recording_with_devices_and_meeting' "$LOG" | tail -1 | cut -d: -f1)
for _ in $(seq 1 40); do tail -n +"$N" "$LOG" | grep 'Creating microphone stream: ' >/dev/null && break; sleep 0.5; done
STARTED_MIC=$(tail -n +"$N" "$LOG" | grep -o "Creating microphone stream: [^(]*" | head -1 | sed 's/Creating microphone stream: //; s/ *$//' || true)
say "after its CALLED line the start opened microphone '${STARTED_MIC:-<none>}'"
[ "$STARTED_MIC" = "$HARNESS_DESC" ] || die "the start opened microphone '${STARTED_MIC:-<none>}', not the harness's '$HARNESS_DESC'; see $LOG"
# What opened, from the log after the start, and the link from this run's source into a capture of the
# application under the driver that launched it, which shows it did (#293).
for _ in $(seq 1 40); do tail -n +"$N" "$LOG" | grep 'Microphone stream created successfully' >/dev/null && break; sleep 0.5; done
GUARD=$(harness_guard_after_start "$LOG" "$N" "$HARNESS_DESC" "$HARNESS_SRC" 20 "$DRIVER_PID" 2>&1) \
  || die "after Start (#293): $GUARD"
say "the start opened the harness microphone by name, and the graph links $HARNESS_SRC into the application"
RECORD_S="${BC_CORE_SECONDS:-$([ "$MODE" = long ] && echo 150 || echo 70)}"
say "recording for ${RECORD_S}s"
sleep "$RECORD_S"

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
  long)
    # Before #200 the stream path held one stream for the whole meeting: past its 81.9 s cap it took
    # nothing more, so no row started past 100 s, and every row carried `channel: None`.
    python3 -I - "$STOPPED_JSON" <<'PY' || die "$MODEL_ID did not transcribe the whole recording (#200); the rows are above"
import json, sys
rows = json.load(open(sys.argv[1]))
rows = rows if isinstance(rows, list) else rows.get("transcripts", rows.get("segments", []))
late = [r for r in rows if (r.get("audio_start_time") or 0) > 100]
late_words = sum(len((r.get("text") or "").split()) for r in late)
channels = sorted({str(r.get("channel")) for r in rows})
for r in rows[-6:]:
    print(f"    {r.get('audio_start_time')!s:>8}s [{r.get('channel')}] {(r.get('text') or '')[:70]}")
print(f"    {len(rows)} rows; {len(late)} start past 100 s, holding {late_words} words; channels {channels}")
problems = []
if late_words < 10:
    problems.append(f"rows past 100 s hold {late_words} words; at least 10 are required")
if any(r.get("channel") is None for r in rows):
    problems.append("a row carries no channel, which only the stream path writes")
if not any(r.get("channel") == "you" for r in rows):
    problems.append("no row carries the `you` channel, the sentinel that the segmented path ran")
for p in problems:
    print("    FAILED: " + p)
sys.exit(1 if problems else 0)
PY
    say "the whole recording was transcribed: rows past 100 s carry words, on the segmented path"
    ;;
  unscored | empty)
    [ "$WITH_CONF" -eq 0 ] \
      || die "$WITH_CONF of $ROWS_JSON rows were persisted with a confidence, and $MODEL_ID scores nothing: a number nobody computed reached the disk (#162)"
    say "no row was persisted with a score nobody gave"
    ;;
esac


# --- the action bar, measured in the application (#165) ------------------------------------------
#
# The product owner photographed the bar as a 26 px column, and saw it again in this pass's own window.
# Nothing in the gate had ever read a layout in the application: the geometry checks ran in Chrome on a
# story. This reads the bar on the meeting page, in WebKitGTK, at the window the pass runs. N comes from
# the class in the component at the AppImage's own revision, never from a copy here.
await "!!document.querySelector('[role=toolbar]')" "the meeting page's action bar" 30
BAR_N=$(git show "$BUILT_FROM:frontend/src/components/MeetingDetails/MeetingActionBar.tsx" 2>/dev/null \
  | grep -oE '@\[[0-9]+px\]/bar:' | head -1 | grep -oE '[0-9]+')
[ -n "$BAR_N" ] || die "could not read the bar's breakpoint from MeetingActionBar.tsx at $BUILT_FROM"
BAR=$(python3 -c 'import json,sys; print(json.dumps({"script": open(sys.argv[1]).read(), "args": []}))' \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/meeting-bar-read.js" \
  | curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d @- \
  | python3 -c 'import json,sys
try: v = json.load(sys.stdin).get("value")
except Exception: v = None
print(v if isinstance(v, str) else json.dumps({"found": False}))')
bar() { python3 -c 'import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print("" if v is None else (round(v,1) if isinstance(v,float) else v))' "$BAR" "$1"; }
[ "$(bar found)" = "True" ] || die "harness: could not read the action bar ($BAR)"
say "the action bar: room $(bar room)px (window $(bar innerWidth)px), bar $(bar width) x $(bar height), breakpoint ${BAR_N}px; rendered: [$(bar three)], \`•••\` $(bar trigger)"
python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)' "$(bar room)" "$BAR_N" \
  || die "the bar has $(bar room)px of room, below its ${BAR_N}px breakpoint, so this pass would see the narrow arrangement and the wide one it exists to check would go untested"
python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)' "$(bar height)" "$(bar oneRowMax)" \
  || die "the action bar is $(bar width) x $(bar height) in the application: not one row (at most $(bar oneRowMax))"
[ "$(bar outside)" = 0 ] || die "$(bar outside) of the action bar's controls lie outside its box in the application"
[ "$(bar three)" = "['Retranscribe', 'Speakers', 'Open folder']" ] \
  || die "at $(bar room)px of room the bar must render Retranscribe, Speakers and Open folder; it renders [$(bar three)]"
[ "$(bar trigger)" = False ] || die "at $(bar room)px of room the bar must render no \`•••\`; it does"
say "the action bar is one row that fits, in the wide arrangement, in the application"

if [ "$MODE" = long ]; then
  PASSED=1
  say "PASS (long) - $MODEL_ID chosen in first run's catalogue, and a ${RECORD_S}s recording of dots-full.wav was transcribed past its first 100 s, on the segmented path"
  exit 0
fi

# --- the summary ------------------------------------------------------------------------------------
# Waited for, not assumed. After Stop the meeting page renders a moment later, and the lookup used to
# run straight away: on 2026-10-24 (round 4 of #168's gate) it found nothing, and the button list the
# failure printed a moment later did contain it. The recording screen has no such button, so this is
# false in the state being left.
await "[...document.querySelectorAll('button')].some(b=>/^Generate [Ss]ummary$/.test(b.textContent.trim()))" \
      "the meeting page's Generate Summary control" 30
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
# not the model wrote under them, so the assertion is on prose the model produced. `lib/summary-prose.js`
# says what prose is (no headings, no all-bold titles in any language, no repeated placeholder) and
# counts characters, not bytes; `summary-prose-oracle.test.mjs` runs the same file in jsdom. Its count
# of titles is printed, as the sentinel that the titles were found in this build's editor at all.
#
# History: until #171 this counted the panel's whole text, so 90 characters of controls plus 50 of
# titles passed a bar of 120 with no prose. #171's first fix filtered the four English titles and
# counted bytes, which passed four translated titles alone in `unscored` (126 bytes, 63 letters).
#
# "Regenerate Summary" appears as soon as the summary's data arrives (`hasSummary={!!aiSummary}`), and the
# editor parses the markdown into blocks after that. So its appearance is true before the text is on
# screen: #171's gate read the panel at that moment and found 90 characters of controls, while the
# summary had been written and stored. Wait for the prose itself, and fail only if it never comes.
PROSE_REQ=$(python3 -I -c 'import json,sys; print(json.dumps({"script": open(sys.argv[1]).read(), "args": []}))' scripts/lib/summary-prose.js)
PROSE=""; LEN=0
for _ in $(seq 1 30); do
  # Only a JSON string from the script is an answer: an error object is longer than the bar, and a
  # driver's refusal is a result (#160), not text.
  PROSE=$(printf '%s' "$PROSE_REQ" | curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d @- \
    | python3 -I -c 'import json,sys
try: v = json.load(sys.stdin).get("value")
except Exception: v = None
sys.exit(3) if not isinstance(v, str) else print(v)') || die "the driver did not return the summary's prose"
  LEN=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["chars"])' "$PROSE")
  [ "$LEN" -ge 120 ] && break
  sleep 1
done
prose() { python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])' "$PROSE" "$1"; }
[ "$LEN" -ge 120 ] || die "the summary panel is on screen but its blocks hold only $LEN characters of prose after 30 s ($(prose titles) titles, $(prose repeats) repeated blocks, $(prose blocks) blocks): '$(prose prose | cut -c1-300)'"
say "a summary was written, $LEN characters of prose; $(prose titles) title blocks and $(prose repeats) repeated blocks left out of $(prose blocks): $(prose prose | cut -c1-200)"

# --- what the summary's action items carry (#171) -------------------------------------------------
#
# `standard_meeting` ordered a due date on every action item, and the model wrote "(due: None)" for
# what jfk.wav never dated. The recording states no date, so any due slot on an action item is a
# value the meeting did not give. Read from the **stored markdown**, not the page's text, which loses
# the list markers, and counted by `summary::due_slots` through its example, the function Stage 1
# tests. One sampled draw: a red here is re-measured with the instrument, never rerun to green.
# `unscored` cannot observe this (its transcript is Cyrillic and its summary may be Russian), and
# `empty` writes no summary. Named defaults: the template is `standard_meeting`, and the same sample
# plays on both channels, so the side instruction is appended.
DUE_NOTE=""
if [ "$MODE" = scores ]; then
  MD=""
  for _ in $(seq 1 30); do
    MD=$(python3 -I -c '
import json, sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    r = c.execute("select result from summary_processes where result is not null order by rowid desc limit 1").fetchone()
    print((json.loads(r[0]).get("markdown") or "") if r else "")
except Exception:
    print("")' "$APPDATA/meeting_minutes.sqlite")
    [ -n "$MD" ] && break
    sleep 1
  done
  [ -n "$MD" ] || die "the stored summary has no markdown in summary_processes.result"
  READING=$(printf '%s' "$MD" | (cd "$(dirname "$0")/../frontend/src-tauri" && cargo run -q --example due_slots -- no-date)) \
    || die "the counter's example did not run over the stored summary"
  say "the stored summary's action items, counted with no stated date: $READING"
  # The markdown itself, so the record holds what was counted (the first conclusive draw did not).
  printf '%s\n' "--- the stored summary's markdown ---" "$MD" "---"
  field() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])' "$READING" "$1"; }
  ITEMS=$(field items); HITS=$(field hits); CONCLUSIVE=$(field conclusive); HEADERLESS=$(field headerless_rows)
  # The page's top-level list blocks between the Action Items title and the next title, as a
  # cross-check that the counter and the person see the same items: `lib/action-item-blocks.js`, which
  # `summary-prose-oracle.test.mjs` runs over BlockNote's own HTML.
  DOM_JSON=$(python3 -I -c 'import json,sys; print(json.dumps({"script": open(sys.argv[1]).read(), "args": []}))' scripts/lib/action-item-blocks.js \
    | curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d @- \
    | python3 -I -c 'import json,sys
try: v = json.load(sys.stdin).get("value")
except Exception: v = None
sys.exit(3) if not isinstance(v, str) else print(v)') || die "the driver did not return the page's action items"
  DOM_ITEMS=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["items"])' "$DOM_JSON")
  say "the page shows $DOM_ITEMS top-level list blocks under Action Items ($(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["nested"])' "$DOM_JSON") nested)"
  [ "$DOM_ITEMS" = "$ITEMS" ] || die "the counter read $ITEMS action items in the stored markdown and the page shows $DOM_ITEMS"
  if [ "$CONCLUSIVE" != True ]; then
    # Zero items is either none written or none under a heading the counter reads (`**Action Items:**`
    # is not one); the markdown above says which.
    if [ "$ITEMS" = 0 ]; then WHY="the counter found no action items: none were written, or they sit under a heading it does not read"; else WHY="$HEADERLESS table rows have no header, so no cell is known to be the due date"; fi
    DUE_NOTE="; due slots INCONCLUSIVE ($WHY), not a result"
    say "due slots: INCONCLUSIVE -- $WHY, so this draw says nothing about them"
  else
    [ "$HITS" = 0 ] || die "$HITS of $ITEMS action items carry a due slot or a date the recording never stated (the markdown is printed above)"
    DUE_NOTE="; no action item carries a due slot"
    say "due slots: none of $ITEMS action items carries one"
  fi
fi

PASSED=1
say "PASS ($MODE) - $MODEL_ID picked through first run, its transcript is on screen with no invented score, and a summary came out of it$DUE_NOTE"

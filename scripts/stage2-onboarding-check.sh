#!/usr/bin/env bash
# Does first run download the transcription model the person actually chose? (#130)
#
# **Why this exists.** Both other UI-driving passes seed `onboarding-status.json` into the profile --
# `stage2-record-check.sh:85` and `stage2-ui-check.sh:89-90` -- so neither can observe the first-run
# screens at all. The reason is cost and it is honest: an unseeded profile pulls about 4.3 GB. The
# consequence was that a defect living on those screens shipped in #111 with a green gate.
#
# **Why a non-default model.** `DEFAULT_TRANSCRIBE_MODEL` is `parakeet-tdt-0.6b-v3-q8`, and the
# download path used to name that constant directly. A pass that accepts the default asserts the one
# value for which the broken path was accidentally correct -- it is green on the defect. This picks
# `moonshine-tiny-q8`, which is not the default and is 34 MB, so the honest assertion is also the
# cheap one.
#
# **What is seeded and what is not.** The summary model is seeded from the cache, because it is not
# what this pass is about and it is 3.6 GB. The onboarding marker is NOT seeded -- that is the entire
# point -- and neither is any transcription model, except in mode `keeps` where one is placed on
# purpose.
#
# **The oracle is the filesystem, not a return value.** `ls` before and after. A command that answers
# `ok` has told us nothing about what reached the disk; that rule is in .claude/rules/testing.md and
# this pass is one of the places it was not being applied.
#
#   scripts/stage2-onboarding-check.sh <AppImage> [chooses|keeps|remote|present|narrow|catalogue] [profile-dir]
#
#     chooses  the chosen model's file must appear                      (default)
#     keeps    a different model is already on disk; the chosen one must still arrive,
#              and the one already there must not be fetched again
#     remote   a cloud summariser is chosen; `models/summary` must stay EMPTY while the
#              transcription model still arrives
#     present  the chosen model is already on disk; the screen must say so in words and count no
#              bytes, and Continue must be available at once
#     narrow   the whole walk at 720x520 -- the smallest window tauri.conf.json permits -- with the
#              catalogue opened and a row clicked. Three of the four defects #157 measured as caught
#              by nothing were missed because every other mode walks one path at one size.
#     catalogue `whisper-tiny-q8`, neither recommended nor the default, chosen through the catalogue
#              alone, with a cloud summariser; first run is finished and the stored choice read (#166)
#     resumes  moonshine-tiny-q8 and Claude chosen, the application ended at step 4 and launched
#              again on the same profile; the second launch must check, finish and store both
#              choices (#172)
#     resumes-gone  a status saved at step 3 naming a model this build no longer has, seeded, so
#              the onboarding screens before it are not walked; the resume must fall back to the
#              default and fetch it, not stop on "Unknown model" (#172's gate)
#     agents   the agent option opened against the CLIs this machine really has, on a profile with
#              no login in it: each row must say what the CLI itself says under that HOME, and the
#              log must show the backend was asked (#212)
#     agents-absent  the same with the application's PATH cut to the system directories, so the
#              shell finds neither CLI: both rows must say not found, and the log must say why
#
# **What each mode leaves on its default, named rather than implied** (`.claude/rules/testing.md`,
# "What a pass must vary"). A pass that says "covers onboarding" hides its holes; this one says which:
#
#     mode      varies                        leaves on the default
#     chooses   the transcription model        summariser (builtin-ai), window size, permissions
#     keeps     the transcription model,       summariser (builtin-ai), window size, permissions
#               plus one already on disk
#     remote    the summariser (claude)        transcription model (still moonshine-tiny), window
#                                              size, permissions
#     catalogue the transcription model, chosen window size, permissions
#               in the catalogue; the
#               summariser (claude)
#     agents    the summariser (an agent CLI), transcription model, window size; and the
#               the PATH (inherited or cut)   login: no profile here is logged in to either CLI,
#                                              so the logged-in row is not entered (#212)
#
# None of the three varies the window, so nothing here would see a control that only fails at
# `minHeight: 520` -- `storybook-summariser-reveal.test.mjs` is what covers that, in a browser.
# None reaches the macOS permissions step, which ADR 0005 puts out of reach of this machine entirely.
#
# **`remote` exists because the other two never varied the summariser.** Both leave it on its
# default, which is `builtin-ai`, so for eight days this pass walked the flow with the one provider
# whose behaviour was correct. A person who chose Claude got 2709.8 MB of Gemma they will never use,
# and every check here was green throughout (#155). An absence is the oracle, so it carries a
# positive sentinel: the transcription model must arrive in the same run, or "nothing downloaded"
# is indistinguishable from "nothing ran".
set -euo pipefail

APP="${1:?usage: stage2-onboarding-check.sh <AppImage> [chooses|keeps|remote|present|narrow|catalogue|resumes|resumes-gone|agents|agents-absent] [profile-dir]}"
MODE="${2:-chooses}"
PROFILE="${3:-}"
PORT="${BC_WD_PORT:-14446}"
NATIVE_PORT="${BC_WD_NATIVE_PORT:-14447}"
CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"

# Not the default. See the header.
CHOSEN_ID="moonshine-tiny-q8"
CHOSEN_FILE="moonshine-tiny-Q8_0.gguf"
# `size_mb: 34` in src-tauri/src/config.rs. Needed because a file that merely EXISTS is not a file
# that arrived: the first run of this script reported PASS on a 4.5 MB partial, which is the same
# "a call that returned success is not evidence" shape this pass was written to catch, one level in.
CHOSEN_MB=34
PRESENT_FILE="parakeet-tdt-0.6b-v3-Q8_0.gguf"
# `catalogue` chooses a model the recommended four cannot offer, so only the catalogue can choose it
# (#166). `size_mb: 44` in config.rs.
if [ "$MODE" = catalogue ]; then
  CHOSEN_ID="whisper-tiny-q8"; CHOSEN_FILE="whisper-tiny-Q8_0.gguf"; CHOSEN_MB=44
fi

say() { printf 'stage2-onboarding-check: %s\n' "$*"; }
die() { printf 'stage2-onboarding-check: %s\n' "$*" >&2; exit 1; }

case "$MODE" in chooses|keeps|remote|present|narrow|catalogue|resumes|resumes-gone|agents|agents-absent) ;; *) die "mode must be chooses, keeps, remote, present, narrow, catalogue, resumes, resumes-gone, agents or agents-absent, not '$MODE'" ;; esac
command -v tauri-driver >/dev/null || die "tauri-driver is not installed: cargo install tauri-driver --locked"
[ -x /usr/bin/WebKitWebDriver ] || die "WebKitWebDriver is not installed: apt install webkit2gtk-driver"
[ -x "$APP" ] || die "not executable: $APP"

OWN_PROFILE=""
if [ -z "$PROFILE" ]; then
  PROFILE="$(mktemp -d /tmp/backchannel-onboarding.XXXXXX)"; OWN_PROFILE=1
fi
APPDATA="$PROFILE/home/.local/share/com.conversationaly.ai"
mkdir -p "$APPDATA/models"

# The summary model only. Deliberately no onboarding marker: seeding it is what blinds the other two
# passes to these very screens.
# `remote` seeds no summary model at all: a cloud provider needs none, so an empty `models/summary`
# is an unambiguous answer. Seeding it made the first version of this oracle report 469 372 646 bytes
# "fetched" that were the seed itself, mtime and all -- a non-empty result that was not a finding,
# which is the same class of mistake as an empty one that is not a pass.
if [ "$MODE" != remote ] && [ "$MODE" != catalogue ] && [ "$MODE" != resumes ] && [ "$MODE" != resumes-gone ] && [ "$MODE" != agents ] && [ "$MODE" != agents-absent ] && [ -d "$CACHE/models/summary" ]; then
  cp -a --reflink=auto "$CACHE/models/summary" "$APPDATA/models/summary" 2>/dev/null \
    || cp -a "$CACHE/models/summary" "$APPDATA/models/summary"
  # Not "no downloads this run": the cached summary model is **partial** -- 448 MB of a 3651 MiB
  # model -- so first run fetches the rest every time. Measured 2026-09-10, after this pass had
  # claimed otherwise in its own output for as long as the cache had been incomplete.
  say "seeded a partial summary model ($(du -sh "$APPDATA/models/summary" | cut -f1) of 3651 MiB); the rest is fetched"
else
  say "no summary model in $CACHE — first run will fetch one, and this pass will take much longer"
fi

if [ "$MODE" = keeps ]; then
  [ -f "$CACHE/models/$PRESENT_FILE" ] || die "mode 'keeps' needs $PRESENT_FILE in $CACHE/models"
  cp -a "$CACHE/models/$PRESENT_FILE" "$APPDATA/models/$PRESENT_FILE"
  PRESENT_BEFORE=$(stat -c '%Y %s' "$APPDATA/models/$PRESENT_FILE")
  say "placed $PRESENT_FILE on disk first: $PRESENT_BEFORE"
fi

if [ "$MODE" = present ]; then
  # The state the product owner photographed: a file already there, drawn as a bar over
  # `0.0 MB / 705.3 MB`. Seeding the chosen model is the only way to enter it deliberately.
  [ -f "$CACHE/models/$CHOSEN_FILE" ] || die "mode 'present' needs $CHOSEN_FILE in $CACHE/models"
  cp -a "$CACHE/models/$CHOSEN_FILE" "$APPDATA/models/$CHOSEN_FILE"
  say "placed the model the person will choose on disk first: $CHOSEN_FILE"
else
  [ -f "$APPDATA/models/$CHOSEN_FILE" ] && die "the chosen model is already on disk; this pass would prove nothing"
fi
# `resumes` launches the application twice. It is single-instance: it claims
# com.conversationaly.ai.SingleInstance on the session bus, which HOME/XDG isolation does not scope, so
# a live copy anywhere would capture both launches. Identified by what each process is, as
# `stage2-ui-check.sh` does, never by `pgrep -f`.
app_pid() {
  local pid exe
  for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    [ "$pid" = "$$" ] && continue
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
    case "$exe" in */conversationaly) echo "$pid"; return 0 ;; esac
  done
  return 1
}
HARNESS_UP=""
# The state an older version leaves: first run quit at the download screen, with a model this build no
# longer lists (a catalogue row upstream dropped). Seeded, which is what makes the state reachable;
# so this mode cannot observe the screens before step 3.
GONE_ID="canary-1b-q8-removed"
if [ "$MODE" = resumes-gone ]; then
  printf '{"status":{"version":"1.0","completed":false,"current_step":3,"model_status":{"parakeet":"not_downloaded","summary":"not_downloaded","selected_summary_model":"claude-sonnet-4-5-20250929","selected_transcribe_model":"%s","summary_provider":"claude"},"last_updated":"2026-10-25T00:00:00Z"}}\n' \
    "$GONE_ID" > "$APPDATA/onboarding-status.json"
  say "seeded a status at step 3 naming $GONE_ID, which the catalogue does not list"
fi
if [ "$MODE" = resumes ]; then
  RUNNING=$(app_pid) && die "another copy of the application is running (pid $RUNNING); a resume run cannot share the single-instance lock with it"
  # The second launch presses Check by speaking. The harness is the default input, so the check hears
  # its sample and never the room; before the first launch, because the device list is read at start.
  SAMPLE="${BC_SAMPLE_A:-$(ls ~/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav 2>/dev/null | head -1)}"
  [ -n "$SAMPLE" ] && [ -f "$SAMPLE" ] || die "no jfk.wav sample for the audio check"
  "$(dirname "${BASH_SOURCE[0]}")/audio-harness.sh" down >/dev/null 2>&1 || true
  "$(dirname "${BASH_SOURCE[0]}")/audio-harness.sh" up --sample "$SAMPLE" || die "the audio harness could not come up"
  HARNESS_UP=1
fi
DRIVER_LOG="$PROFILE/tauri-driver.log"
cleanup() {
  [ -n "${SESSION:-}" ] && curl -s -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1 || true
  # The group, not the name: `pkill -x WebKitWebDriver` kills drivers this run never started,
  # which defeats the BC_WD_PORT knobs whose only purpose is a second concurrent run. Same
  # class as the fix in 6db27e9 for the other harness. setsid is already used above, so the
  # group id is the driver's own pid.
  [ -n "${DRIVER_PID:-}" ] && kill -TERM -"$DRIVER_PID" 2>/dev/null || true
  sleep 1
  [ -n "${DRIVER_PID:-}" ] && kill -KILL -"$DRIVER_PID" 2>/dev/null || true
  [ -n "${HARNESS_UP:-}" ] && "$(dirname "${BASH_SOURCE[0]}")/audio-harness.sh" down >/dev/null 2>&1 || true
  # Kept on failure: the application's own logs/ live in there, and the driver log alone does
  # not say what the app was doing. stage2-record-check.sh keeps its profile for the same reason.
  if [ -n "${OWN_PROFILE:-}" ] && [ "${PASSED:-}" = "1" ]; then
    rm -rf "$PROFILE"
  elif [ -n "${OWN_PROFILE:-}" ]; then
    printf 'stage2-onboarding-check: profile kept for inspection: %s\n' "$PROFILE" >&2
  fi
}
trap cleanup EXIT

# The PATH the application inherits, which is half of what it searches for an agent CLI (#212).
# `agents-absent` cuts it to the system directories; the driver is then named by its full path.
APP_PATH="$PATH"
[ "$MODE" = agents-absent ] && APP_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
TAURI_DRIVER=$(command -v tauri-driver)
HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" PATH="$APP_PATH" \
  setsid "$TAURI_DRIVER" --port "$PORT" --native-port "$NATIVE_PORT" > "$DRIVER_LOG" 2>&1 &
DRIVER_PID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/status" && break; sleep 0.25; done

# One in four cold runs died with `hyper::Error(User(Service)) ... Connection reset by peer`
# between tauri-driver and WebKitWebDriver; tauri-driver sets retry_canceled_requests(false),
# so the retry has to live here. Sample of four, said as such.
SESSION=""
for attempt in 1 2 3 4 5; do
  RESP=$(curl -s -m 30 -X POST "http://127.0.0.1:$PORT/session" -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$APP\",\"args\":[]}}}}" || true)
  SESSION=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["value"]["sessionId"])
except Exception: print("")' 2>/dev/null)
  [ -n "$SESSION" ] && break
  # A driver that answers with `session not created` has diagnosed the failure; retrying it
  # four more times costs two and a half minutes and adds nothing. Only the silent shape --
  # the application starts and never completes the handshake -- is worth a retry.
  if printf '%s' "$RESP" | grep -q 'session not created'; then
    printf '%s\n' "$RESP" | sed 's/^/    /' >&2
    die "the driver refused to create a session; its answer is above"
  fi
  say "session attempt $attempt produced no answer; retrying"
  sleep 2
done
[ -n "$SESSION" ] || {
  say "the last response body was: ${RESP:-<empty>}"
  sed 's/^/    /' "$DRIVER_LOG" >&2
  die "no WebDriver session after 5 attempts, and the driver never answered"
}
say "session up against $(basename "$APP")"

BASE="http://127.0.0.1:$PORT/session/$SESSION"
js() { curl -s -m 20 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' \
  -d "{\"script\":$1,\"args\":[]}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))'; }
find_el() { curl -s -m 20 -X POST "$BASE/element" -H 'Content-Type: application/json' -d "$1" \
  | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value")
print(list(v.values())[0] if isinstance(v,dict) and v and "error" not in v else "")' 2>/dev/null; }
# `click` comes from the shared helper: it dies naming a refusal the driver reported, after a bounded
# wait for the transient one Radix produces on every Select close. Four passes each owned a
# `curl ... >/dev/null` until #160, and so four passes could not tell a click that landed from one
# that did not.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/webdriver.sh"
by_text() { find_el "{\"using\":\"xpath\",\"value\":\"//button[normalize-space()=\\\"$1\\\"]\"}"; }

# Wait for a condition in the page, or fail naming it.
await() {
  local expr="$1" what="$2" secs="${3:-60}" i
  for i in $(seq 1 "$secs"); do
    [ "$(js "\"return Boolean($expr)\"")" = "True" ] && return 0
    sleep 1
  done
  die "waited ${secs}s for $what and it never happened"
}

# --- resumes-gone: a saved model this build no longer has resumes on the default (#172's gate) ------
if [ "$MODE" = resumes-gone ]; then
  DEFAULT_ID="parakeet-tdt-0.6b-v3-q8"; DEFAULT_FILE="parakeet-tdt-0.6b-v3-Q8_0.gguf"
  # A download row is a `section` labelled with its model. So is the toaster's region, which Sonner
  # labels "Notifications alt+T" and renders from the start: counting it made the first version of this
  # wait true on arrival, and its row list name a model nobody chose. Rows are the other sections.
  ROWS_JS='[...document.querySelectorAll(\"section[aria-label]\")].map(s=>s.getAttribute(\"aria-label\")).filter(l=>!l.startsWith(\"Notifications\"))'
  # False on arrival: the download screen is step 3, and the application renders no row until the
  # resume has read the status.
  await "$ROWS_JS.length > 0" "the resume to reach the download screen" 60
  sleep 3
  FAILS=()
  ROWS=$(js "\"return JSON.stringify($ROWS_JS)\"")
  say "the download screen's rows: $ROWS"
  [ "$ROWS" = "[\"$DEFAULT_ID\"]" ] || FAILS+=("the rows are $ROWS, not the default's alone")
  [ "$(js '"return document.body.innerText.includes(\"Unknown model\")"')" = "True" ] && FAILS+=("the screen says Unknown model")
  LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1)
  [ -n "$LOG" ] || die "the application wrote no log under $APPDATA/logs"
  # The positive sentinel: the download the resume asked for. Written before the request (#166).
  FETCHED=""
  for _ in $(seq 1 20); do
    grep -qE "Downloading model file .+/$DEFAULT_FILE" "$LOG" && { FETCHED=1; break; }
    sleep 0.5
  done
  [ -n "$FETCHED" ] || FAILS+=("no download of $DEFAULT_FILE was asked for")
  # A guard with no control: an unknown id fails at the catalogue lookup (`engine.rs:351-352`) before
  # the download line is written, and that line names a URL and a file, never an id. No build can
  # write this, so it can never go red; the row and the download above are the conditions.
  grep -qE "Downloading model file .+$GONE_ID" "$LOG" && FAILS+=("a download of $GONE_ID was asked for")
  # The auto-save after the resume: false until it runs, since the seed named the dead model.
  SAVED=""
  for _ in $(seq 1 20); do
    SAVED=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"]["model_status"].get("selected_transcribe_model"))' "$APPDATA/onboarding-status.json" 2>/dev/null || true)
    [ "$SAVED" != "$GONE_ID" ] && break
    sleep 0.5
  done
  say "the status now names: $SAVED"
  [ "$SAVED" = "$DEFAULT_ID" ] || FAILS+=("the status still names '$SAVED' after the resume saved")
  [ ${#FAILS[@]} -eq 0 ] || die "a resume from a model this build no longer has: $(printf '%s | ' "${FAILS[@]}")"
  PASSED=1
  say "PASS (resumes-gone): the resume fell back to $DEFAULT_ID, fetched it, and saved it in place of $GONE_ID"
  exit 0
fi

# --- first run is on screen, because nothing seeded it away ---------------------------------------
await "document.body.innerText.includes('Choose a transcription model')" "the first-run screen" 90
say "first run is on screen"

# --- narrow: the smallest window the application permits, the catalogue, and a row -----------------
if [ "$MODE" = narrow ]; then
  RECT=$(curl -s -m 20 -X POST "$BASE/window/rect" -H 'Content-Type: application/json' \
    -d '{"width":720,"height":520,"x":40,"y":40}')
  say "set-window-rect answered: $(printf '%s' "$RECT" | head -c 120)"
  await "window.innerWidth <= 760" "the window to become narrow" 15
  say "viewport: $(js '"return window.innerWidth + \"x\" + window.innerHeight"')"

  # 1. The catalogue's search field must not be covered by the list below it. The product owner
  #    photographed the table sitting on top of it; the removal that caused it had been verified by
  #    checking an element was gone, which says nothing about what moved into its place.
  CAT=$(by_text "Browse every model")
  [ -n "$CAT" ] || die "no 'Browse every model' button on the first-run screen"
  click "$CAT" "the catalogue button"
  await "document.querySelector('input[type=search], input[placeholder*=Search i]') !== null" "the catalogue's search field" 20
  # The field is scrolled into view first: at 720x520 the catalogue's list is taller than the window,
  # and `elementFromPoint` outside the viewport returns null, which is not "covered" -- reporting it
  # as such would be the check being wrong. The question is what sits at the field's own centre once
  # the field is on screen.
  OVER=$(js '"return (() => { const f=document.querySelector(\"input[type=search], input[placeholder*=Search i]\"); if(!f) return \"NO FIELD\"; f.scrollIntoView({block:\"center\"}); const r=f.getBoundingClientRect(); if (r.top < 0 || r.bottom > window.innerHeight) return \"OFF SCREEN at \" + Math.round(r.top) + \"..\" + Math.round(r.bottom) + \" in \" + window.innerHeight; const top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return (top===f||f.contains(top)||f===top) ? \"CLEAR\" : \"COVERED by \" + (top ? top.tagName + \".\" + (top.className||\"\").toString().slice(0,40) : \"null\"); })()"')
  say "the search field at its own centre: $OVER"
  [ "$OVER" = CLEAR ] || die "the catalogue's search field is not the thing at its own centre: $OVER"

  # 2. A row in the catalogue must not start a download. First run's rows are its own since #166, and
  #    Settings' card, which keeps its Download, is a different component.
  # Asserted as an absence of the control, not as a race with a download. The first version clicked
  # "some button in a row" and counted `models/` four seconds later; with the defect restored it still
  # passed, because the click landed elsewhere and four seconds is not a download. A button that is
  # not there cannot be pressed, which is the instruction — and ADR 0023's shape for it.
  # `Delete` too: the control reads `Delete`, and forbidding only `Remove` is one of the reasons this
  # pass stayed green while first run's rows had no control at all (#166).
  FETCHERS=$(js '"return [...document.querySelectorAll(\"button\")].map(b=>(b.textContent||\"\").trim()).filter(t=>/^(Download|Download again|Remove|Delete)$/.test(t)).length"')
  say "buttons in the catalogue that would fetch or delete: $FETCHERS"
  [ "$FETCHERS" = "0" ] \
    || die "the catalogue offers $FETCHERS download/remove buttons during first run; a row selects, it does not fetch"

  # And nothing reached the disk while we were in there, which is the same claim from the other side.
  BEFORE=$(ls -1 "$APPDATA/models" 2>/dev/null | wc -l)
  # Inside the catalogue's own radiogroup. This used to match `//label[...moonshine...]`, which is a
  # recommended option above the catalogue, so the click never reached a catalogue row (#166).
  ROW=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radiogroup'][@aria-label='Models']//*[@role='radio'][.//text()[.='whisper-tiny-q8']]\"}")
  [ -n "$ROW" ] || die "no whisper-tiny-q8 row inside the catalogue's radiogroup"
  CHECKED=$(curl -s -m 20 "$BASE/element/$ROW/attribute/aria-checked" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))')
  [ "$CHECKED" = "false" ] || die "the whisper-tiny-q8 row reads aria-checked=$CHECKED before it was clicked"
  click "$ROW" "a catalogue row"
  # The positive sentinel: the click chose the row, so the absence below is about a click that landed.
  await "(function(){var r=[...document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]')].find(function(e){return e.textContent.indexOf('whisper-tiny-q8')>=0;});return !!r&&r.getAttribute('aria-checked')==='true';})()" \
        "the clicked row to read aria-checked=true" 10
  sleep 4
  AFTER=$(ls -1 "$APPDATA/models" 2>/dev/null | wc -l)
  [ "$BEFORE" = "$AFTER" ] \
    || die "clicking a catalogue row put a file in models/ — a row must select, not fetch (was $BEFORE, now $AFTER)"
  say "and a click on a row fetched nothing: models/ still holds $AFTER entries"

  # Back to the recommended four, and on through the flow at this size. Choosing a row does not close
  # the catalogue, so its toggle must be there. The wait is for the catalogue's own rows to be gone:
  # the four radios render above the catalogue too, so a wait on them was true while it was still open
  # (#166's gate, round 2). Unquoted attribute selectors on purpose -- a `"` here has to survive the
  # shell, this script's JSON body and the driver, and the first version's did not.
  BACK=$(by_text "Hide the catalogue")
  [ -n "$BACK" ] || die "no 'Hide the catalogue' button while the catalogue is open"
  click "$BACK" "Hide the catalogue"
  await "document.querySelector('[role=radiogroup][aria-label=Models]') === null && document.querySelectorAll('[name=transcription-model]').length > 0" \
        "the catalogue to close, with the recommended options on screen" 20
  say "the catalogue closed and the recommended options are back"
fi

# --- catalogue: choose a model only the catalogue offers (#166) -----------------------------------
#
# Every first-run row used to render no control on a clean profile: the Settings card offered `Use`
# only for a file on disk, and first run had switched its `Download` off. So the catalogue could not
# choose any of the 82 models outside the recommended four.
if [ "$MODE" = catalogue ]; then
  # Entries and sizes, not `ls -la`: that also lists `..`, the app-data directory, whose minute-level
  # time can change for reasons that are not a download (#166's gate).
  MODELS_BEFORE=$(find "$APPDATA/models" -mindepth 1 -printf '%P %s\n' | sort)
  CAT=$(by_text "Browse every model")
  [ -n "$CAT" ] || die "no 'Browse every model' button on the first-run screen"
  click "$CAT" "the catalogue button"
  # False before the click: the catalogue is not on screen until it is asked for.
  await "document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]').length > 1" "the catalogue's rows" 20
  FIELD=$(find_el '{"using":"css selector","value":"input[type=search]"}')
  [ -n "$FIELD" ] || die "the catalogue has no search field"
  type_into "$FIELD" "$CHOSEN_ID" "the catalogue's search field"
  # False before typing: the unfiltered list holds rows that do not carry the id.
  await "(function(){var r=[...document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]')];return r.length>0&&r.every(function(e){return e.textContent.indexOf('$CHOSEN_ID')>=0;});})()" \
        "the search to narrow the catalogue to $CHOSEN_ID" 20
  ROW_XPATH="//*[@role='radiogroup'][@aria-label='Models']//*[@role='radio'][.//text()[.='$CHOSEN_ID']]"
  ROW=$(find_el "{\"using\":\"xpath\",\"value\":\"$ROW_XPATH\"}")
  [ -n "$ROW" ] || die "no row for $CHOSEN_ID inside the catalogue's radiogroup"
  CHECKED=$(curl -s -m 20 "$BASE/element/$ROW/attribute/aria-checked" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value"))')
  [ "$CHECKED" = "false" ] || die "the $CHOSEN_ID row reads aria-checked=$CHECKED before it was chosen"
  click "$ROW" "the catalogue row for $CHOSEN_ID"
  await "(function(){var r=[...document.querySelectorAll('[role=radiogroup][aria-label=Models] [role=radio]')].find(function(e){return e.textContent.indexOf('$CHOSEN_ID')>=0;});return !!r&&r.getAttribute('aria-checked')==='true';})()" \
        "the $CHOSEN_ID row to read aria-checked=true" 10
  # None of the four above is checked: the choice is the catalogue's, not a recommended option's.
  [ "$(js '"return document.querySelector(\"input[name=transcription-model]:checked\") === null"')" = "True" ] \
    || die "a recommended option is still checked after choosing $CHOSEN_ID in the catalogue"
  say "chose $CHOSEN_ID in the catalogue: aria-checked false, then true"
  CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue button on the model screen"
  click "$CONT" "Continue on the transcription screen"
fi

# --- choose a model that is not the default -------------------------------------------------------
#
# The radio itself is `sr-only`, so the label carrying the id is the clickable thing.
if [ "$MODE" != catalogue ]; then
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//label[.//text()[contains(.,\\\"$CHOSEN_ID\\\")]]\"}")
[ -n "$OPT" ] || die "no option labelled $CHOSEN_ID on the first-run screen"
click "$OPT" "the transcription model the pass chose"
# The checked option must be **the one the pass clicked**. `OnboardingContext.tsx:120` initialises
# `selectedTranscribeModel` to `parakeet-tdt-0.6b-v3-q8`, so a radio is already checked on arrival and
# "something is checked" was true in the state being left (#160). The radio carries no `value`, so the
# label it sits in is what names it.
await "(function(){var r=document.querySelector('input[name=transcription-model]:checked');var l=r&&r.closest('label');return !!l&&l.textContent.indexOf('$CHOSEN_ID')>=0;})()" \
      "$CHOSEN_ID to become the checked option" 10

CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue button on the model screen"
click "$CONT" "Continue on the transcription screen"
fi

# --- the summariser screen ------------------------------------------------------------------------
#
# `chooses` and `keeps` leave it on its default, which is `builtin-ai`, and its model is seeded, so
# nothing is fetched for it. `remote` picks a cloud provider and types a key, which is the state
# neither of the others has ever entered.
await "document.body.innerText.includes('Where should the summary be written')" "the summariser screen" 30

# --- agents: the agent option against what is really on this machine (#212) ----------------------
#
# The oracle is the CLIs themselves, asked **after** the screen was read, under the same HOME and the
# same PATH the application had: the login shell's `command -v`, then the PATH, then where the CLIs
# install themselves, and each found one's own login check. Asked afterwards so that nothing the oracle
# writes into the profile can be what the application read.
if [ "$MODE" = agents ] || [ "$MODE" = agents-absent ]; then
  AG=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radio'][starts-with(normalize-space(.),'An agent on this machine')]\"}")
  [ -n "$AG" ] || die "no 'An agent on this machine' option on the summariser screen"
  click "$AG" "the agent option"
  # False on arrival: the rows are not in the page until the option is open, and then read "Looking"
  # until the backend answers.
  await "(function(){var a=document.querySelector('[data-agent=claude-code]'),b=document.querySelector('[data-agent=codex]');return !!a&&!!b&&a.textContent.indexOf('Looking')<0&&b.textContent.indexOf('Looking')<0;})()" \
        "both CLI rows to report what was found" 40
  FAILS=()
  LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1)
  [ -n "$LOG" ] || die "the application wrote no log under $APPDATA/logs"
  USABLE=0
  for pair in claude-code:claude codex:codex; do
    ID=${pair%%:*}; BIN=${pair##*:}
    ROW=$(js "\"var r=document.querySelector('[data-agent=$ID]');return JSON.stringify({text:r.textContent,disabled:r.getAttribute('aria-disabled')})\"")
    say "the $ID row: $ROW"
    # The product was asked: the line `agent_cli::status` writes for this CLI.
    LINE=$(grep -m1 "Agent CLI status: $ID " "$LOG" || true)
    [ -n "$LINE" ] || FAILS+=("the log has no status line for $ID: the screen's state is not the backend's")
    say "the log: ${LINE##*Agent CLI status: }"
    # The oracle, the way discovery.rs looks, asked of the shell rather than of the application.
    FOUND=$(env -i HOME="$PROFILE/home" PATH="$APP_PATH" SHELL="${SHELL:-/bin/bash}" "${SHELL:-/bin/bash}" -ilc "command -v $BIN" </dev/null 2>/dev/null | tail -1 || true)
    [ -n "$FOUND" ] && [ -x "$FOUND" ] || FOUND=$(PATH="$APP_PATH" command -v "$BIN" || true)
    if [ -z "$FOUND" ]; then
      for d in "$PROFILE/home/.local/bin" "$PROFILE/home/.claude/local" "$PROFILE/home/.npm-global/bin" /usr/local/bin /opt/homebrew/bin; do
        [ -x "$d/$BIN" ] && { FOUND="$d/$BIN"; break; }
      done
    fi
    if [ -z "$FOUND" ]; then EXPECT="not found"
    else
      case "$ID" in
        # Captured first: a logged-out `claude auth status` exits non-zero, and under `pipefail` a
        # pipeline's `|| echo unknown` then appended a second answer to the first (measured: the
        # oracle read "out\nunknown" and failed a run in which the application was right).
        claude-code) OUT=$(HOME="$PROFILE/home" PATH="$APP_PATH" timeout 30 "$FOUND" auth status </dev/null 2>/dev/null || true)
               IN=$(printf '%s' "$OUT" | python3 -c 'import json,sys
try: print("in" if json.load(sys.stdin).get("loggedIn") else "out")
except Exception: print("unknown")') ;;
        codex) OUT=$(HOME="$PROFILE/home" PATH="$APP_PATH" timeout 30 "$FOUND" login status </dev/null 2>&1 || true)
               case "$OUT" in *"Not logged in"*) IN=out ;; *"Logged in"*) IN=in ;; *) IN=unknown ;; esac ;;
      esac
      EXPECT="found, logged $IN"
    fi
    say "the oracle for $ID: $EXPECT${FOUND:+ at $FOUND}"
    case "$EXPECT" in
      "not found")
        printf '%s' "$ROW" | grep -q "Not found in your shell's PATH" || FAILS+=("$ID: the CLI is not found, and the row does not say so")
        printf '%s' "$ROW" | grep -q '"disabled": *"true"' || FAILS+=("$ID: a CLI that is not found can be chosen")
        printf '%s' "$LINE" | grep -q "found=none" || FAILS+=("$ID: the log says it was found: $LINE") ;;
      "found, logged out")
        printf '%s' "$ROW" | grep -q "Found, but not logged in. Run $BIN once" || FAILS+=("$ID: the CLI is logged out, and the row does not say so")
        printf '%s' "$ROW" | grep -q '"disabled": *"true"' || FAILS+=("$ID: a logged-out CLI can be chosen")
        printf '%s' "$LINE" | grep -qF "found=$FOUND " || FAILS+=("$ID: the log names another path than the shell: $LINE") ;;
      "found, logged in")
        USABLE=$((USABLE + 1))
        printf '%s' "$ROW" | grep -q "Found: " || FAILS+=("$ID: the CLI is usable, and the row does not say where it was found")
        printf '%s' "$ROW" | grep -q '"disabled": *"false"' || FAILS+=("$ID: a usable CLI cannot be chosen") ;;
      *) FAILS+=("$ID: the oracle could not read the CLI's own login check ($EXPECT)") ;;
    esac
  done
  if [ "$USABLE" -eq 0 ]; then
    DIS=$(js '"var b=[...document.querySelectorAll(\"footer button\")].find(b=>b.textContent.trim()===\"Continue\");return b?String(b.disabled):\"none\""')
    [ "$DIS" = "true" ] || FAILS+=("with no usable CLI and the agent option open, Continue reads disabled=$DIS")
  fi
  [ ${#FAILS[@]} -eq 0 ] || die "the agent option: $(printf '%s | ' "${FAILS[@]}")"
  PASSED=1
  say "PASS ($MODE): each CLI row says what the CLI itself says under this profile, and the backend was asked"
  exit 0
fi
if [ "$MODE" = remote ] || [ "$MODE" = catalogue ] || [ "$MODE" = resumes ]; then
  OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radio'][.//text()[contains(.,'claude')]]\"}")
  [ -n "$OPT" ] || die "no Claude option on the summariser screen"
  click "$OPT" "the summariser the pass chose"
  await "document.querySelector('input[type=password]') !== null" "Claude's key field" 10
  KEY=$(find_el '{"using":"css selector","value":"input[type=password]"}')
  [ -n "$KEY" ] || die "no key field after choosing Claude"
  type_into "$KEY" "sk-not-a-real-key-for-a-gate-run" "Claude's key field"
  # A typed value is not a stored one: assert the field holds it before moving on.
  await "(document.querySelector('input[type=password]')||{}).value.length > 10" "the key to be typed" 10
  say "chose Claude and typed a key — nothing local should be fetched for the summariser"
fi
# 3. At 720x520 the key field must be in view when it appears. The product owner chose a remote
#    provider and reported that nothing happened; the field was there, 210px below the fold. Every
#    other mode runs at the default window, where this cannot fail.
if [ "$MODE" = narrow ]; then
  OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radio'][.//text()[contains(.,'claude')]]\"}")
  [ -n "$OPT" ] || die "no Claude option on the summariser screen"
  click "$OPT" "the summariser the pass chose"
  await "document.querySelector('input[type=password]') !== null" "Claude's key field" 15
  FIELD=$(js '"return (() => { const f=document.querySelector(\"input[type=password]\"); const r=f.getBoundingClientRect(); return JSON.stringify({top:Math.round(r.top),bottom:Math.round(r.bottom),vh:window.innerHeight,inside:!!f.closest(\"[role=radio]\")}); })()"')
  say "the key field: $FIELD"
  printf '%s' "$FIELD" | python3 -c '
import json,sys
m=json.load(sys.stdin)
if not m["inside"]: print("BROKEN: the key field is not inside its option")
elif not (m["top"] >= 0 and m["bottom"] <= m["vh"]): print(f"BROKEN: the key field is at {m[chr(34)+chr(116)+chr(111)+chr(112)+chr(34)]}..{m[chr(34)+chr(98)+chr(111)+chr(116)+chr(116)+chr(111)+chr(109)+chr(34)]} in a {m[chr(34)+chr(118)+chr(104)+chr(34)]}px viewport")
else: print("OK")' > /tmp/bc-key.$$ 2>&1
  KEYV=$(cat /tmp/bc-key.$$); rm -f /tmp/bc-key.$$
  [ "$KEYV" = OK ] || die "$KEYV"
  say "and it is inside its option and in view at this size"
  # Back to a local summariser so the rest of the walk matches the other modes.
  LOCAL=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radio'][.//text()[contains(.,'builtin-ai')]]\"}")
  [ -n "$LOCAL" ] || die "no builtin-ai option on the summariser screen to switch back to"
  click "$LOCAL" "the on-this-machine summariser"
fi
# The last moment before the download screen opens. Choosing in the catalogue fetched nothing, so
# models/ is as it was before the catalogue was opened, and every download line for the chosen file
# must come after this mark (#166 condition 3).
if [ "$MODE" = catalogue ]; then
  LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1)
  [ -n "$LOG" ] || die "the application wrote no log under $APPDATA/logs"
  MARK=$(wc -l < "$LOG")
  MODELS_NOW=$(find "$APPDATA/models" -mindepth 1 -printf '%P %s\n' | sort)
  [ "$MODELS_BEFORE" = "$MODELS_NOW" ] || die "models/ changed before the download screen opened:
$(diff <(printf '%s\n' "$MODELS_BEFORE") <(printf '%s\n' "$MODELS_NOW") | sed 's/^/    /')"
  say "models/ is unchanged since before the catalogue was opened, and the log is at line $MARK"
fi
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue button on the summariser screen"
click "$CONT" "Continue on the summariser screen"
say "walked to the download screen"

# --- present: the chosen file was already here, and the screen says so ----------------------------
if [ "$MODE" = present ]; then
  await "document.body.innerText.includes('$CHOSEN_ID')" "the row for the chosen model" 30
  ROW=$(js '"return (() => { const h=[...document.querySelectorAll(\"section[aria-label]\")].find(e=>/'"$CHOSEN_ID"'/.test(e.textContent||\"\")); return h ? h.innerText.replace(/\\s+/g,\" \").trim() : \"NO ROW\"; })()"')
  say "the row for the file already on disk reads: $ROW"
  printf '%s' "$ROW" | grep -q 'Already here from an earlier install' \
    || die "a file already on disk is not stated in words: $ROW"
  printf '%s' "$ROW" | grep -qE '[0-9]+(\.[0-9]+)? *(of|/) *[0-9]+' \
    && die "a file already on disk is counting bytes nothing fetched: $ROW"
  DIS=$(js '"return String(!!document.querySelector(\"footer button\").disabled)"')
  [ "$DIS" = "false" ] || die "the chosen model is already on disk and Continue is still disabled"
  say "PASS (present): the file already here is stated in words, counts no bytes, and Continue is available at once"
  PASSED=1
  exit 0
fi

# --- keeps: Continue waits for the chosen file, not for the one already here (#170) -------------
#
# With another model on disk, the download screen used to enable Continue at once, say "Everything you
# chose is on this device." and call the chosen row "Already here from an earlier install", for a
# file still on its way. "Is SOME model on disk" set the flag. So, from the moment the screen is up,
# the button is read and then the chosen file is measured, as often as the driver answers. A sample is
# *in flight* when the file is absent or under 90% of its final size after the read; no file exists
# until the HTTP response arrives (`engine.rs:430`). Every in-flight sample must read disabled.
# An absence is not a result: zero in-flight samples fails as unobserved, and the count is printed.
if [ "$MODE" = keeps ]; then
  # False on the summariser screen, which has no download rows. The attribute value is unquoted, as the
  # note at the narrow block says: a `"` here reached the driver's JSON body bare, the body did not
  # parse, and this wait could never be true (#170's gate, measured on its first run).
  # `CSS.escape`, because an unquoted value must be an identifier: the default's id, with its `.`,
  # would not parse (#170's gate, round 2).
  await "document.querySelector('section[aria-label=' + CSS.escape('$CHOSEN_ID') + ']') !== null" "the download screen's row for $CHOSEN_ID" 30
  FINAL_BYTES=35466912   # moonshine-tiny-Q8_0.gguf, the cached file's size
  N=0; INFLIGHT=0; INFLIGHT_DISABLED=0; INFLIGHT_ENABLED=0; OTHER=0
  while [ "$N" -lt 3000 ]; do
    D=$(js '"return (() => { const b = document.querySelector(\"footer button\"); return b ? String(b.disabled) : \"no button\"; })()"') \
      || die "the driver did not answer while sampling Continue ($N samples so far)"
    SZ=$(stat -c %s "$APPDATA/models/$CHOSEN_FILE" 2>/dev/null || echo absent)
    N=$((N + 1))
    if [ "$SZ" != absent ] && [ "$SZ" -ge $((FINAL_BYTES * 9 / 10)) ]; then break; fi
    INFLIGHT=$((INFLIGHT + 1))
    case "$D" in
      true) INFLIGHT_DISABLED=$((INFLIGHT_DISABLED + 1)) ;;
      false) INFLIGHT_ENABLED=$((INFLIGHT_ENABLED + 1)); say "in flight at ${SZ} bytes and Continue reads enabled" ;;
      *) OTHER=$((OTHER + 1)) ;;
    esac
  done
  say "while $CHOSEN_ID was in flight: $INFLIGHT samples of $N, $INFLIGHT_DISABLED disabled, $INFLIGHT_ENABLED enabled, $OTHER unread"
  [ "$INFLIGHT" -gt 0 ] || die "unobserved: no sample caught $CHOSEN_ID in flight, so this run says nothing about Continue during the download"
  # The defect first, so a run against it is reported as the defect and not as a missing sentinel.
  [ "$INFLIGHT_ENABLED" -eq 0 ] || die "Continue was enabled while $CHOSEN_ID was still on its way, because another model was on disk (#170)"
  [ "$INFLIGHT_DISABLED" -gt 0 ] || die "no in-flight sample read the button as disabled ($INFLIGHT in flight, $OTHER unread)"
fi

# --- the oracle: what reached the disk ------------------------------------------------------------
#
# Polled from the filesystem, not read off the screen. A progress bar is a claim by the same code
# under test; a file is not.
# Complete, not merely present, and settled: the size must reach what the catalogue advertises and
# then stop changing. `[ -s ]` alone passes on the first byte written.
MIN_BYTES=$(( CHOSEN_MB * 1000 * 1000 * 90 / 100 ))
FOUND=""; LAST=-1; STABLE=0
for _ in $(seq 1 300); do
  if [ -f "$APPDATA/models/$CHOSEN_FILE" ]; then
    NOW=$(stat -c %s "$APPDATA/models/$CHOSEN_FILE")
    if [ "$NOW" -ge "$MIN_BYTES" ]; then
      if [ "$NOW" = "$LAST" ]; then
        STABLE=$((STABLE + 1)); [ "$STABLE" -ge 3 ] && { FOUND=1; break; }
      else
        STABLE=0
      fi
    fi
    LAST="$NOW"
  fi
  sleep 1
done

if [ -z "$FOUND" ]; then
  say "what is on disk instead (${MIN_BYTES} bytes were required):"; ls -la "$APPDATA/models" | sed 's/^/    /'
  say "the screen said:"; js '"return document.body.innerText"' | head -20 | sed 's/^/    /'
  die "first run finished without fetching $CHOSEN_ID, the model that was chosen"
fi
say "the chosen model arrived whole: $CHOSEN_FILE ($(stat -c %s "$APPDATA/models/$CHOSEN_FILE") bytes, ${CHOSEN_MB} MB advertised)"

# The download line for the chosen file is the positive sentinel: the fetch happened, and it happened
# after the mark, so the catalogue's row did not start it.
if [ "$MODE" = catalogue ]; then
  FIRST=$(grep -nE "Downloading model file .+ -> .+/$CHOSEN_FILE" "$LOG" | head -1 | cut -d: -f1)
  [ -n "$FIRST" ] || die "the application never logged downloading $CHOSEN_FILE, and yet it is on disk"
  [ "$FIRST" -gt "$MARK" ] || die "the first download of $CHOSEN_FILE is at log line $FIRST, before the download screen opened (line $MARK)"
  say "the first download of $CHOSEN_FILE is at log line $FIRST, after the download screen opened (line $MARK)"
fi

# --- remote: the summariser fetched nothing, and the sentinel says the run was real ---------------
#
# An absence proves nothing on its own. The transcription file above is the sentinel: it arrived in
# this same run, through this same flow, so an empty `models/summary` is a decision rather than a
# process that never started.
if [ "$MODE" = remote ]; then
  SUMMARY_DIR="$APPDATA/models/summary"
  BYTES=$( [ -d "$SUMMARY_DIR" ] && du -sb "$SUMMARY_DIR" | cut -f1 || echo 0 )
  say "models/summary holds ${BYTES} bytes after choosing a cloud summariser (nothing was seeded)"
  if [ "${BYTES:-0}" -gt 1000000 ]; then
    ls -la "$SUMMARY_DIR" | sed 's/^/    /'
    die "a cloud summariser fetched ${BYTES} bytes of a local model; it needs a key, not weights"
  fi
  say "PASS (remote): the chosen model arrived and the cloud summariser downloaded nothing"
  PASSED=1
  exit 0
fi

# --- what the screen said while the file was arriving ---------------------------------------------
#
# **The disk oracle is right and it is also why three defects survived.** "A progress bar is a claim
# by the same code under test; a file is not" is true, and it is the reason this pass was green while
# the product owner was looking at `0.0 MB / 705.3 MB` for a file already on disk, at `~716 MB` for a
# 34 MB model, and at "You can continue" over a disabled button. The file arriving says nothing about
# what a person reads while it does. So the screen is read **as well**, never instead. (#157 measure C)
#
# Asserted against the model actually chosen, so the check cannot pass on a constant: `moonshine-tiny`
# is 34 MB and the default is 740, which is the pair that was wrong.
CARD=$(js '"return (() => { const h=[...document.querySelectorAll(\"section[aria-label]\")].find(e=>/'"$CHOSEN_ID"'/.test(e.textContent||\"\")); return h ? h.innerText.replace(/\\s+/g,\" \").trim() : \"NO ROW FOR THE CHOSEN MODEL\"; })()"')
say "the row for the chosen model reads: $CARD"
printf '%s' "$CARD" | grep -q "$CHOSEN_ID" \
  || die "the download screen shows no row naming $CHOSEN_ID; it named a different model or none"
printf '%s' "$CARD" | grep -qE "(^|[^0-9])${CHOSEN_MB}( |\.)" \
  || die "the row for $CHOSEN_ID does not state its ${CHOSEN_MB} MB: $CARD"
printf '%s' "$CARD" | grep -qE "\b(740|716)\b" \
  && die "the row states another model's size while fetching $CHOSEN_ID: $CARD"
say "and it states the chosen model's own size, not the default's"

# The footer's sentence and the button's state must agree. This is the contradiction the product
# owner photographed: "You can continue while this finishes" above a control disabled with "Waiting
# for the summary model", and the toast that explains the first sentence sitting in a branch the
# disabled button could never reach. Three sites, two answers, every check green.
FOOT=$(js '"return (() => { const f=document.querySelector(\"footer\"); if(!f) return \"NO FOOTER\"; const b=f.querySelector(\"button\"); return JSON.stringify({ read: (f.innerText||\"\").replace(/\\s+/g,\" \").trim(), disabled: !!(b && b.disabled) }); })()"')
say "the footer says: $FOOT"
printf '%s' "$FOOT" | python3 -c '
import json, sys, re
raw = sys.stdin.read().strip()
if raw == "NO FOOTER":
    print("NO FOOTER"); sys.exit(0)
f = json.loads(raw)
read, disabled = f["read"], f["disabled"]
promises = bool(re.search(r"you can continue|continue while", read, re.I))
waits    = bool(re.search(r"left to fetch|waiting for", read, re.I))
if disabled and promises: print("BROKEN: the footer says a person may continue while the control is disabled")
elif disabled and not waits: print("BROKEN: the control is disabled and the footer does not say what it waits for")
elif (not disabled) and waits: print("BROKEN: the footer says it is still waiting while the control is enabled")
else: print("OK")
' > /tmp/bc-foot.$$ 2>&1
FOOTV=$(cat /tmp/bc-foot.$$); rm -f /tmp/bc-foot.$$
case "$FOOTV" in
  OK) say "the footer and the control agree" ;;
  "NO FOOTER") die "the download screen has no footer; the approved shell puts the control in one" ;;
  *) die "$FOOTV -- $FOOT" ;;
esac

# The presence row is asserted by the `present` mode, not here. `chooses` and `keeps` seed only a
# **partial** summary model — 448 MB of 3651 MiB — so its row is correctly mid-download, and a first
# version of this check called that a defect. The state where a file really is already here has to be
# entered deliberately, which is what `present` is for.

# --- the step after this one is reachable ---------------------------------------------------------
#
# `AudioCheckStep` is 227 lines with a test file of its own, `OnboardingFlow.tsx:64` renders it at
# step 4, and off macOS **nobody reached it**: this screen's Continue called `completeOnboarding()`
# instead of `goNext()`, so first run ended here while the strip named four steps.
# `onboarding-flow.test.mjs:78` asserts which component step 4 renders and never asked whether
# anything sets step 4 — the map without the edges. This is the edge, driven.
# Named, not absent: `footer` is optional in `OnboardingContainer`, so "no disabled footer button" is
# also true of a screen with no footer button at all (#160, the same family as #157's sentinel rule).
await "[...document.querySelectorAll('footer button')].some(b=>b.textContent.trim()==='Continue' && !b.disabled)" \
      "Continue to become available" 120
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue on the download screen"
click "$CONT" "Continue on the download screen"
await "document.body.innerText.includes('Check your audio')" "the audio check, which is step 4" 30

# --- resumes: quit at step 4, launch again on the same profile, and the choices are still there (#172)
if [ "$MODE" = resumes ]; then
  DEFAULT_ID="parakeet-tdt-0.6b-v3-q8"; DEFAULT_FILE="parakeet-tdt-0.6b-v3-Q8_0.gguf"
  CLOUD_MODEL="claude-sonnet-4-5-20250929"
  # The 1 s auto-save must have written step 4 with both choices before the application ends. False in
  # the state being left, which saved step 3. On a build whose Rust struct lacks the fields it never
  # becomes true: serde drops keys the struct does not declare.
  STATUS_FILE="$APPDATA/onboarding-status.json"
  SAVED=""
  for _ in $(seq 1 30); do
    SAVED=$(python3 -I -c '
import json, sys
try:
    st = json.load(open(sys.argv[1]))["status"]
except Exception:
    print(""); raise SystemExit
ms = st.get("model_status", {})
print(json.dumps([st.get("current_step"), ms.get("selected_transcribe_model"), ms.get("summary_provider")]))' "$STATUS_FILE")
    [ "$SAVED" = "[4, \"$CHOSEN_ID\", \"claude\"]" ] && break
    sleep 0.5
  done
  [ "$SAVED" = "[4, \"$CHOSEN_ID\", \"claude\"]" ] \
    || die "the status never named both choices at step 4: it reads ${SAVED:-nothing} -- the saved payload or the Rust struct drops them"
  say "the status names both choices at step 4: $SAVED"

  # End the first launch, and prove it ended: a second launch would otherwise hand its argv to it.
  curl -s -m 20 -X DELETE "$BASE" > /dev/null || true
  GONE=""
  for _ in $(seq 1 20); do app_pid > /dev/null || { GONE=1; break; }; sleep 0.5; done
  if [ -z "$GONE" ]; then
    # Ending the session did not end the process. A person quitting is what this stands for, so it is
    # ended the way a quit would be, and the pass says so.
    PID=$(app_pid) && { say "the first launch outlived its session; sending it SIGTERM (pid $PID)"; kill -TERM "$PID" 2>/dev/null || true; }
    for _ in $(seq 1 20); do app_pid > /dev/null || { GONE=1; break; }; sleep 0.5; done
  fi
  [ -n "$GONE" ] || die "the first launch is still running 20 s after its session ended and a SIGTERM (pid $(app_pid))"
  LOG=$(ls -t "$APPDATA"/logs/*.log 2>/dev/null | head -1)
  [ -n "$LOG" ] || die "the application wrote no log under $APPDATA/logs"
  OFFSET=$(stat -c %s "$LOG")
  say "the first launch has ended; its log is $OFFSET bytes"

  # The second launch, on the same driver and profile.
  SESSION=""
  for attempt in 1 2 3 4 5; do
    RESP=$(curl -s -m 30 -X POST "http://127.0.0.1:$PORT/session" -H 'Content-Type: application/json' \
      -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$APP\",\"args\":[]}}}}" || true)
    SESSION=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["value"]["sessionId"])
except Exception: print("")' 2>/dev/null)
    [ -n "$SESSION" ] && break
    sleep 2
  done
  [ -n "$SESSION" ] || die "no WebDriver session for the second launch: ${RESP:-no answer}"
  BASE="http://127.0.0.1:$PORT/session/$SESSION"
  # False in the state left: a new process starts at step 1 and reaches step 4 only from its status.
  await "document.body.innerText.includes('Check your audio')" "the second launch to resume at the audio check" 60
  say "the second launch resumed at the audio check"
  [ -e "$APPDATA/models/$DEFAULT_FILE" ] && die "precondition: the default's file is on disk, so a fallback to it could answer"

  # Collected, then failed once, so a run against the defect lists every condition it breaks.
  FAILS=()
  # Not redacted: the harness is the microphone here, so the words are jfk.wav's, never the room's.
  AUDIO_CHECK_REDACT=
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/audio-check.sh"
  # The picker's first entry is whatever the machine lists first, not the default input, so the
  # harness is picked by the description PipeWire reports, as `stage2-core-check.sh` does.
  HARNESS_DESC=$(pw-dump | python3 -c '
import json, sys
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("node.name") == "backchannel_harness_src":
        print(p.get("node.description") or ""); break
')
  [ -n "$HARNESS_DESC" ] || die "the harness source is not in the graph"
  TRIG=$(find_el '{"using":"xpath","value":"//button[@aria-label=\"Microphone\"]"}')
  [ -n "$TRIG" ] || die "no microphone picker on the audio check"
  click "$TRIG" "the microphone picker"
  await "document.querySelectorAll('[role=option]').length > 0" "the microphone list to open" 15
  OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='option'][contains(normalize-space(),\\\"$HARNESS_DESC\\\")]\"}")
  [ -n "$OPT" ] || die "the audio check does not offer the harness microphone '$HARNESS_DESC'"
  click "$OPT" "the harness microphone"
  await "(function(){var t=document.querySelector('button[aria-label=Microphone]');return !!t&&t.textContent.indexOf('$HARNESS_DESC')>=0;})()" \
        "the picker to show the harness microphone" 10
  MIC=$(audio_check_field "$(audio_check_read Microphone)" device)
  case "$MIC" in *"$HARNESS_DESC"*) ;; *) die "the microphone picker holds '$MIC', not the harness; the check would hear the room" ;; esac
  audio_check_press
  OUT=$( (audio_check_require_body_answer) 2>&1 ) || FAILS+=("the check: $OUT")
  [ "$(stat -c %s "$LOG")" -ge "$OFFSET" ] || die "the log is shorter than before the relaunch: it rotated, and the relaunch's lines are lost"
  L="$PROFILE/after-relaunch.log"
  tail -c +$((OFFSET + 1)) "$LOG" > "$L"
  grep -q "Loading model $CHOSEN_ID from" "$L" || FAILS+=("the second launch never loaded $CHOSEN_ID")
  # A guard with no control: with the default's file absent, no build writes this line.
  grep -q "Loading model $DEFAULT_ID from" "$L" && FAILS+=("the second launch loaded the default, $DEFAULT_ID")

  FIN=$(by_text "Continue"); [ -n "$FIN" ] || FIN=$(by_text "Finish"); [ -n "$FIN" ] || FIN=$(by_text "Done")
  [ -n "$FIN" ] || die "nothing finishes the audio check on the second launch"
  click "$FIN" "the control that finishes first run"
  await "document.body.innerText.includes('MEETINGS')" "the main screen after first run" 90
  READ=""
  for _ in $(seq 1 40); do
    READ=$(python3 -I -c '
import json, sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    t = c.execute("select model from transcript_settings").fetchone()
    s = c.execute("select provider, model from settings").fetchone()
    print(json.dumps([t[0] if t else None, list(s) if s else None]))
except Exception as e:
    print(json.dumps([None, None, str(e)]))' "$APPDATA/meeting_minutes.sqlite")
    case "$READ" in "[null"*) sleep 0.5 ;; *) break ;; esac
  done
  say "stored after the resumed first run: $READ"
  case "$READ" in "[\"$CHOSEN_ID\", "*) ;; *) FAILS+=("transcript_settings.model is not $CHOSEN_ID: $READ") ;; esac
  # Step 2 already wrote this pair, so it goes red only by being overwritten at completion.
  case "$READ" in *"[\"claude\", \"$CLOUD_MODEL\"]]") ;; *) FAILS+=("settings is not (claude, $CLOUD_MODEL): $READ") ;; esac

  # Guards with no control: at a step-4 resume the unfixed build fetches neither.
  SUMMARY_BYTES=$( [ -d "$APPDATA/models/summary" ] && du -sb "$APPDATA/models/summary" | cut -f1 || echo 0 )
  [ "${SUMMARY_BYTES:-0}" -gt 1000000 ] && FAILS+=("models/summary holds $SUMMARY_BYTES bytes with Claude chosen")
  [ -e "$APPDATA/models/$DEFAULT_FILE" ] && FAILS+=("the default's file appeared")

  [ ${#FAILS[@]} -eq 0 ] || die "the resumed first run lost its choices: $(printf '%s | ' "${FAILS[@]}")"
  PASSED=1
  say "PASS (resumes): the second launch resumed at step 4 with $CHOSEN_ID and Claude, checked with $CHOSEN_ID, and stored both"
  exit 0
fi

# --- the audio check, pressed (#167) --------------------------------------------------------------
#
# This used to count the screen's controls and stop, and every release build answered `Command
# check_capture_device not found` to the one that mattered. The product owner found it by pressing it.
# No harness is up in this pass, so the device carries no known signal, and any answer the command's
# body gives is accepted: a rendered result or one of its own errors. Whether the words come back is
# `stage2-core-check.sh`'s assertion, which has a microphone speaking a known sentence (#168).
#
# The two #167 assertions are collected before either fails, so one run against a build that has
# both defects reports both rather than the first. The decoded words are not logged: with no harness
# the picker's first input is the machine's real microphone.
AUDIO_CHECK_REDACT=1
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/audio-check.sh"
audio_check_press
FAILED_167=""
if OUT=$( (audio_check_require_body_answer) 2>&1 ); then :; else FAILED_167="$OUT"; fi
if OUT=$( (probe_stays_out) 2>&1 ); then say "${OUT#stage2-onboarding-check: }"; else FAILED_167="${FAILED_167:+$FAILED_167
}$OUT"; fi
[ -z "$FAILED_167" ] || die "the audio check (#167):
$FAILED_167"

DEFAULT_FILE="parakeet-tdt-0.6b-v3-Q8_0.gguf"
if { [ "$MODE" = chooses ] || [ "$MODE" = catalogue ]; } && [ -e "$APPDATA/models/$DEFAULT_FILE" ]; then
  die "the default was fetched as well as the choice; the choice is not what drives the download"
fi

# --- catalogue: first run finishes with the catalogue's choice stored (#166 condition 2) ----------
#
# `completeOnboarding` asks for the selected summary model whatever the provider (#181). For a cloud
# pick that name is the cloud model, which the backend's exact lookup should reject; that is read, not
# run, so this pass reports what reached models/summary rather than asserting either way.
if [ "$MODE" = catalogue ]; then
  FIN=$(by_text "Continue"); [ -n "$FIN" ] || FIN=$(by_text "Finish"); [ -n "$FIN" ] || FIN=$(by_text "Done")
  [ -n "$FIN" ] || die "nothing finishes the audio check; buttons: $(js '"return [...document.querySelectorAll(\"button\")].map(b=>b.textContent.trim()).filter(Boolean).join(\" / \")"')"
  click "$FIN" "the control that finishes first run"
  # False on the audio check: the main screen only exists once first run has reloaded into it.
  await "document.body.innerText.includes('MEETINGS')" "the main screen after first run" 90
  STORED=""
  for _ in $(seq 1 40); do
    STORED=$(python3 -I -c '
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    r = c.execute("select model from transcript_settings").fetchone()
    print(r[0] if r else "")
except Exception:
    print("")' "$APPDATA/meeting_minutes.sqlite")
    [ "$STORED" = "$CHOSEN_ID" ] && break
    sleep 0.5
  done
  [ "$STORED" = "$CHOSEN_ID" ] || die "chose $CHOSEN_ID in the catalogue and the application stored '${STORED:-<nothing>}'"
  # Again after finishing: the check above runs before the finishing click, and finishing is where #130
  # fetched the default (#166's gate).
  [ -e "$APPDATA/models/$DEFAULT_FILE" ] && die "finishing first run fetched the default, $DEFAULT_FILE, as well as $CHOSEN_ID"
  sleep 5
  # The log too, after the wait: the file exists only once the HTTP response has arrived, and the
  # `catalogue` mode's own C3 control started a download that left models/ unchanged for the whole
  # walk. The line is written before the request (#166's gate, round 2).
  grep -nE "Downloading model file .+/$DEFAULT_FILE" "$LOG" \
    && die "finishing first run started a download of the default, $DEFAULT_FILE, as well as $CHOSEN_ID"
  say "first run finished and transcript_settings.model is $STORED; the default's file is still absent, and nothing started fetching it"
  SUMMARY_BYTES=$( [ -d "$APPDATA/models/summary" ] && du -sb "$APPDATA/models/summary" | cut -f1 || echo 0 )
  say "models/summary holds ${SUMMARY_BYTES} bytes 5 s after finishing with Claude chosen (nothing was seeded; #181)"
fi

if [ "$MODE" = keeps ]; then
  PRESENT_AFTER=$(stat -c '%Y %s' "$APPDATA/models/$PRESENT_FILE")
  [ "$PRESENT_BEFORE" = "$PRESENT_AFTER" ] \
    || die "$PRESENT_FILE was re-fetched: $PRESENT_BEFORE -> $PRESENT_AFTER"
  say "the model that was already there was left alone: $PRESENT_AFTER"
fi

PASSED=1
say "PASS ($MODE): first run downloaded the model the person chose"

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
#   scripts/stage2-onboarding-check.sh <AppImage> [chooses|keeps] [profile-dir]
#
#     chooses  the chosen model's file must appear                      (default)
#     keeps    a different model is already on disk; the chosen one must still arrive,
#              and the one already there must not be fetched again
set -euo pipefail

APP="${1:?usage: stage2-onboarding-check.sh <AppImage> [chooses|keeps] [profile-dir]}"
MODE="${2:-chooses}"
PROFILE="${3:-}"
PORT="${BC_WD_PORT:-14446}"
NATIVE_PORT="${BC_WD_NATIVE_PORT:-14447}"
CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"

# Not the default. See the header.
CHOSEN_ID="moonshine-tiny-q8"
CHOSEN_FILE="moonshine-tiny-Q8_0.gguf"
PRESENT_FILE="parakeet-tdt-0.6b-v3-Q8_0.gguf"

say() { printf 'stage2-onboarding-check: %s\n' "$*"; }
die() { printf 'stage2-onboarding-check: %s\n' "$*" >&2; exit 1; }

case "$MODE" in chooses|keeps) ;; *) die "mode must be chooses or keeps, not '$MODE'" ;; esac
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
if [ -d "$CACHE/models/summary" ]; then
  cp -a --reflink=auto "$CACHE/models/summary" "$APPDATA/models/summary" 2>/dev/null \
    || cp -a "$CACHE/models/summary" "$APPDATA/models/summary"
  say "seeded the summary model only; no onboarding marker, no transcription model"
else
  say "no summary model in $CACHE — first run will fetch one, and this pass will take much longer"
fi

if [ "$MODE" = keeps ]; then
  [ -f "$CACHE/models/$PRESENT_FILE" ] || die "mode 'keeps' needs $PRESENT_FILE in $CACHE/models"
  cp -a "$CACHE/models/$PRESENT_FILE" "$APPDATA/models/$PRESENT_FILE"
  PRESENT_BEFORE=$(stat -c '%Y %s' "$APPDATA/models/$PRESENT_FILE")
  say "placed $PRESENT_FILE on disk first: $PRESENT_BEFORE"
fi

[ -f "$APPDATA/models/$CHOSEN_FILE" ] && die "the chosen model is already on disk; this pass would prove nothing"
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
  # Kept on failure: the application's own logs/ live in there, and the driver log alone does
  # not say what the app was doing. stage2-record-check.sh keeps its profile for the same reason.
  if [ -n "${OWN_PROFILE:-}" ] && [ "${PASSED:-}" = "1" ]; then
    rm -rf "$PROFILE"
  elif [ -n "${OWN_PROFILE:-}" ]; then
    printf 'stage2-onboarding-check: profile kept for inspection: %s\n' "$PROFILE" >&2
  fi
}
trap cleanup EXIT

HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" \
  setsid tauri-driver --port "$PORT" --native-port "$NATIVE_PORT" > "$DRIVER_LOG" 2>&1 &
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
click() { curl -s -m 20 -X POST "$BASE/element/$1/click" -H 'Content-Type: application/json' -d '{}' >/dev/null; }
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

# --- first run is on screen, because nothing seeded it away ---------------------------------------
await "document.body.innerText.includes('Choose a transcription model')" "the first-run screen" 90
say "first run is on screen"

# --- choose a model that is not the default -------------------------------------------------------
#
# The radio itself is `sr-only`, so the label carrying the id is the clickable thing.
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//label[.//text()[contains(.,\\\"$CHOSEN_ID\\\")]]\"}")
[ -n "$OPT" ] || die "no option labelled $CHOSEN_ID on the first-run screen"
click "$OPT"
await "document.querySelector('input[name=\\\"transcription-model\\\"]:checked') !== null" "a checked option" 10

CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue button on the model screen"
click "$CONT"

# --- the summariser screen, left on its default (its model is seeded, so nothing is fetched) ------
await "document.body.innerText.includes('Choose a summariser')" "the summariser screen" 30
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue button on the summariser screen"
click "$CONT"
say "walked to the download screen"

# --- the oracle: what reached the disk ------------------------------------------------------------
#
# Polled from the filesystem, not read off the screen. A progress bar is a claim by the same code
# under test; a file is not.
FOUND=""
for _ in $(seq 1 300); do
  if [ -s "$APPDATA/models/$CHOSEN_FILE" ]; then FOUND=1; break; fi
  sleep 1
done

if [ -z "$FOUND" ]; then
  say "what is on disk instead:"; ls -la "$APPDATA/models" | sed 's/^/    /'
  say "the screen said:"; js '"return document.body.innerText"' | head -20 | sed 's/^/    /'
  die "first run finished without fetching $CHOSEN_ID, the model that was chosen"
fi
say "the chosen model arrived: $CHOSEN_FILE ($(du -h "$APPDATA/models/$CHOSEN_FILE" | cut -f1))"

DEFAULT_FILE="parakeet-tdt-0.6b-v3-Q8_0.gguf"
if [ "$MODE" = chooses ] && [ -e "$APPDATA/models/$DEFAULT_FILE" ]; then
  die "the default was fetched as well as the choice; the choice is not what drives the download"
fi

if [ "$MODE" = keeps ]; then
  PRESENT_AFTER=$(stat -c '%Y %s' "$APPDATA/models/$PRESENT_FILE")
  [ "$PRESENT_BEFORE" = "$PRESENT_AFTER" ] \
    || die "$PRESENT_FILE was re-fetched: $PRESENT_BEFORE -> $PRESENT_AFTER"
  say "the model that was already there was left alone: $PRESENT_AFTER"
fi

PASSED=1
say "PASS ($MODE): first run downloaded the model the person chose"

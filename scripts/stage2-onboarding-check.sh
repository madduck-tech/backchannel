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
#   scripts/stage2-onboarding-check.sh <AppImage> [chooses|keeps|remote] [profile-dir]
#
#     chooses  the chosen model's file must appear                      (default)
#     keeps    a different model is already on disk; the chosen one must still arrive,
#              and the one already there must not be fetched again
#     remote   a cloud summariser is chosen; `models/summary` must stay EMPTY while the
#              transcription model still arrives
#     present  the chosen model is already on disk; the screen must say so in words and count no
#              bytes, and Continue must be available at once
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

APP="${1:?usage: stage2-onboarding-check.sh <AppImage> [chooses|keeps] [profile-dir]}"
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

say() { printf 'stage2-onboarding-check: %s\n' "$*"; }
die() { printf 'stage2-onboarding-check: %s\n' "$*" >&2; exit 1; }

case "$MODE" in chooses|keeps|remote|present) ;; *) die "mode must be chooses, keeps, remote or present, not '$MODE'" ;; esac
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
if [ "$MODE" != remote ] && [ -d "$CACHE/models/summary" ]; then
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

# --- the summariser screen ------------------------------------------------------------------------
#
# `chooses` and `keeps` leave it on its default, which is `builtin-ai`, and its model is seeded, so
# nothing is fetched for it. `remote` picks a cloud provider and types a key, which is the state
# neither of the others has ever entered.
await "document.body.innerText.includes('Where should the summary be written')" "the summariser screen" 30
if [ "$MODE" = remote ]; then
  OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role='radio'][.//text()[contains(.,'claude')]]\"}")
  [ -n "$OPT" ] || die "no Claude option on the summariser screen"
  click "$OPT"
  await "document.querySelector('input[type=password]') !== null" "Claude's key field" 10
  KEY=$(find_el '{"using":"css selector","value":"input[type=password]"}')
  [ -n "$KEY" ] || die "no key field after choosing Claude"
  curl -s -m 20 -X POST "$BASE/element/$KEY/value" -H 'Content-Type: application/json' \
    -d '{"text":"sk-not-a-real-key-for-a-gate-run"}' > /dev/null
  # A typed value is not a stored one: assert the field holds it before moving on.
  await "(document.querySelector('input[type=password]')||{}).value.length > 10" "the key to be typed" 10
  say "chose Claude and typed a key — nothing local should be fetched for the summariser"
fi
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue button on the summariser screen"
click "$CONT"
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
await "!document.querySelector('footer button[disabled]')" "Continue to become available" 120
CONT=$(by_text "Continue"); [ -n "$CONT" ] || die "no Continue on the download screen"
click "$CONT"
await "document.body.innerText.includes('Check your audio')" "the audio check, which is step 4" 30
DEVICES=$(js '"return [...document.querySelectorAll(\"select, [role=combobox], button\")].length"')
say "the audio check is on screen, and offers ${DEVICES} controls to pick a device with"

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

#!/usr/bin/env bash
#
# Drive the built application through a recording and check that the words in the
# harness's sample come back as a transcript.
#
#   scripts/stage2-record-check.sh <AppImage> <profile-dir> <expected-word> [more words...]
#
# The point of this script is one observation: **the transcript contains what was played**.
# Everything else it does is scaffolding to get there. "The app did not crash" and "a
# stream was created" are proxies, and a harness feeding silence passes both of them —
# which is exactly the failure this check exists to catch.
#
# A clean profile downloads about 4.3 GB before it can record — the transcription model
# gates recording, and a summary model starts on the same screen without being gated. That
# is once, not once per run: models are cached in BC_MODELS_CACHE (default
# ~/.cache/backchannel-gate-models) and seeded into each fresh profile, along with the
# onboarding marker, so later runs skip onboarding entirely and download nothing. Delete
# that directory to force a real first-run.
#
# It drives the UI through Orca's computer-use CLI against the accessibility tree. There
# are no screenshots on the Linux provider, so the tree is the only thing to steer by, and
# **element indices are positional**: they shift after every interaction, so each click
# re-reads the tree and finds its target by label rather than reusing a number.

set -euo pipefail

APP="${1:?usage: stage2-record-check.sh <AppImage> <profile-dir> <expected-word>...}"
PROFILE="${2:?missing profile dir}"
shift 2
[ $# -gt 0 ] || { echo "stage2-record-check: give at least one expected word" >&2; exit 2; }
EXPECTED=("$@")

LOG="$PROFILE/stdout.log"
PIDFILE="$PROFILE/pid"

say() { printf 'stage2-record-check: %s\n' "$*"; }
die() { printf 'stage2-record-check: %s\n' "$*" >&2; exit 1; }

tree() {
  orca-ide computer get-app-state --app "pid:$(cat "$PIDFILE")" --no-screenshot --json 2>/dev/null \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["snapshot"]["treeText"])
except Exception: pass'
}

# Find a control by the label it shows and click it, re-reading the tree first.
click_labelled() {
  local want="$1" timeout="${2:-30}" waited=0 idx
  while :; do
    idx="$(tree | python3 -c '
import re, sys
want = sys.argv[1]
for line in sys.stdin:
    m = re.match(r"\s*(\d+) (?:push button|page tab) (.+?)(?:,|$)", line)
    if m and m.group(2).strip() == want:
        print(m.group(1)); break
' "$want")"
    [ -n "$idx" ] && break
    waited=$((waited + 2)); [ "$waited" -ge "$timeout" ] && return 1
    sleep 2
  done
  orca-ide computer click --app "pid:$(cat "$PIDFILE")" --element-index "$idx" >/dev/null 2>&1
  say "clicked '$want'"
  sleep 3
}

CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"
APPDATA="$PROFILE/home/.local/share/com.conversationaly.ai"

say "launching $APP on $PROFILE"
mkdir -p "$PROFILE/home"

# Seed models and the onboarding marker from the cache, so a "clean" profile is clean in
# every way that matters to the gate without re-downloading gigabytes. Nothing here fakes
# application state beyond what a second launch on a real machine would already have.
if [ -d "$CACHE/models" ]; then
  mkdir -p "$APPDATA"
  cp -a --reflink=auto "$CACHE/models" "$APPDATA/models" 2>/dev/null || cp -a "$CACHE/models" "$APPDATA/models"
  [ -f "$CACHE/onboarding-status.json" ] && cp -a "$CACHE/onboarding-status.json" "$APPDATA/"
  say "seeded models from $CACHE — no downloads this run"
else
  say "no model cache at $CACHE — this run downloads them (about 4.3 GB) and fills it"
fi

# Optional: pin a system-audio device before the first launch. The application resolves
# preferred_system_device through AudioDevice::from_name, which insists on an "(output)"
# suffix, and the store lives in the *data* directory rather than the config one -- both
# settled by experiment, both easy to get wrong.
if [ -n "${BC_PREFERRED_SYSTEM_DEVICE:-}" ]; then
  store="$PROFILE/home/.local/share/com.conversationaly.ai"
  mkdir -p "$store" "$PROFILE/rec"
  printf '{"preferences":{"save_folder":"%s","auto_save":true,"file_format":"mp4","preferred_mic_device":null,"preferred_system_device":"%s"}}' \
    "$PROFILE/rec" "$BC_PREFERRED_SYSTEM_DEVICE" > "$store/recording_preferences.json"
  say "pinned system audio to '$BC_PREFERRED_SYSTEM_DEVICE'"
fi
( HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" \
  nohup "$APP" > "$LOG" 2>&1 & echo $! > "$PIDFILE" )
sleep 20
kill -0 "$(cat "$PIDFILE")" 2>/dev/null || die "the application exited during startup; see $LOG"

# A clean profile starts at onboarding. On a profile that already has the models these
# steps are absent, so a missing button is not a failure here.
click_labelled "Get Started" 20 || say "no onboarding (profile already set up)"
click_labelled "Let's Go" 20 || true

# Recording is hard-gated on the transcription model, so this wait is not optional.
# A clean profile pulls ~4.3 GB in total: the transcription model plus a summary model
# that starts on the same screen and is not gated by Continue.
say "waiting for the transcription model (it gates recording)"
if ! click_labelled "Continue" 900; then
  die "the transcription model did not finish downloading in 15 minutes"
fi

click_labelled "Start recording" 60 || die "no 'Start recording' control appeared"

grep -q 'Failed to create microphone stream' "$LOG" \
  && die "the microphone stream could not be created; see $LOG"

say "recording; waiting for the transcript"
deadline=$((SECONDS + 180))
while [ $SECONDS -lt $deadline ]; do
  text="$(tree)"
  missing=0
  for word in "${EXPECTED[@]}"; do
    printf '%s' "$text" | grep -qi -- "$word" || missing=1
  done
  if [ "$missing" -eq 0 ]; then
    say "transcript contains: ${EXPECTED[*]}"
    if [ ! -d "$CACHE/models" ] && [ -d "$APPDATA/models" ]; then
      mkdir -p "$CACHE"
      cp -a --reflink=auto "$APPDATA/models" "$CACHE/models" 2>/dev/null || cp -a "$APPDATA/models" "$CACHE/models"
      [ -f "$APPDATA/onboarding-status.json" ] && cp -a "$APPDATA/onboarding-status.json" "$CACHE/"
      say "cached models to $CACHE — later runs will not download them"
    fi
    printf '%s' "$text" | grep -io -- "${EXPECTED[0]}[^,]*" | head -2 | sed 's/^/    /'
    exit 0
  fi
  sleep 10
done

say "the transcript never contained: ${EXPECTED[*]}"
say "check that the harness is up and delivering audio: scripts/audio-harness.sh status"
exit 1

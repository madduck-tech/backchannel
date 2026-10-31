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
# One trap in that cache, deliberate and worth knowing: the snapshot is taken as soon as
# recording becomes possible, so the summary model in it is usually *partial* while the
# onboarding marker says it is downloaded. The gate never summarises, so this costs it
# nothing. Anyone testing summaries must delete the cache first and let a real download
# finish.
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
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/kept-profile.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/harness-guard.sh"
# From the Start click on, a failure may have recorded a microphone, so the recordings go before the
# profile is kept (#293).
STARTED=0
trap 'rc=$?; [ "$rc" -ne 0 ] && [ "$STARTED" = 1 ] && harness_guard_drop_recordings "$PROFILE"; exit $rc' EXIT

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
  # The click's own exit status is the return value. It used to be discarded before `say` ran, so a
  # click that failed printed "clicked 'X'" and the run carried on -- the same shape as the "a call
  # that returns success is not evidence it did anything" rule in .claude/rules/testing.md, one level
  # down: here the call reported nothing at all and success was assumed. (#130)
  if ! orca-ide computer click --app "pid:$(cat "$PIDFILE")" --element-index "$idx" >/dev/null 2>&1; then
    say "the driver refused to click '$want'"
    return 2
  fi
  say "clicked '$want'"
  sleep 3
}

CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"
# Whether this run seeded the "onboarding is done" marker. It decides which of the two states below is
# required, so that "the screen is absent because we skipped it" stops being indistinguishable from
# "the screen is absent because its buttons were renamed" (#130).
SEEDED_ONBOARDING=0
APPDATA="$PROFILE/home/.local/share/tech.madduck.backchannel"

say "launching $APP on $PROFILE"
mkdir -p "$PROFILE/home"

# Seed models and the onboarding marker from the cache, so a "clean" profile is clean in
# every way that matters to the gate without re-downloading gigabytes. Nothing here fakes
# application state beyond what a second launch on a real machine would already have.
if [ -d "$CACHE/models" ]; then
  mkdir -p "$APPDATA"
  seed_copy "$CACHE/models" "$APPDATA/models" || die "could not seed $APPDATA/models from $CACHE/models"
  if [ -f "$CACHE/onboarding-status.json" ]; then
    cp -a "$CACHE/onboarding-status.json" "$APPDATA/"
    SEEDED_ONBOARDING=1
  fi
  say "seeded models from $CACHE — no downloads this run"
else
  say "no model cache at $CACHE — this run downloads them (about 4.3 GB) and fills it"
fi

# The microphone is the harness's source, named, on every run (#293): the harness no longer becomes the
# default input, so an unnamed microphone would be the person's own. The source is the one this run's
# `up` made, read from its state, since the harness comes up in an entry of its own. The application
# resolves both preferences through AudioDevice::from_name, which insists on the "(input)" and
# "(output)" suffixes, and the store lives in the *data* directory rather than the config one -- both
# settled by experiment, both easy to get wrong.
HARNESS_SRC=$("$(dirname "${BASH_SOURCE[0]}")/audio-harness.sh" src-name 2>/dev/null) \
  || die "no harness is up, so there is no microphone to name; bring the audio harness up with --system-only first, as gopnik.json's stage 2 does"
HARNESS_DESC=$(harness_description "$HARNESS_SRC") || die "the audio graph could not be read"
[ -n "$HARNESS_DESC" ] || die "the harness source $HARNESS_SRC is not in the graph"
MIC_SEED="$HARNESS_DESC (input)"
store="$APPDATA"
mkdir -p "$store" "$PROFILE/rec"
python3 -c 'import json,sys
print(json.dumps({"preferences":{"save_folder":sys.argv[1],"auto_save":True,"file_format":"mp4","preferred_mic_device":sys.argv[2],"preferred_system_device":sys.argv[3] or None}}))' \
  "$PROFILE/rec" "$MIC_SEED" "${BC_PREFERRED_SYSTEM_DEVICE:-}" > "$store/recording_preferences.json"
say "named the microphone '$MIC_SEED' ($HARNESS_SRC)"
[ -z "${BC_PREFERRED_SYSTEM_DEVICE:-}" ] || say "pinned system audio to '$BC_PREFERRED_SYSTEM_DEVICE'"
# setsid, so the application leads its own process group and the caller can stop the
# whole tree at once. Killing only the parent leaves WebKit's helper processes to die
# on their own, which the desktop reports to the user as a crash.
( HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" \
  setsid nohup "$APP" > "$LOG" 2>&1 & echo $! > "$PIDFILE" )
sleep 20
kill -0 "$(cat "$PIDFILE")" 2>/dev/null || die "the application exited during startup; see $LOG"

# Which of the two states is required is decided by what this run seeded, not discovered by trying a
# button and shrugging when it is missing.
#
# Until #130 this was one unconditional `if`, with `|| true` on the arm inside it, over the labels
# "Get Started" and "Let's Go". Both were deleted by 009b37d and neither has existed since, so the
# branch could only ever take the else -- and it did so silently, on every run, in exactly the shape
# of a profile that was set up correctly.
if [ "$SEEDED_ONBOARDING" = 1 ]; then
  # The marker says first run is done, so first run must not be on screen. If it is, the marker did
  # not take, and every later step would be measuring a different application state than the one this
  # pass claims to be in.
  if [ -n "$(tree | grep -m1 'Choose a transcription model' || true)" ]; then
    die "the onboarding marker was seeded but first run is on screen; the profile is not what this pass assumes"
  fi
  say "no onboarding (marker seeded) - going straight to recording"
else
  # An unseeded profile really does start at first run, and walking it is NOT this script's job: the
  # accessibility tree reaches push buttons and page tabs only, and the model options are radio cards.
  # scripts/stage2-onboarding-check.sh drives that through tauri-driver. Failing here with the reason
  # beats the previous behaviour, which was to fall through and die 60 seconds later at
  # "no 'Start recording' control appeared".
  die "no model cache at $CACHE, so this profile starts at first run. Seed the cache, or run scripts/stage2-onboarding-check.sh, which drives first run properly."
fi

GUARD=$(harness_guard_before_start "$store/recording_preferences.json" "$MIC_SEED" "$HARNESS_SRC" 2>&1) \
  || die "before Start (#293): $GUARD"
BEFORE=$(grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" || true)
STARTED=1
if ! click_labelled "Start recording" 60; then
  # Say what was on screen instead. A driver that reports only "the control was not
  # there" makes every failure look the same, and most of them are not.
  say "the tree at that moment was:"; tree | sed 's/^/    /' | head -40
  die "no 'Start recording' control appeared"
fi

grep -q 'Failed to create microphone stream' "$LOG" \
  && die "the microphone stream could not be created; see $LOG"
# What the start opened, read after its own CALLED line, and the link that shows it did (#293).
for _ in $(seq 1 40); do [ "$(grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" || true)" -gt "$BEFORE" ] && break; sleep 0.5; done
[ "$(grep -c 'CALLED start_recording_with_devices_and_meeting' "$LOG" || true)" -gt "$BEFORE" ] || die "the app logged no CALLED line for this start; see $LOG"
N=$(grep -n 'CALLED start_recording_with_devices_and_meeting' "$LOG" | tail -1 | cut -d: -f1)
for _ in $(seq 1 40); do tail -n +"$N" "$LOG" | grep 'Microphone stream created successfully' >/dev/null && break; sleep 0.5; done
GUARD=$(harness_guard_after_start "$LOG" "$N" "$HARNESS_DESC" "$HARNESS_SRC" 20 "$(cat "$PIDFILE")" 2>&1) || die "after Start (#293): $GUARD"
say "the start opened the harness microphone by name, and the graph links $HARNESS_SRC into the application"

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

#!/usr/bin/env bash
# Can this application start with no desktop? (#67, condition 0)
#
# A measurement, not a check. It always exits 0 and prints a verdict, in the same shape as
# `scripts/environment-record.sh` — because the honest answer might be "no", and a probe that
# fails the build when the answer is no is a probe nobody can afford to run.
#
# Why it exists: #67 wants a `.deb` installed and launched in CI, and every condition in it
# rests on the application being able to start headless at all. Nothing in this repository has
# ever done that. Four obstacles were named and none measured:
#
#   1. `xvfb-run` provides an X display but no session bus; GTK/WebKit normally want D-Bus.
#   2. WebKitGTK's bubblewrap sandbox usually needs WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
#      in an unprivileged container.
#   3. No GPU: software GL (LIBGL_ALWAYS_SOFTWARE, WEBKIT_DISABLE_COMPOSITING_MODE).
#   4. Whether a release binary writes anything to stdout at all.
#
# **#43 already refuted the nearest neighbour of this idea**: `stage2-ui-check.sh` under
# `xvfb-run` dies because a hosted runner has no sink monitors, so the system-audio picker offers
# only the default and the script `die`s for a reason unrelated to the UI. This probe is narrower
# — no audio, no WebDriver, no picker, no interaction. It asks one question: does the process come
# up and stay up. If the answer is no, that is the finding, and #67's condition 1 is not built on
# sand.
#
# Usage: scripts/headless-launch-probe.sh <AppImage> [seconds]

set -u

APP=${1:?usage: headless-launch-probe.sh <AppImage> [seconds]}
ALIVE_FOR=${2:-20}

say() { printf '%s\n' "$*"; }
verdict() { printf '\nHEADLESS LAUNCH PROBE: %s\n' "$*"; }

say "backchannel headless launch probe v1"
say "  appimage        $APP"
say "  alive-for       ${ALIVE_FOR}s"
say "  xvfb-run        $(command -v xvfb-run || echo absent)"
say "  dbus-run-session $(command -v dbus-run-session || echo absent)"

if ! command -v xvfb-run >/dev/null; then
  verdict "NOT ATTEMPTED — xvfb-run is not installed. Nothing measured."
  exit 0
fi

WORK=$(mktemp -d /tmp/headless-probe.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# Extract rather than mount: --appimage-extract-and-run needs FUSE, which a container often
# lacks, and that failure would be mistaken for the application failing.
say "  extracting…"
( cd "$WORK" && "$(readlink -f "$APP")" --appimage-extract >/dev/null 2>&1 )
BIN=$(find "$WORK/squashfs-root/usr/bin" -maxdepth 1 -type f -name 'conversationaly*' | head -1)
if [ ! -x "${BIN:-}" ]; then
  verdict "NOT ATTEMPTED — could not extract a runnable binary from the AppImage."
  exit 0
fi
say "  binary          $BIN"

LOG="$WORK/stdout.log"
export HOME="$WORK/home"; mkdir -p "$HOME"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_CACHE_HOME="$HOME/.cache"
# The three environment variables obstacle 2 and 3 are about. Set here rather than discovered:
# if the launch only works with them, that is part of the finding and must be visible.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export LIBGL_ALWAYS_SOFTWARE=1

say "  launching under dbus-run-session + xvfb-run…"
setsid dbus-run-session -- xvfb-run -a "$BIN" >"$LOG" 2>&1 &
PGID=$!
sleep "$ALIVE_FOR"

ALIVE=no
kill -0 "$PGID" 2>/dev/null && ALIVE=yes
# Kill the process group, not the pid: xvfb-run and dbus-run-session are wrappers, and killing
# the pid alone leaves the application running — a mistake this repository has made before.
kill -- "-$PGID" 2>/dev/null
sleep 1
kill -9 -- "-$PGID" 2>/dev/null

PANICKED=no
grep -qi 'panicked' "$LOG" && PANICKED=yes
LINES=$(wc -l < "$LOG")
SETUP=no
grep -q 'Application setup complete' "$LOG" && SETUP=yes

say ""
say "  alive after ${ALIVE_FOR}s        $ALIVE"
say "  'Application setup complete'  $SETUP"
say "  panicked                      $PANICKED"
say "  stdout lines                  $LINES"
say ""
say "--- first 40 lines of stdout ---"
head -40 "$LOG" || true
say "--- end ---"

if [ "$ALIVE" = yes ] && [ "$PANICKED" = no ] && [ "$SETUP" = yes ]; then
  verdict "REACHED — the application starts headless and survives ${ALIVE_FOR}s. #67 condition 1 is buildable."
elif [ "$ALIVE" = yes ]; then
  verdict "PARTIAL — the process survives but did not report setup complete (or panicked). Read the log above."
else
  verdict "NOT REACHED — the process did not survive ${ALIVE_FOR}s. #67 condition 1 rests on this and must be rewritten."
fi
exit 0

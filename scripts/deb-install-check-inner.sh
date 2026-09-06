#!/usr/bin/env bash
# Runs inside the clean container. Kept separate so the outer script stays readable and so this
# half can be run by hand against any image.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
ALIVE_FOR=${ALIVE_FOR:-20}

echo "  container: $(. /etc/os-release && echo "$PRETTY_NAME")"
apt-get update -qq

# Only what a user would have: the tools to install a .deb and to run a GUI headlessly. Not the
# build dependencies — installing those would restore exactly the blindness this check exists to
# remove.
apt-get install -y -qq --no-install-recommends xvfb dbus-x11 ca-certificates >/dev/null

echo ""
echo "  installing the package…"
apt-get install -y ./tmp/app.deb 2>&1 | tail -20 || {
  echo "FAILED: apt-get install could not satisfy the package's dependencies" >&2
  exit 1
}

BIN=$(command -v conversationaly || echo /usr/bin/conversationaly)
[ -x "$BIN" ] || { echo "FAILED: the package installed but $BIN is not executable" >&2; exit 1; }

echo ""
echo "  launching for ${ALIVE_FOR}s…"
export HOME=/tmp/probe-home
mkdir -p "$HOME"
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1

LOG=/tmp/app.log
setsid dbus-run-session -- xvfb-run -a "$BIN" >"$LOG" 2>&1 &
PGID=$!
sleep "$ALIVE_FOR"

ALIVE=no; kill -0 "$PGID" 2>/dev/null && ALIVE=yes
kill -- "-$PGID" 2>/dev/null || true
sleep 1; kill -9 -- "-$PGID" 2>/dev/null || true

echo "--- stdout ---"; head -30 "$LOG" || true; echo "--- end ---"

# Three signals, not one. `Application setup complete` is logged at lib.rs:461 while the database
# initialisation that can panic is at lib.rs:533-535 — an application broken in exactly #68's way
# prints the line and then dies. So: the line, no panic, and still running.
grep -q 'Application setup complete' "$LOG" || {
  echo "FAILED: the application never reported setup complete" >&2; exit 1; }
grep -qi 'panicked' "$LOG" && { echo "FAILED: the application panicked" >&2; exit 1; }
[ "$ALIVE" = yes ] || { echo "FAILED: the application did not survive ${ALIVE_FOR}s" >&2; exit 1; }

echo "  install-and-launch: ok"

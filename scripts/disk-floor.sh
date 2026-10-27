#!/usr/bin/env bash
# The gate refuses to run this machine out of disk (#248).
#
# The machine the gate runs on is also where the product owner records their meetings. On
# 2026-10-27 kept Stage 2 profiles and build caches had filled it to 99%, 6.4 GB free, the morning
# of a meeting. A pass that runs out of disk fails as something else, so this check runs first:
# Stage 1's second entry, Stage 2's fourth (after the AppImage build, which keeps entry 3), and in
# front of every Stage 1 entry that runs cargo, because the runner runs every entry whatever the
# last one returned.
#
#   disk-floor.sh            the full check: on failure, what is taking the space
#   disk-floor.sh --brief    one line, for the prefix in front of a cargo entry
#
# Inputs, so tests can point it at fixtures: BC_DISK_FLOOR_GB (the floor, in decimal GB; default in
# scripts/lib/disk-floor-default.sh) and
# BC_DISK_FLOOR_LIST (the directory whose largest entries a failure names; default /tmp). It is not
# in test.yml: CI runners have their own disk, and environment-record.sh must always exit 0
# (ADR 0019).
set -uo pipefail

BRIEF=""; [ "${1:-}" = "--brief" ] && BRIEF=1
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/disk-floor-default.sh"
FLOOR_GB=${BC_DISK_FLOOR_GB:-$DISK_FLOOR_DEFAULT_GB}
LIST=${BC_DISK_FLOOR_LIST:-/tmp}
FLOOR=$((FLOOR_GB * 1000000000))
say() { printf 'disk-floor: %s\n' "$*" >&2; }

# The recording folder is the application's own: `preferences.save_folder` in its store, else the
# Linux default from recording_preferences.rs.
recording_folder() {
  local prefs="${XDG_DATA_HOME:-$HOME/.local/share}/tech.madduck.backchannel/recording_preferences.json" f="" docs
  [ -f "$prefs" ] && f=$(python3 -I -c 'import json,sys; print((json.load(open(sys.argv[1])).get("preferences") or {}).get("save_folder") or "")' "$prefs" 2>/dev/null)
  # The default mirrors get_default_recordings_folder(): dirs::document_dir(), the XDG documents
  # folder from user-dirs.dirs (a localized desktop names it in its own language), else the home
  # directory itself (recordings_dir_fallback).
  docs=$(sed -n 's/^XDG_DOCUMENTS_DIR="\(.*\)"$/\1/p' "${XDG_CONFIG_HOME:-$HOME/.config}/user-dirs.dirs" 2>/dev/null | head -1)
  docs=${docs//\$HOME/$HOME}
  [ -n "$docs" ] && [ "${docs%/}" != "$HOME" ] || docs=$HOME
  printf '%s\n' "${f:-${docs%/}/backchannel-recordings}"
}

# A path that does not exist yet (a fresh checkout's target/, a cache not filled, a recording
# folder never used) is judged on its nearest existing parent; df exits 1 on a missing path.
existing() { local p=$1; while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname -- "$p"); done; printf '%s\n' "$p"; }

TOP=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PATHS=("/tmp" "$TOP/target" "$(recording_folder)")
# Every seed cache, or ~/.cache itself while there is none.
for c in "$HOME"/.cache/backchannel-*; do [ -e "$c" ] && PATHS+=("$c"); done
[ ${#PATHS[@]} -gt 3 ] || PATHS+=("$HOME/.cache/backchannel-")
short=""; worst=""
for p in "${PATHS[@]}"; do
  e=$(existing "$p")
  avail=$(df --output=avail -B1 -- "$e" 2>/dev/null | tail -n +2 | tr -d ' ')
  # Fail closed: a free space that cannot be read is not enough.
  if ! [ "$avail" -eq "$avail" ] 2>/dev/null; then
    say "cannot read the free space of $p (checked at $e); refusing rather than assuming"
    exit 1
  fi
  if [ "$avail" -lt "$FLOOR" ]; then short="$short $p"; worst="$p has $((avail / 1000000000)) GB free"; fi
done

if [ -z "$short" ]; then
  [ -n "$BRIEF" ] || say "every filesystem the gate writes has at least $FLOOR_GB GB free"
  exit 0
fi

if [ -n "$BRIEF" ]; then
  say "below the $FLOOR_GB GB floor:$short; run scripts/disk-floor.sh for what is taking the space"
  exit 1
fi

say "below the $FLOOR_GB GB floor:$short ($worst)"
say "the ten largest entries under $LIST that you own:"
find "$LIST" -mindepth 1 -maxdepth 1 -user "$(id -u)" -print0 2>/dev/null \
  | xargs -0 -r du -sxB1 -- 2>/dev/null | sort -rn | head -10 \
  | awk '{ printf "disk-floor:   %6.1f GB  %s\n", $1 / 1e9, $2 }' >&2
say "build caches, each target/ once:"
git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r w; do
  [ -e "$w/target" ] && readlink -f -- "$w/target"
done | sort -u | while IFS= read -r t; do
  printf 'disk-floor:   %6.1f GB  %s\n' "$(du -sxB1 -- "$t" 2>/dev/null | cut -f1 | awk '{print $1 / 1e9}')" "$t" >&2
done
say "safe to delete, at the cost of a slower next build: target/*/incremental, target/release, and a shared worktree target/"
exit 1

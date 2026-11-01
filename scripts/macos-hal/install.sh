#!/usr/bin/env bash
# Install a Backchannel HAL plug-in on the development Mac and record what changed (#316, A1).
#
#   scripts/macos-hal/install.sh <path/to/X.driver>
#
# Run by the product owner in a terminal: it asks for the administrator password twice, for the
# copy and for restarting coreaudiod, which interrupts all audio for a few seconds. Never during a
# call. The census is taken as the user before and after, and compared; the run's files land in
# experiments/hal-runs/<time>-install/.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
DRIVER=${1:?path to the .driver bundle}
# Without its trailing slash: BSD `cp -R dir/ dst` copies the directory's contents, which would
# spill Contents/ into HAL/ where no removal globs it (the gate on #316).
DRIVER=${DRIVER%/}
[ -d "$DRIVER" ] || { echo "no such bundle: $DRIVER" >&2; exit 1; }
NAME=$(basename "$DRIVER")
case "$NAME" in Backchannel*.driver) ;; *) echo "refusing to install $NAME: only Backchannel*.driver" >&2; exit 1 ;; esac
RUN=$REPO/experiments/hal-runs/$(date +%Y%m%d-%H%M%S)-install; mkdir -p "$RUN"
codesign -dv "$DRIVER" > "$RUN/codesign.txt" 2>&1 || true
HELPER_ARG=(); [ -z "${BC_HELPER:-}" ] || HELPER_ARG=(--helper "$BC_HELPER")
python3 -I "$HERE/census.py" take ${HELPER_ARG[@]+"${HELPER_ARG[@]}"} > "$RUN/before.json"
echo "installing $NAME (administrator password needed)"
# Replace a bundle of the same name rather than merge into it (the name is checked above).
sudo rm -rf "/Library/Audio/Plug-Ins/HAL/$NAME"
sudo cp -R "$DRIVER" "/Library/Audio/Plug-Ins/HAL/$NAME"
START=$(date "+%Y-%m-%d %H:%M:%S")
echo "restarting coreaudiod (audio stops for a few seconds)"
sudo killall coreaudiod   # launchd restarts it; `launchctl kickstart` is refused under SIP (error 150, #316)
sleep 6
python3 -I "$HERE/census.py" take ${HELPER_ARG[@]+"${HELPER_ARG[@]}"} > "$RUN/after.json"
log show --start "$START" --style compact --predicate "eventMessage CONTAINS[c] \"${NAME%.driver}\" OR eventMessage CONTAINS[c] \"backchannel\"" > "$RUN/log.txt" 2>/dev/null || true
set +e
python3 -I "$HERE/census.py" compare "$RUN/before.json" "$RUN/after.json" --expect-added Backchannel tech.madduck.backchannel > "$RUN/compare.json"
rc=$?
cat "$RUN/compare.json"
echo "files: $RUN"
exit $rc

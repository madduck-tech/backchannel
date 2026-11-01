#!/usr/bin/env bash
# Remove every Backchannel HAL plug-in and record what changed (#316, A11).
#
#   scripts/macos-hal/remove.sh <before-install census.json>
#
# Run by the product owner (administrator password). Compares against the census taken before the
# install: the only difference allowed is coreaudiod's UID-keyed residue in DeviceSettings.plist for
# Backchannel UIDs. TCC is reset only for a bundled helper, by its bundle id, never globally.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
BEFORE=${1:?census taken before the install}
RUN=$REPO/experiments/hal-runs/$(date +%Y%m%d-%H%M%S)-remove; mkdir -p "$RUN"
cp "$BEFORE" "$RUN/before-install.json"
shopt -s nullglob
bundles=(/Library/Audio/Plug-Ins/HAL/Backchannel*.driver)
echo "removing: ${bundles[*]:-none} (administrator password needed)"
[ ${#bundles[@]} -eq 0 ] || sudo rm -rf "${bundles[@]}"
for plist in "$HOME"/Library/LaunchAgents/tech.madduck.backchannel.*.plist; do
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
done
# A failed reset is reported, not fatal: coreaudiod must still be restarted below.
[ -z "${BC_HELPER_BUNDLE_ID:-}" ] || tccutil reset Microphone "$BC_HELPER_BUNDLE_ID" || echo "tccutil reset failed" >&2
sudo killall coreaudiod   # launchd restarts it; `launchctl kickstart` is refused under SIP (error 150, #316)
sleep 6
HELPER_ARG=(); [ -z "${BC_HELPER:-}" ] || HELPER_ARG=(--helper "$BC_HELPER")
python3 -I "$HERE/census.py" take ${HELPER_ARG[@]+"${HELPER_ARG[@]}"} > "$RUN/after.json"
set +e
python3 -I "$HERE/census.py" compare "$RUN/before-install.json" "$RUN/after.json" \
  --allow-residue-uid tech.madduck.backchannel.microphone tech.madduck.backchannel.speakers \
                      tech.madduck.backchannel.bridge-in tech.madduck.backchannel.bridge-out > "$RUN/compare.json"
rc=$?
cat "$RUN/compare.json"
echo "files: $RUN"
exit $rc

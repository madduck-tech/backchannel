#!/usr/bin/env bash
# Last resort when audio is broken after an install (#316): removes every Backchannel plug-in and
# LaunchAgent and restarts coreaudiod. Depends on nothing but the shell; no census, no audio.
#
#   scripts/macos-hal/recover.sh
set -u
sudo rm -rf /Library/Audio/Plug-Ins/HAL/Backchannel*.driver
for plist in "$HOME"/Library/LaunchAgents/tech.madduck.backchannel.*.plist; do
  [ -e "$plist" ] || continue
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null; rm -f "$plist"
done
sudo killall coreaudiod   # launchd restarts it; `launchctl kickstart` is refused under SIP (error 150, #316)
echo "removed Backchannel plug-ins and agents; coreaudiod restarted"

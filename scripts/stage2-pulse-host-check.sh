#!/usr/bin/env bash
# The audio host authenticates with no PulseAudio cookie anywhere it looks. (#243, ADR 0034)
#
#   stage2-pulse-host-check.sh <stage 2 root>
#
# Reads the app Stage 2 entry 6 launched: its pid, its fresh home and its log. It passes only when
# the first `Audio host selected for this process:` line reads PulseAudio, and the run had no cookie
# to send: no PULSE_COOKIE in the process's environment, which the gate passes through from the
# shell, and no cookie file in its home. Until ADR 0034 the client sent an empty cookie when it found
# none, PipeWire refused it, and the CI-built AppImage fell back to ALSA.
#
# On this machine a local build escaped by accident: GTK loads libcanberra, whose libpulse writes a
# cookie into the fresh home before the app builds its host. Entry 5 therefore makes
# $S2/home/.config/pulse unwritable, so that no cookie can appear and a local build is judged as a
# CI build would be. A cookie found there anyway means this run cannot judge, and fails.
set -uo pipefail
say() { printf 'pulse-host: %s\n' "$*" >&2; }
S2=${1:?usage: stage2-pulse-host-check.sh <stage 2 root>}
PID=$(cat "$S2/pid" 2>/dev/null) || { say "no pid file under $S2"; exit 1; }
[ -r "/proc/$PID/environ" ] || { say "process $PID is not running, so there is nothing to read"; exit 1; }
ENV=$(tr '\0' '\n' < "/proc/$PID/environ")
if printf '%s\n' "$ENV" | grep -q '^PULSE_COOKIE='; then
  say "the launched process carries PULSE_COOKIE, so this run cannot show the app authenticating with no cookie; unset it in the shell that runs the gate"
  exit 1
fi
# The places the client reads, from the process's own environment, not from where the launch is
# meant to have put them: a launch that drifted from entry 6 would otherwise pass on paths nobody read.
P_HOME=$(printf '%s\n' "$ENV" | sed -n 's/^HOME=//p' | head -1)
P_XDG=$(printf '%s\n' "$ENV" | sed -n 's/^XDG_CONFIG_HOME=//p' | head -1)
[ -n "$P_HOME" ] || { say "the launched process has no HOME"; exit 1; }
for c in "${P_XDG:-$P_HOME/.config}/pulse/cookie" "$P_HOME/.config/pulse/cookie" "$P_HOME/.pulse-cookie"; do
  [ -e "$c" ] && { say "$c exists, so this run had a cookie and cannot judge"; exit 1; }
done
line=$(grep -m1 'Audio host selected for this process:' "$S2/stdout.log" 2>/dev/null) || { say "the app logged no host selection line"; exit 1; }
case "$line" in
  *PulseAudio*) say "with no cookie anywhere: Audio host${line##*Audio host}"; exit 0 ;;
  *) say "with no cookie anywhere, the first host line reads: Audio host${line##*Audio host}"
     grep -m1 'PulseAudio is unavailable' "$S2/stdout.log" >&2
     exit 1 ;;
esac

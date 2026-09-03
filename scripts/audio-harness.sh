#!/usr/bin/env bash
#
# A virtual audio device for Stage 2, so the gate can verify audio flows instead of
# declaring them not proven.
#
#   scripts/audio-harness.sh up [--sample PATH] [--system-home DIR] [--system-only]
#   scripts/audio-harness.sh down                 restore the machine and remove it
#   scripts/audio-harness.sh status               what is up right now
#
# `up` creates a PipeWire sink whose output is a virtual source, makes that source the
# default input, and loops a recording into the sink. Anything recording from the system
# default — which is what this application does when no microphone preference is stored —
# then hears the recording.
#
# `--system-home DIR` additionally builds the *system audio* side: a second sink/source
# pair, plus an ALSA PCM written into DIR/.asoundrc whose hint description contains
# "monitor", because that substring is what configure_linux_audio scans for. The device is
# then reachable as a stored `preferred_system_device`, which is printed on success. This
# does not need libpulse and does not need the application changed — ADR 0005's finding
# that no monitor devices exist is about the *unconfigured* machine.
#
# `--system-only` leaves the default input alone, so the microphone stays on the real
# device. That is what makes a transcript attributable: with the machine's own microphone
# delivering silence, anything transcribed can only have come through system audio.
#
# Two things this script exists to get right, both learned the hard way:
#
#   * It refuses to run twice. `pw-loopback` will happily create a second pair of nodes
#     with the same names, after which selecting one by name is a coin flip.
#   * It restores the default input from a file written at `up`, never from memory, and it
#     checks WirePlumber's *persisted* state as well as the live graph. `set-default`
#     writes into ~/.local/state/wireplumber/default-nodes, where a stale entry survives a
#     teardown that looks clean and survives a reboot.
#
# It needs a live PipeWire session, so it does not run in CI. That is why the audio half
# of the gate is local-only; see gopnik.json.

set -euo pipefail

SINK_NAME="backchannel_harness_sink"
SRC_NAME="backchannel_harness_src"
SYS_SINK_NAME="backchannel_harness_sysout"
SYS_SRC_NAME="backchannel_harness_sysmon"
# The description is what matters, not the PCM name: the application finds system audio by
# scanning ALSA input descriptions for "monitor".
SYS_PCM_DESC="backchannel harness system monitor capture"
STATE_DIR="$(git rev-parse --git-dir 2>/dev/null || echo .)/backchannel-audio-harness"
WP_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wireplumber/default-nodes"

DEFAULT_SAMPLE_GLOB="$HOME/.cargo/git/checkouts/transcribe.cpp-*/*/samples/jfk.wav"

die() { printf 'audio-harness: %s\n' "$*" >&2; exit 1; }
note() { printf 'audio-harness: %s\n' "$*"; }

require_tools() {
  for t in pw-cli pw-cat pw-loopback pw-metadata pw-dump; do
    command -v "$t" >/dev/null || die "missing $t — install pipewire's client tools"
  done
}

# Nodes matching one of our names, as "id name" lines.
harness_nodes() {
  pw-dump 2>/dev/null | python3 -c '
import json, sys
try:
    dump = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for obj in dump:
    if not str(obj.get("type", "")).endswith("Node"):
        continue
    props = (obj.get("info") or {}).get("props") or {}
    name = props.get("node.name", "")
    if name in sys.argv[1:]:
        print(obj["id"], name)
' "$SINK_NAME" "$SRC_NAME" "$SYS_SINK_NAME" "$SYS_SRC_NAME"
}

current_default_source() {
  pw-metadata -n default 2>/dev/null \
    | sed -n "s/.*key:'default.configured.audio.source' value:'\(.*\)' type:.*/\1/p" \
    | tail -1
}

# Measure what a source is actually delivering. A harness that comes up and feeds silence
# passes every liveness check and fails the only one that matters, so this gates `up`.
probe_level() {
  local node="$1" probe="$STATE_DIR/probe-$1.wav" peak
  timeout 5 pw-cat -r --target "$node" "$probe" >/dev/null 2>&1 || true
  if ! command -v ffmpeg >/dev/null || [ ! -s "$probe" ]; then
    rm -f "$probe"; echo "unverified"; return 0
  fi
  peak="$(ffmpeg -hide_banner -nostats -i "$probe" -af volumedetect -f null - 2>&1 \
          | sed -n 's/.*max_volume: \(-\?[0-9.]*\) dB.*/\1/p' | tail -1)"
  rm -f "$probe"
  [ -n "$peak" ] || { echo "unmeasurable"; return 0; }
  awk -v p="$peak" 'BEGIN { exit !(p > -60) }' || { echo "silent:$peak"; return 0; }
  echo "$peak"
}

cmd_status() {
  local nodes; nodes="$(harness_nodes || true)"
  if [ -n "$nodes" ]; then
    note "up — nodes:"
    printf '%s\n' "$nodes" | while read -r line; do printf '  %s\n' "$line"; done
  else
    note "down — no harness nodes"
  fi
  note "default input: $(current_default_source)"
  [ -d "$STATE_DIR" ] && note "state kept in $STATE_DIR"
  return 0
}

cmd_up() {
  local sample="" system_home="" system_only=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --sample) sample="${2:-}"; shift 2 ;;
      --system-home) system_home="${2:-}"; shift 2 ;;
      --system-only) system_only=1; shift ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  require_tools

  # Refuse rather than duplicate. Two nodes with one name is worse than no harness,
  # because everything downstream still looks like it worked.
  if [ -n "$(harness_nodes || true)" ]; then
    die "already up — run 'down' first (running twice creates duplicate nodes with the same name)"
  fi
  [ -e "$STATE_DIR/loopback.pid" ] && die "stale state in $STATE_DIR — run 'down' first"

  if [ -z "$sample" ]; then
    # shellcheck disable=SC2086
    sample="$(ls -1 $DEFAULT_SAMPLE_GLOB 2>/dev/null | head -1 || true)"
    [ -n "$sample" ] || die "no sample given and none found at $DEFAULT_SAMPLE_GLOB — pass --sample PATH"
  fi
  [ -r "$sample" ] || die "sample not readable: $sample"

  # From here on the machine is being changed, so any failure has to put it back.
  # Without this, a refusal — the silence check below, most likely — leaves the
  # developer's default input pointing at a harness node and then removes it.
  mkdir -p "$STATE_DIR"
  UP_COMPLETED=0
  trap 'if [ "$UP_COMPLETED" != 1 ]; then note "bringing the machine back after a failed up"; cmd_down >/dev/null 2>&1 || true; fi' EXIT
  current_default_source > "$STATE_DIR/original-default-source"
  [ -s "$STATE_DIR/original-default-source" ] || die "could not read the current default input; refusing to change it"
  cp -f "$WP_STATE" "$STATE_DIR/wireplumber-default-nodes.before" 2>/dev/null || : > "$STATE_DIR/wireplumber-default-nodes.before"
  printf '%s\n' "$sample" > "$STATE_DIR/sample"

  # media.class must be Audio/Source: WirePlumber refuses to make an Audio/Source/Virtual
  # the default ("is not a device node"), and writing the metadata by hand is accepted and
  # then silently never applied.
  setsid pw-loopback \
    --capture-props="media.class=Audio/Sink node.name=$SINK_NAME node.description=Backchannel harness sink" \
    --playback-props="media.class=Audio/Source node.name=$SRC_NAME node.description=Backchannel harness microphone" \
    >"$STATE_DIR/loopback.log" 2>&1 &
  echo $! > "$STATE_DIR/loopback.pid"

  local waited=0
  until [ -n "$(harness_nodes || true)" ]; do
    waited=$((waited + 1)); [ "$waited" -gt 50 ] && die "loopback did not appear; see $STATE_DIR/loopback.log"
    sleep 0.2
  done

  if [ "$system_only" -eq 0 ]; then
    pw-metadata -n default 0 default.configured.audio.source "{\"name\":\"$SRC_NAME\"}" >/dev/null
    sleep 1
    [ "$(current_default_source)" = "{\"name\":\"$SRC_NAME\"}" ] || die "the harness source did not become the default input"
  else
    note "--system-only: leaving the default input on $(current_default_source)"
  fi

  setsid bash -c "while true; do pw-cat -p --target '$SINK_NAME' '$sample' >/dev/null 2>&1 || sleep 1; done" \
    >/dev/null 2>&1 &
  echo $! > "$STATE_DIR/player.pid"

  local level; level="$(probe_level "$SRC_NAME")"
  case "$level" in
    silent:*) die "the microphone source is delivering silence (max_volume ${level#silent:} dB) — check the sample and the sink" ;;
    unverified|unmeasurable) note "microphone source level $level (ffmpeg missing or probe empty)" ;;
    *) note "microphone source delivering ${level} dB peak from $(basename "$sample")" ;;
  esac

  if [ -n "$system_home" ]; then
    mkdir -p "$system_home"
    setsid pw-loopback \
      --capture-props="media.class=Audio/Sink node.name=$SYS_SINK_NAME node.description=Backchannel harness system output" \
      --playback-props="media.class=Audio/Source node.name=$SYS_SRC_NAME node.description=Backchannel harness system monitor" \
      >"$STATE_DIR/loopback-system.log" 2>&1 &
    echo $! > "$STATE_DIR/loopback-system.pid"

    waited=0
    # Not `pw-dump | grep -q`: grep -q closes the pipe on its first match, pw-dump takes
    # SIGPIPE, and `set -o pipefail` then reports the pipeline as failed — so the wait
    # would spin exactly when the node had appeared. grep without -q drains its input.
    until [ -n "$(harness_nodes 2>/dev/null | grep "$SYS_SRC_NAME" || true)" ]; do
      waited=$((waited + 1))
      if [ "$waited" -gt 50 ]; then
        # The teardown removes the state directory, so quote the log here rather than
        # pointing at a file that will not exist by the time anyone looks.
        note "system loopback log:"; sed 's/^/    /' "$STATE_DIR/loopback-system.log" 2>/dev/null || true
        die "the system loopback did not appear after 10s"
      fi
      sleep 0.2
    done

    cat > "$system_home/.asoundrc" <<ASOUNDRC
pcm.backchannel_harness_sysmon_capture {
    type pipewire
    playback_node "-1"
    capture_node "$SYS_SRC_NAME"
    hint { show on
           description "$SYS_PCM_DESC" }
}
ASOUNDRC
    printf '%s\n' "$system_home" > "$STATE_DIR/system-home"

    setsid bash -c "while true; do pw-cat -p --target '$SYS_SINK_NAME' '$sample' >/dev/null 2>&1 || sleep 1; done" \
      >/dev/null 2>&1 &
    echo $! > "$STATE_DIR/player-system.pid"

    sleep 1
    local syslevel; syslevel="$(probe_level "$SYS_SRC_NAME")"
    case "$syslevel" in
      silent:*) die "the system-audio source is delivering silence (max_volume ${syslevel#silent:} dB)" ;;
      unverified|unmeasurable) note "system-audio source level $syslevel" ;;
      *) note "system-audio source delivering ${syslevel} dB peak" ;;
    esac
    note "system audio: PCM written to $system_home/.asoundrc"
    note "  set preferred_system_device to: \"$SYS_PCM_DESC (output)\""
  fi

  if [ "$system_only" -eq 0 ]; then
    note "up — '$SRC_NAME' is the default input"
  else
    note "up — system audio only; the default input is untouched"
  fi
  UP_COMPLETED=1
}

cmd_down() {
  require_tools
  if [ ! -d "$STATE_DIR" ]; then
    note "nothing to do — no state directory"
    [ -n "$(harness_nodes || true)" ] && die "harness nodes exist but no state was saved; remove them by hand"
    return 0
  fi

  for f in player player-system; do
    [ -f "$STATE_DIR/$f.pid" ] && kill "$(cat "$STATE_DIR/$f.pid")" 2>/dev/null || true
  done
  pkill -f "pw-cat -p --target $SINK_NAME" 2>/dev/null || true
  pkill -f "pw-cat -p --target $SYS_SINK_NAME" 2>/dev/null || true

  if [ -s "$STATE_DIR/original-default-source" ]; then
    pw-metadata -n default 0 default.configured.audio.source "$(cat "$STATE_DIR/original-default-source")" >/dev/null || true
  fi

  for f in loopback loopback-system; do
    [ -f "$STATE_DIR/$f.pid" ] && kill "$(cat "$STATE_DIR/$f.pid")" 2>/dev/null || true
  done
  pkill -f "pw-loopback.*$SRC_NAME" 2>/dev/null || true
  pkill -f "pw-loopback.*$SYS_SRC_NAME" 2>/dev/null || true
  if [ -s "$STATE_DIR/system-home" ]; then
    rm -f "$(cat "$STATE_DIR/system-home")/.asoundrc"
  fi
  sleep 1

  local left; left="$(harness_nodes || true)"
  [ -n "$left" ] && die "nodes still present after teardown: $left"

  local restored; restored="$(current_default_source)"
  local wanted; wanted="$(cat "$STATE_DIR/original-default-source" 2>/dev/null || true)"
  [ "$restored" = "$wanted" ] || note "WARNING: default input is $restored, expected $wanted"

  # The live graph can look clean while WirePlumber's persisted list still names the
  # harness. That entry is inert history, but it survives a reboot, so say so rather than
  # leave it to be found.
  if [ -f "$WP_STATE" ] && grep -q "$SRC_NAME" "$WP_STATE" 2>/dev/null; then
    note "residue: $WP_STATE still lists $SRC_NAME in its fallback history."
    note "  It is inert — the active default is restored — and removing it needs"
    note "  'systemctl --user stop wireplumber', an edit, then 'start'."
  fi

  rm -rf "$STATE_DIR"
  note "down — default input restored to $restored"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "usage: $0 up [--sample PATH] | down | status" ;;
esac

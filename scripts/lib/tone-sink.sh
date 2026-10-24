# A silent sink for the audio check's tone. Sourced by `stage2-core-check.sh`. (#168, #173)
#
# The system row plays a 440 Hz tone through the machine's **default output** and listens on that
# output's monitor. Pressed with the person's own default, the tone sounds in their speakers or
# headphones; on 2026-10-24 the default was a Bluetooth headset. So for the length of one press the
# default output is this null sink, which nothing else plays into, and the row listens on its monitor.
#
# The sink is created before the application starts, so the device list the audio check enumerates
# contains its monitor. The default is moved only around the press.
#
# **What a killed run leaves behind is the next run's problem, so it is written down.** The sink is
# created with `object.linger=true` and outlives the shell. Before #173's adversary, the original
# default lived only in a shell variable. A SIGKILL mid-press therefore left the person's default on a
# null sink, so their audio went silent. The next run then read that sink as "the original", made a
# second node with the same name, and "restored" to it. So now:
#
#   - the original default is written to `$TONE_STATE_DIR` before the move, and removed only once
#     the restore has taken effect;
#   - a run refuses to start while that file exists, while a node of this name is in the graph, or
#     while the configured default already names it;
#   - `bash scripts/lib/tone-sink.sh restore` puts the machine back from the file.
#
# This is the same guard `audio-harness.sh` keeps for its source. WirePlumber may keep the sink's name
# in its persisted fallback history; that entry is inert once the sink is gone.

TONE_SINK_NAME=backchannel_tone_sink
TONE_STATE_DIR="$(git rev-parse --git-dir 2>/dev/null || echo .)/backchannel-tone-sink"
TONE_SINK_ID=""
TONE_SINK_DEFAULTED=""

tone_sink_configured() {
  pw-metadata -n default 0 default.configured.audio.sink 2>/dev/null \
    | sed -n "s/.*key:'default.configured.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

tone_sink_effective() {
  pw-metadata -n default 0 default.audio.sink 2>/dev/null \
    | sed -n "s/.*key:'default.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

# The ids of every node with the sink's name, one per line.
tone_sink_nodes() {
  pw-dump | python3 -c '
import json, sys
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("node.name") == sys.argv[1]:
        print(o["id"])
' "$TONE_SINK_NAME"
}

tone_sink_create() {
  local stale
  [ -e "$TONE_STATE_DIR/original-default-sink" ] \
    && die "harness: a tone press was interrupted and the default output was never put back ($TONE_STATE_DIR); run 'bash scripts/lib/tone-sink.sh restore' first"
  stale=$(tone_sink_nodes | tr '\n' ' ')
  [ -z "$stale" ] || die "harness: a tone sink is already in the graph (node ${stale% }); run 'bash scripts/lib/tone-sink.sh restore' first, rather than make a second node with the same name"
  case "$(tone_sink_configured)" in
    *"\"$TONE_SINK_NAME\""*) die "harness: the configured default output is already the tone sink; run 'bash scripts/lib/tone-sink.sh restore' first" ;;
  esac
  pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$TONE_SINK_NAME node.description=\"Backchannel tone sink\" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }" >/dev/null \
    || die "harness: could not create the tone sink"
  local n
  for n in $(seq 1 25); do
    TONE_SINK_ID=$(tone_sink_nodes | head -1)
    [ -n "$TONE_SINK_ID" ] && return 0
    sleep 0.2
  done
  die "harness: the tone sink never appeared in the graph"
}

tone_sink_make_default() {
  local orig
  orig=$(tone_sink_configured)
  [ -n "$orig" ] || die "harness: could not read the configured default output; refusing to change it"
  case "$orig" in *"\"$TONE_SINK_NAME\""*) die "harness: the configured default output is already the tone sink; refusing to record it as the original" ;; esac
  mkdir -p "$TONE_STATE_DIR"
  printf '%s\n' "$orig" > "$TONE_STATE_DIR/original-default-sink"
  [ "$(cat "$TONE_STATE_DIR/original-default-sink")" = "$orig" ] || die "harness: could not keep the original default output in $TONE_STATE_DIR; refusing to change it"
  pw-metadata -n default 0 default.configured.audio.sink "{\"name\":\"$TONE_SINK_NAME\"}" >/dev/null
  TONE_SINK_DEFAULTED=1
  local n
  for n in $(seq 1 25); do
    [ "$(tone_sink_effective)" = "{\"name\":\"$TONE_SINK_NAME\"}" ] && { say "the default output is the tone sink for this press (was $orig)"; return 0; }
    sleep 0.2
  done
  die "harness: the tone sink did not become the default output; it is $(tone_sink_effective)"
}

# Puts the configured default back from the file, and removes the file only once the write took
# effect. Returns non-zero, and keeps the file, when it did not.
tone_sink_restore() {
  [ -e "$TONE_STATE_DIR/original-default-sink" ] || { TONE_SINK_DEFAULTED=""; return 0; }
  local orig n
  orig=$(cat "$TONE_STATE_DIR/original-default-sink")
  pw-metadata -n default 0 default.configured.audio.sink "$orig" >/dev/null
  for n in $(seq 1 25); do
    if [ "$(tone_sink_configured)" = "$orig" ]; then
      rm -f "$TONE_STATE_DIR/original-default-sink"
      rmdir "$TONE_STATE_DIR" 2>/dev/null
      TONE_SINK_DEFAULTED=""
      say "the default output is back to $orig"
      return 0
    fi
    sleep 0.2
  done
  say "the default output could NOT be put back to $orig (it reads $(tone_sink_configured)); kept in $TONE_STATE_DIR"
  return 1
}

tone_sink_destroy() {
  tone_sink_restore
  local id
  for id in $(tone_sink_nodes); do pw-cli destroy "$id" >/dev/null 2>&1; done
  TONE_SINK_ID=""
}

# Run directly, it repairs what an interrupted run left: `bash scripts/lib/tone-sink.sh restore`.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  say() { printf 'tone-sink: %s\n' "$*"; }
  die() { printf 'tone-sink: %s\n' "$*" >&2; exit 1; }
  case "${1:-}" in
    restore) tone_sink_destroy || exit 1; [ -z "$(tone_sink_nodes)" ] || die "a tone sink is still in the graph"; say "no tone sink in the graph" ;;
    *) die "usage: bash scripts/lib/tone-sink.sh restore" ;;
  esac
fi

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
# created with `object.linger=true` and outlives the shell. #173's adversary found three ways this went
# wrong, each measured against PipeWire shims:
#
#   - With the original default held only in a shell variable, a SIGKILL mid-press left the person's
#     default on a null sink. The next run read that sink as "the original" and restored to it.
#   - A run that refused to start still restored in its EXIT trap. It overwrote an output the person
#     had chosen since, without a word, and destroyed nodes it had not made.
#   - `restore` exited 0 when its write had not taken effect.
#
# So:
#
#   - the original default is written to `$TONE_STATE_DIR` before the move, and removed only once the
#     restore has taken effect, or once the person has chosen another output themselves;
#   - a run refuses to start while that file exists, while a node of this name is in the graph, or
#     while the configured default already names it;
#   - a run's cleanup undoes only what that run did: the default it moved, the node it made;
#   - `bash scripts/lib/tone-sink.sh restore` repairs a killed run. It writes the original back only
#     while the configured default still names the tone sink, it fails when its write does not take
#     effect, and it fails when no file says what the original was, before destroying anything;
#   - the state lives in the repository's **common** git dir, found from this file's own location, so
#     every worktree and every working directory sees the same file.
#
# This is the same guard `audio-harness.sh` keeps for its source. WirePlumber may keep the sink's name
# in its persisted fallback history; that entry is inert once the sink is gone.

TONE_SINK_NAME=backchannel_tone_sink
TONE_GIT_DIR="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
TONE_STATE_DIR="${TONE_GIT_DIR:+$TONE_GIT_DIR/backchannel-tone-sink}"
TONE_SINK_ID=""          # the node this run made, if it made one
TONE_SINK_DEFAULTED=""   # set once this run has moved the default

tone_sink_configured() {
  pw-metadata -n default 0 default.configured.audio.sink 2>/dev/null \
    | sed -n "s/.*key:'default.configured.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

tone_sink_effective() {
  pw-metadata -n default 0 default.audio.sink 2>/dev/null \
    | sed -n "s/.*key:'default.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

tone_sink_names_it() { case "$1" in *"\"$TONE_SINK_NAME\""*) return 0 ;; *) return 1 ;; esac; }

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
  [ -n "$TONE_STATE_DIR" ] || die "harness: could not find the repository's git dir; refusing to change the default output without a place to keep it"
  [ -e "$TONE_STATE_DIR/original-default-sink" ] \
    && die "harness: a tone press was interrupted and the default output was never put back ($TONE_STATE_DIR); run 'bash scripts/lib/tone-sink.sh restore' first"
  stale=$(tone_sink_nodes | tr '\n' ' ')
  [ -z "$stale" ] || die "harness: a tone sink is already in the graph (node ${stale% }); run 'bash scripts/lib/tone-sink.sh restore' first, rather than make a second node with the same name"
  tone_sink_names_it "$(tone_sink_configured)" \
    && die "harness: the configured default output is already the tone sink; run 'bash scripts/lib/tone-sink.sh restore' first"
  pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$TONE_SINK_NAME node.description=\"Backchannel tone sink\" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }" >/dev/null \
    || die "harness: could not create the tone sink"
  local n
  for n in $(seq 1 25); do
    # No node of this name existed a moment ago, so the one there now is this run's.
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
  tone_sink_names_it "$orig" && die "harness: the configured default output is already the tone sink; refusing to record it as the original"
  mkdir -p "$TONE_STATE_DIR"
  printf '%s\n' "$orig" > "$TONE_STATE_DIR/original-default-sink"
  [ "$(cat "$TONE_STATE_DIR/original-default-sink")" = "$orig" ] || die "harness: could not keep the original default output in $TONE_STATE_DIR; refusing to change it"
  TONE_SINK_DEFAULTED=1
  pw-metadata -n default 0 default.configured.audio.sink "{\"name\":\"$TONE_SINK_NAME\"}" >/dev/null
  local n
  for n in $(seq 1 25); do
    [ "$(tone_sink_effective)" = "{\"name\":\"$TONE_SINK_NAME\"}" ] && { say "the default output is the tone sink for this press (was $orig)"; return 0; }
    sleep 0.2
  done
  die "harness: the tone sink did not become the default output; it is $(tone_sink_effective)"
}

# Puts the original default back from the file. Writes only while the configured default still names
# the tone sink: if it names something else, the person chose that since, and the file is dropped
# instead. Returns non-zero, and keeps the file, when the write did not take effect.
tone_sink_put_back() {
  local orig now n
  orig=$(cat "$TONE_STATE_DIR/original-default-sink")
  now=$(tone_sink_configured)
  if ! tone_sink_names_it "$now"; then
    rm -f "$TONE_STATE_DIR/original-default-sink"; rmdir "$TONE_STATE_DIR" 2>/dev/null
    say "the default output is ${now:-unset}, not the tone sink, so it is left alone (the original was $orig)"
    return 0
  fi
  pw-metadata -n default 0 default.configured.audio.sink "$orig" >/dev/null
  for n in $(seq 1 25); do
    if [ "$(tone_sink_configured)" = "$orig" ]; then
      rm -f "$TONE_STATE_DIR/original-default-sink"; rmdir "$TONE_STATE_DIR" 2>/dev/null
      say "the default output is back to $orig"
      return 0
    fi
    sleep 0.2
  done
  say "the default output could NOT be put back to $orig (it reads $(tone_sink_configured)); kept in $TONE_STATE_DIR"
  return 1
}

# This run's own move, undone. Nothing to do for a run that never moved the default.
tone_sink_restore() {
  [ -n "$TONE_SINK_DEFAULTED" ] || return 0
  tone_sink_put_back || return 1
  TONE_SINK_DEFAULTED=""
}

# The EXIT trap's half: this run's move and this run's node, nothing else. The node stays when the
# default could not be put back, so the person is not left with a configured default that names
# nothing; the next run refuses and points at `restore`.
tone_sink_destroy() {
  tone_sink_restore || return 1
  [ -n "$TONE_SINK_ID" ] && pw-cli destroy "$TONE_SINK_ID" >/dev/null 2>&1
  TONE_SINK_ID=""
  return 0
}

# Run directly, it repairs what an interrupted run left: `bash scripts/lib/tone-sink.sh restore`.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  say() { printf 'tone-sink: %s\n' "$*"; }
  die() { printf 'tone-sink: %s\n' "$*" >&2; exit 1; }
  case "${1:-}" in
    restore)
      [ -n "$TONE_STATE_DIR" ] || die "could not find the repository's git dir"
      if [ -e "$TONE_STATE_DIR/original-default-sink" ]; then
        tone_sink_put_back || die "the default output was not put back; nothing was destroyed"
      elif tone_sink_names_it "$(tone_sink_configured)"; then
        die "the configured default output is the tone sink and nothing records what it was before; choose your output in the sound settings, then run this again"
      fi
      for id in $(tone_sink_nodes); do pw-cli destroy "$id" >/dev/null 2>&1; done
      [ -z "$(tone_sink_nodes)" ] || die "a tone sink is still in the graph"
      say "no tone sink in the graph"
      ;;
    *) die "usage: bash scripts/lib/tone-sink.sh restore" ;;
  esac
fi

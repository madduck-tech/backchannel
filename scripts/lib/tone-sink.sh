# A silent sink for the audio check's tone. Sourced by `stage2-core-check.sh`. (#168, #173, #266)
#
# The system row plays a 440 Hz tone and listens on a monitor. Played through the person's own output, the
# tone sounds in their speakers or headphones; on 2026-10-24 the default was a Bluetooth headset. So the
# tone plays into this null sink, which nothing else plays into, and the row listens on its monitor.
#
# **The tone reaches the sink by name, and the default output is never moved (#266).** The driver launches
# the application with `PULSE_SINK="$TONE_SINK_NAME"`, which libpulse, and so GStreamer's `pulsesink`,
# reads, and with `GST_PLUGIN_FEATURE_RANK="$TONE_GST_PIN"`, which ranks every other audio sink out. Until
# #266 the default output was moved to this sink for each press, and WirePlumber's `follow` moved every
# stream without a target of its own into it with the default: a Chrome tab's audio, measured, went silent
# for 8 s each press.
#
# **A per-run name.** WirePlumber keeps a stack of previously configured defaults and, when the configured
# one is absent, makes a node whose name is on that stack the default, with no write at all. Moving the
# default had put `backchannel_tone_sink` there; on 2026-11-01, with the person's headset off, a node of
# that name was the effective default output 0.001 s after it was created, and stayed so for every read
# of 10 s. So each run's sink is `backchannel_tone_sink_<epoch>_<pid>`, a name no stack holds, and
# `tone_sink_create` still reads the effective default before and after the sink exists, and refuses the
# run if it moved.
#
# **What a killed run leaves behind is the next run's problem, so it is written down.** The sink is created
# with `object.linger=true` and outlives the shell. So:
#
#   - a run refuses to start while a node of the family is in the graph, the constant or any per-run name,
#     or while the configured default output names one;
#   - a run's cleanup destroys only the node it made, and only while its id still names it: PipeWire gives
#     a freed id to the next object;
#   - `bash scripts/lib/tone-sink.sh restore` destroys every node of the family;
#   - **legacy:** before #266, a run kept the original default output in `$TONE_STATE_DIR` while it had
#     moved it. A run still refuses while that file exists, and `restore` still puts that output back. The
#     state lives in the repository's **common** git dir, found from this file's own location, so every
#     worktree and every working directory sees the same file.
#
# Every read that cannot be taken fails closed: what cannot be read is never taken as an answer (#173's
# adversary, round 3).

TONE_SINK_FAMILY=backchannel_tone_sink
TONE_SINK_NAME="${TONE_SINK_FAMILY}_$(date +%s)_$$"
# Every GStreamer `Sink/Audio` factory ranked marginal or above in this machine's GStreamer 1.24.2, besides
# `pulsesink` (266): `alsasink` 256, `jackaudiosink` 256, `oss4sink` 129, `osssink` 128. `pipewiresink` is 0.
TONE_GST_PIN=alsasink:NONE,jackaudiosink:NONE,oss4sink:NONE,osssink:NONE
# How long the effective default output is read after the sink appears. Measured 2026-11-01 (#266): a
# stacked name took the default by the first read, 0.001 s after `create-node` returned.
TONE_GUARD_WINDOW_S=2
TONE_GIT_DIR="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
TONE_STATE_DIR="${TONE_GIT_DIR:+$TONE_GIT_DIR/backchannel-tone-sink}"
TONE_SINK_ID=""          # the node this run made, if it made one
TONE_DEFAULT_BEFORE=""   # the effective default output, read before the sink was made
TONE_GRAPH="$(dirname "${BASH_SOURCE[0]}")/tone-graph.py"

# Exits non-zero when PipeWire could not be asked, which is not the same answer as "unset".
tone_sink_configured() {
  local out
  out=$(pw-metadata -n default 0 default.configured.audio.sink 2>/dev/null) || return 1
  printf '%s\n' "$out" | sed -n "s/.*key:'default.configured.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

# The effective default output. Exits non-zero when PipeWire could not be asked and when the value is
# empty: two failed reads must not compare equal (#266).
tone_sink_effective() {
  local out v
  out=$(pw-metadata -n default 0 default.audio.sink 2>/dev/null) || return 1
  v=$(printf '%s\n' "$out" | sed -n "s/.*key:'default.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1)
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

# A value naming a node of the family: the constant, or any run's name.
tone_sink_names_it() { case "$1" in *"\"$TONE_SINK_FAMILY\""*|*"\"${TONE_SINK_FAMILY}_"*) return 0 ;; *) return 1 ;; esac; }

# The ids of every node of the family, one per line. Exits non-zero when the graph could not be read, so
# no caller takes a failed read for an empty graph.
tone_sink_nodes() {
  python3 -I "$TONE_GRAPH" nodes --family "$TONE_SINK_FAMILY"
}

# The effective default output is still the one read before this run's sink existed, or the sink is
# destroyed and the pass stops, naming both values.
# The words say whether the sink is gone: a destroy that did not take leaves the id, for the exit trap and
# for `restore` (#266's gate adversary). The move need not be the sink's own doing, a headset connecting
# moves the default too, but the run cannot tell the two apart, so it stops either way.
tone_sink_guard_default() {
  local now gone="the sink is destroyed"
  if ! now=$(tone_sink_effective); then
    tone_sink_destroy || gone="the sink could NOT be destroyed; run 'bash scripts/lib/tone-sink.sh restore'"
    die "harness: the effective default output could not be read, so nothing shows the tone sink left it alone; $gone"
  fi
  [ "$now" = "$TONE_DEFAULT_BEFORE" ] && return 0
  tone_sink_destroy || gone="the sink could NOT be destroyed; run 'bash scripts/lib/tone-sink.sh restore'"
  die "harness: the effective default output moved from $TONE_DEFAULT_BEFORE to $now since the tone sink was made (the sink taking it, or an output of the person's own changing); the run stops rather than guess which, and $gone"
}

tone_sink_create() {
  local stale configured
  [ -n "$TONE_STATE_DIR" ] || die "harness: could not find the repository's git dir, so a run from before #266 that never put the default output back cannot be ruled out"
  [ -e "$TONE_STATE_DIR/original-default-sink" ] \
    && die "harness: a tone press was interrupted and the default output was never put back ($TONE_STATE_DIR); run 'bash scripts/lib/tone-sink.sh restore' first"
  stale=$(tone_sink_nodes) || die "harness: could not read the graph, so a stale tone sink cannot be ruled out"
  stale=$(printf '%s' "$stale" | tr '\n' ' ')
  [ -z "$stale" ] || die "harness: a tone sink is already in the graph (node ${stale% }); run 'bash scripts/lib/tone-sink.sh restore' first, rather than make a second one"
  configured=$(tone_sink_configured) || die "harness: could not read the configured default output, so a tone sink configured as the default cannot be ruled out"
  tone_sink_names_it "$configured" \
    && die "harness: the configured default output is a tone sink; run 'bash scripts/lib/tone-sink.sh restore' first"
  TONE_DEFAULT_BEFORE=$(tone_sink_effective) || die "harness: could not read the effective default output, so nothing could show the tone sink leaves it alone"
  tone_sink_names_it "$TONE_DEFAULT_BEFORE" \
    && die "harness: the effective default output is already a tone sink ($TONE_DEFAULT_BEFORE); run 'bash scripts/lib/tone-sink.sh restore' first"
  pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$TONE_SINK_NAME node.description=\"Backchannel tone sink\" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }" >/dev/null \
    || die "harness: could not create the tone sink"
  local n ids
  for n in $(seq 1 25); do
    # No node of this name existed a moment ago, so a single one there now is this run's. Two means
    # something else made one meanwhile, and neither can be called ours.
    ids=$(tone_sink_nodes) || { sleep 0.2; continue; }
    case "$(printf '%s\n' "$ids" | grep -c .)" in
      0) ;;
      1) TONE_SINK_ID=$ids; break ;;
      *) die "harness: more than one tone sink appeared (nodes $(printf '%s' "$ids" | tr '\n' ' ')); refusing to guess which is this run's" ;;
    esac
    sleep 0.2
  done
  [ -n "$TONE_SINK_ID" ] || die "harness: the tone sink never appeared in the graph"
  # WirePlumber ranks a node for the default only once it has ports (module-default-nodes.c:284), so the
  # reads that follow start once the sink has its input ports, at most 5 s on.
  local ports=0
  for n in $(seq 1 25); do
    ports=$(python3 -I "$TONE_GRAPH" ports "$TONE_SINK_ID" 2>/dev/null) && [ "${ports:-0}" -gt 0 ] && break
    sleep 0.2
  done
  if ! [ "${ports:-0}" -gt 0 ] 2>/dev/null; then
    tone_sink_destroy
    die "harness: the tone sink had no input ports within 5 s, so nothing could show the default output stays put once it does"
  fi
  for n in $(seq 1 $(( TONE_GUARD_WINDOW_S * 5 ))); do
    tone_sink_guard_default
    sleep 0.2
  done
}

# Legacy, for a run from before #266 that never put the default back: puts the original default back
# from the file. Writes only while the configured default still names a tone sink: if it names another output, the person chose that since, and the file is dropped
# instead. A read that fails, or reads nothing, cannot tell those apart, so it changes nothing and
# keeps the file. Returns non-zero, and keeps the file, whenever the original is not known to be back.
tone_sink_put_back() {
  local orig now n
  orig=$(cat "$TONE_STATE_DIR/original-default-sink")
  if ! now=$(tone_sink_configured) || [ -z "$now" ]; then
    say "the configured default output could not be read or is unset; nothing was changed, and the original ($orig) is kept in $TONE_STATE_DIR"
    return 1
  fi
  if ! tone_sink_names_it "$now"; then
    rm -f "$TONE_STATE_DIR/original-default-sink"; rmdir "$TONE_STATE_DIR" 2>/dev/null
    say "the default output is ${now:-unset}, not the tone sink, so it is left alone (the original was $orig)"
    return 0
  fi
  pw-metadata -n default 0 default.configured.audio.sink "$orig" >/dev/null
  for n in $(seq 1 25); do
    if [ "$(tone_sink_configured 2>/dev/null)" = "$orig" ]; then
      rm -f "$TONE_STATE_DIR/original-default-sink"; rmdir "$TONE_STATE_DIR" 2>/dev/null
      say "the default output is back to $orig"
      return 0
    fi
    sleep 0.2
  done
  say "the default output could NOT be put back to $orig (it reads $(tone_sink_configured)); kept in $TONE_STATE_DIR"
  return 1
}

# The EXIT trap's half: the node this run made, and only while its id still names it. PipeWire gives a
# freed id to the next object (three `pw-dump` clients in a row each got id 99, #266's critic), so once the
# sink is gone the id may be someone else's. A run stopped before its node's id was read leaves the node,
# for `restore` to clear.
# Returns non-zero, and keeps the id, when the node is still there after the destroy.
tone_sink_destroy() {
  [ -n "$TONE_SINK_ID" ] || return 0
  local name
  if name=$(python3 -I "$TONE_GRAPH" name-of "$TONE_SINK_ID" 2>/dev/null) && [ "$name" = "$TONE_SINK_NAME" ]; then
    pw-cli destroy "$TONE_SINK_ID" >/dev/null 2>&1
    if ! name=$(python3 -I "$TONE_GRAPH" name-of "$TONE_SINK_ID" 2>/dev/null) || [ "$name" = "$TONE_SINK_NAME" ]; then
      say "node $TONE_SINK_ID ($TONE_SINK_NAME) is still in the graph, or the graph could not be read, after its destroy; run 'bash scripts/lib/tone-sink.sh restore'"
      return 1
    fi
  else
    say "node $TONE_SINK_ID no longer names $TONE_SINK_NAME (it reads '${name:-<unreadable>}'), so it is left alone"
  fi
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
      else
        configured=$(tone_sink_configured) || die "could not read the configured default output; nothing was changed"
        tone_sink_names_it "$configured" \
          && die "the configured default output is a tone sink and nothing records what it was before; choose your output in the sound settings, then run this again"
      fi
      ids=$(tone_sink_nodes) || die "could not read the graph; nothing was destroyed"
      for id in $ids; do pw-cli destroy "$id" >/dev/null 2>&1; done
      remaining=$(tone_sink_nodes) || die "could not read the graph after destroying ${ids:-nothing}"
      [ -z "$remaining" ] || die "a tone sink is still in the graph (node $remaining)"
      say "no tone sink in the graph"
      ;;
    *) die "usage: bash scripts/lib/tone-sink.sh restore" ;;
  esac
fi

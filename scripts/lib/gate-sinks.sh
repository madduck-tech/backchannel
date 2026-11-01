# Two null sinks, A and B, for a pass that seeds one system device and picks the other. (#242)
#
# Sourced. Neither sink is the harness sink, which feeds the microphone, and neither is ever made the
# default output: a both-Default start opens the default output's monitor, so a B that was the default
# would pass the very control the pass exists for. The descriptions are quoted inside the node's
# properties, as tone-sink.sh does; the harness's unquoted form was measured collapsing to its first
# word. What the graph reports is read back, not assumed.
#
#   gate_sinks_create            sets GATE_SINK_A, GATE_SINK_B (node names), GATE_DESC_A, GATE_DESC_B
#   gate_sinks_destroy           removes both, by the ids this run created
#   gate_sink_remove <name>      removes one of them now, and returns once the graph no longer has it
#   gate_sink_is_default <name>  exits 0 when <name> is the effective default output
#
# The descriptions are read through #293's `harness_description`, so a split `pw-dump` is one graph (#320).
# This file sources `harness-guard.sh` itself: two-channel sources it only after `gate_sinks_create` runs.

GATE_SINK_A=backchannel_gate_sink_a
GATE_SINK_B=backchannel_gate_sink_b
GATE_SINK_IDS=""

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness-guard.sh"

gate__nodes() { python3 -I "$(dirname "${BASH_SOURCE[0]}")/tone-graph.py" nodes "$1"; }

# GATE_DESC_A and GATE_DESC_B, or the pass stops: on either read failing, with words naming the graph as
# unreadable, and on two descriptions that are not distinct. Each read is checked on its own, because a
# report from the second cannot stand for the first (#320's critic, round 4). A statement of its own, never
# `$(…)`: `harness_description` returns 1 silently, and `GATE_DESC_A=$(…)` under `set -e` exits with
# nothing said.
gate__descs() {
  if ! GATE_DESC_A=$(harness_description "$GATE_SINK_A"); then die "the audio graph could not be read, so gate sink A has no description"; fi
  if ! GATE_DESC_B=$(harness_description "$GATE_SINK_B"); then die "the audio graph could not be read, so gate sink B has no description"; fi
  [ -n "$GATE_DESC_A" ] && [ -n "$GATE_DESC_B" ] && [ "$GATE_DESC_A" != "$GATE_DESC_B" ] \
    || die "the two sinks do not present distinct descriptions ('$GATE_DESC_A', '$GATE_DESC_B')"
}

gate_sinks_create() {
  local name desc ids n
  for name in "$GATE_SINK_A" "$GATE_SINK_B"; do
    ids=$(gate__nodes "$name") || die "could not read the graph"
    [ -z "$ids" ] || die "a node named $name is already in the graph (node $ids); remove it with 'pw-cli destroy $ids' first"
    desc="Backchannel gate sink $(printf '%s' "${name##*_}" | tr a-z A-Z)"
    pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$name node.description=\"$desc\" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }" >/dev/null \
      || die "could not create $name"
    for n in $(seq 1 25); do
      ids=$(gate__nodes "$name") || { sleep 0.2; continue; }
      [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ] && break
      sleep 0.2
    done
    [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ] || die "$name did not appear in the graph exactly once"
    GATE_SINK_IDS="$GATE_SINK_IDS $ids"
  done
  gate__descs
}

gate_sinks_destroy() {
  local id
  for id in $GATE_SINK_IDS; do pw-cli destroy "$id" >/dev/null 2>&1 || true; done
  GATE_SINK_IDS=""
}

gate_sink_remove() {
  local ids id n keep=""
  ids=$(gate__nodes "$1") || die "could not read the graph"
  [ -n "$ids" ] || die "$1 is not in the graph to remove"
  for id in $ids; do pw-cli destroy "$id" >/dev/null 2>&1 || die "could not remove $1 (node $id)"; done
  for n in $(seq 1 25); do [ -z "$(gate__nodes "$1" 2>/dev/null)" ] && break; sleep 0.2; done
  [ -z "$(gate__nodes "$1")" ] || die "$1 is still in the graph after its removal"
  for id in $GATE_SINK_IDS; do case " $ids " in *" $id "*) ;; *) keep="$keep $id" ;; esac; done
  GATE_SINK_IDS="$keep"
}

gate_sink_is_default() {
  pw-metadata -n default 0 default.audio.sink 2>/dev/null | grep "\"name\":\"$1\"" >/dev/null
}

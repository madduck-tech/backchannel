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
#   gate_sink_is_default <name>  exits 0 when <name> is the effective default output

GATE_SINK_A=backchannel_gate_sink_a
GATE_SINK_B=backchannel_gate_sink_b
GATE_SINK_IDS=""

gate__nodes() { python3 -I "$(dirname "${BASH_SOURCE[0]}")/tone-graph.py" nodes "$1"; }
gate__desc() {
  pw-dump | python3 -c 'import json,sys
for o in json.load(sys.stdin):
    p=(o.get("info") or {}).get("props") or {}
    if p.get("node.name")==sys.argv[1]: print(p.get("node.description") or ""); break' "$1"
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
  GATE_DESC_A=$(gate__desc "$GATE_SINK_A"); GATE_DESC_B=$(gate__desc "$GATE_SINK_B")
  [ -n "$GATE_DESC_A" ] && [ -n "$GATE_DESC_B" ] && [ "$GATE_DESC_A" != "$GATE_DESC_B" ] \
    || die "the two sinks do not present distinct descriptions ('$GATE_DESC_A', '$GATE_DESC_B')"
}

gate_sinks_destroy() {
  local id
  for id in $GATE_SINK_IDS; do pw-cli destroy "$id" >/dev/null 2>&1 || true; done
  GATE_SINK_IDS=""
}

gate_sink_is_default() {
  pw-metadata -n default 0 default.audio.sink 2>/dev/null | grep -q "\"name\":\"$1\""
}

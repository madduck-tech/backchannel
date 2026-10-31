#!/usr/bin/env bash
# Run one gate entry under a silent recorder and #293's graph sampler, and say where the recorder was
# linked from across it.
#
#   scripts/stage2-capture-watch.sh <outdir> [--app-pgid-glob GLOB] -- <command...>
#
# The recorder is `pw-record --volume=0` with no target: it follows the default input, as a call's
# microphone in a browser tab does. The command runs in a session of its own, so the sampler can stop
# it, and only it, with one TERM to its group the moment a capture that is neither the recorder's nor
# the entry's appears. Before anything starts, no other capture may be in the graph.
set -uo pipefail
OUT="${1:?usage: stage2-capture-watch.sh <outdir> [--app-pgid-glob GLOB] -- <command...>}"; shift
GLOB=""
[ "${1:-}" = --app-pgid-glob ] && { GLOB="$2"; shift 2; }
[ "${1:-}" = -- ] && shift
[ $# -gt 0 ] || { echo "no command" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRAPH="$HERE/lib/capture-graph.py"
mkdir -p "$OUT"
say() { printf 'capture-watch: %s\n' "$*" | tee -a "$OUT/watch.log"; }

BEFORE=$(python3 -I "$GRAPH" inputs) || { say "the audio graph could not be read, so nothing shows no other capture is in it"; exit 3; }
[ -z "$BEFORE" ] || { say "a capture is already in the graph, so this entry would run beside it: $BEFORE"; exit 3; }

pw-record --volume=0 - > /dev/null 2> "$OUT/recorder.err" &
REC=$!
# Linked before the entry starts, so every sample can require the link: a recorder still unlinked when
# `up` runs would show nothing about where the default went.
for _ in $(seq 1 40); do [ -n "$(python3 -I "$GRAPH" recorder "$REC")" ] && break; sleep 0.25; done
FROM=$(python3 -I "$GRAPH" recorder "$REC" | tr '\n' ' ')
[ -n "$FROM" ] || { kill -TERM "$REC" 2>/dev/null; say "the recorder was never linked"; exit 3; }
say "recorder pid $REC, linked from $FROM"

PGIDFILE="$OUT/pass.pgid"
setsid bash -c 'echo $$ > "$1"; shift; exec bash -c "$*"' bash "$PGIDFILE" "$@" > "$OUT/pass.log" 2>&1 &
WAITER=$!
for _ in $(seq 1 40); do [ -s "$PGIDFILE" ] && break; sleep 0.05; done
PASS=$(cat "$PGIDFILE" 2>/dev/null)
# Without its group nothing could stop the entry, so it does not run on.
[ -n "$PASS" ] || { kill -TERM -"$WAITER" 2>/dev/null || kill -TERM "$WAITER" 2>/dev/null; kill -TERM "$REC" 2>/dev/null; say "the entry's session never reported its group; stopped"; exit 3; }
say "the entry runs as session $PASS: $*"

python3 -I "$GRAPH" watch "$OUT/graph.jsonl" "$REC" "$PASS" --stop ${GLOB:+--app-pgid-glob "$GLOB"} &
SAMPLER=$!
wait "$WAITER"; RC=$?
kill -TERM "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null
kill -TERM "$REC" 2>/dev/null; wait "$REC" 2>/dev/null
say "the entry exited $RC"
python3 -I "$GRAPH" summary "$OUT/graph.jsonl" | tee "$OUT/summary.txt"
exit "$RC"

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

# Stopped with the watch, however it ends: a recorder left behind would hold the person's default input
# open with nothing to end it, and an entry left running would run unwatched.
REC=""; SAMPLER=""; PASS=""; WAITER=""; TORN=""
# The entry's group, or, before the entry has reported it, the session leader `setsid` made of it, whose
# pid is the group's.
group() { printf '%s' "${PASS:-$WAITER}"; }
teardown() {
  [ -n "$TORN" ] && return
  TORN=1
  [ -n "$(group)" ] && kill -TERM -"$(group)" 2>/dev/null
  [ -n "$SAMPLER" ] && kill -TERM "$SAMPLER" 2>/dev/null
  [ -n "$REC" ] && kill -TERM "$REC" 2>/dev/null
}
trap teardown EXIT
# Stopped, it waits until the entry's whole group has ended, so whatever runs next does not start beside the
# entry's teardown: the record step's shell ends while the pass it ran is still dropping its recordings, so
# the session leader alone is not enough. Up to a minute, then the group is killed. Bash reaps an ended
# child while this waits, so `kill -0` reads the group as it is.
stopped() {
  trap '' INT TERM
  say "stopped by a signal: the entry, the sampler and the recorder are stopped with it"
  teardown
  if [ -n "$(group)" ]; then
    for _ in $(seq 1 240); do kill -0 -"$(group)" 2>/dev/null || break; sleep 0.25; done
    kill -0 -"$(group)" 2>/dev/null && { say "the entry did not end within a minute; killing its group"; kill -KILL -"$(group)" 2>/dev/null; }
    wait "$WAITER" 2>/dev/null
  fi
  exit 143
}
trap stopped INT TERM

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

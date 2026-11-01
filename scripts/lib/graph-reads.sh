# The graph reads of the two-channel and ui-record passes (#320), through `capture-graph.py`, which reads a
# split `pw-dump` (two arrays) as one graph and fails on an unreadable one. Sourced by both passes after
# their `die` and before their first read.
#
#   pick_two_channel_sink                    TARGET_SINK, TARGET_DESC: the sink whose monitor two-channel picks
#   pick_ui_record_sink                      TARGET_SINK, TARGET_DESC, and OTHER_SINK for the wrong-sink control
#   refuse_if_the_default_output_plays <which start>
#                                            dies unless the graph shows nothing playing on the default output
#
# Each function sets its answer or stops the pass itself, with words that name an unreadable graph as
# unreadable. None returns a status for its caller to read: measured on 2026-11-01 by #320's critic, a
# status read at the call site lost the report three ways, the cause discarded, a here-string's empty
# line taken for "no sink", and a refusal's reader read as `local playing=$(…)` going on to the start. So
# each is called as a statement of its own, and every read is checked inside it with `if !`, which holds
# with and without `set -e`.

GR_GRAPH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capture-graph.py"

gr__unreadable() {  # <so what> [the reader's last line]
  local why=${2-}
  die "the audio graph could not be read (${why:-capture-graph.py failed}), so $1"
}

# A read through the shared reader: its stdout into the variable named first, its status returned, and the
# last line of its stderr in GR_WHY, so a timeout, a truncated dump and a reader bug do not read the same.
# Stderr is kept apart from the answer: taken with it, a line the loader or a wrapper wrote on a read that
# succeeded became the default sink's name, and the refusal went ahead on a graph with no default sink
# (#320's gate adversary, round 2).
gr__read() {  # <variable> <capture-graph.py command>
  local err rc=0 got
  err=$(mktemp "${TMPDIR:-/tmp}/graph-reads.XXXXXX") || { GR_WHY="could not make a temporary file"; return 1; }
  got=$(python3 -I "$GR_GRAPH" "$2" 2>"$err") || rc=$?
  GR_WHY=$(tail -n 1 "$err")
  rm -f "$err"
  printf -v "$1" '%s' "$got"
  return "$rc"
}

# The rule both picks kept from 133d100 (two-channel :109-111, ui-record :66-69), over `nodes`' rows: the
# Audio/Sink rows in graph order, two-channel's without `backchannel_harness*`; the first whose description
# contains `Speaker`, else the first; and for ui-record, the first other sink by name. Runs of spaces, tabs
# and carriage returns in the description are collapsed and trimmed, as 133d100's Python `str.split()` did
# for them, since `PICK` is matched with XPath's `normalize-space()` (two-channel :354, ui-record :185).
gr__pick() {  # <nodes> <skip-harness|all>
  local row
  TARGET_SINK=""; TARGET_DESC=""; OTHER_SINK=""
  row=$(printf '%s\n' "$1" | awk -F'\t' -v skip="$2" '
    $3 == "Audio/Sink" && !(skip == "skip-harness" && index($2, "backchannel_harness") == 1) {
      d = $4; gsub(/[ \t\r]+/, " ", d); sub(/^ /, "", d); sub(/ $/, "", d)
      n++; name[n] = $2; desc[n] = d
    }
    END {
      t = 0
      for (i = 1; i <= n; i++) if (index(desc[i], "Speaker")) { t = i; break }
      if (!t && n) t = 1
      if (!t) exit
      o = ""
      for (i = 1; i <= n; i++) if (name[i] != name[t]) { o = name[i]; break }
      printf "%s\037%s\037%s\n", name[t], desc[t], o
    }')
  [ -n "$row" ] || return 0
  IFS=$'\037' read -r TARGET_SINK TARGET_DESC OTHER_SINK <<<"$row"
}

pick_two_channel_sink() {
  local nodes
  if ! gr__read nodes nodes; then gr__unreadable "no sink can be picked" "$GR_WHY"; fi
  gr__pick "$nodes" skip-harness
  OTHER_SINK=""
  [ -n "$TARGET_SINK" ] || die "no Audio/Sink to target"
}

pick_ui_record_sink() {
  local nodes
  if ! gr__read nodes nodes; then gr__unreadable "no sink can be picked" "$GR_WHY"; fi
  gr__pick "$nodes" all
  [ -n "$TARGET_SINK" ] || die "no Audio/Sink to target"
}

# What plays on the default output, read just before a start that could record it: a both-Default start,
# the tray's, or one whose picked device is gone opens the default output's monitor and records everything
# playing there. A graph with no default sink, the key absent or naming no node, fails closed: nothing can
# be shown silent there (133d100:329-331).
refuse_if_the_default_output_plays() {  # <which start>
  local out sink playing=""
  if ! gr__read out default-output; then
    gr__unreadable "nothing shows the default output silent; $1 is not made" "$GR_WHY"
  fi
  sink=${out%%$'\n'*}
  [ -n "$sink" ] || die "no default output sink is in the graph, so nothing shows it silent; $1 is not made"
  [ "$out" = "$sink" ] || playing=${out#*$'\n'}
  [ -z "$playing" ] || die "something plays on the default output (${playing//$'\n'/, }); $1 could record it, so the pass refuses to make it"
}

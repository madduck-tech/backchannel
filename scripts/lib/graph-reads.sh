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

gr__unreadable() { die "the audio graph could not be read (capture-graph.py failed), so $1"; }

# The rule both picks kept from 133d100 (two-channel :109-111, ui-record :66-69), over `nodes`' rows: the
# Audio/Sink rows in graph order, two-channel's without `backchannel_harness*`; the first whose description
# contains `Speaker`, else the first; and for ui-record, the first other sink by name.
gr__pick() {  # <nodes> <skip-harness|all>
  local row
  TARGET_SINK=""; TARGET_DESC=""; OTHER_SINK=""
  row=$(printf '%s\n' "$1" | awk -F'\t' -v skip="$2" '
    $3 == "Audio/Sink" && !(skip == "skip-harness" && index($2, "backchannel_harness") == 1) { n++; name[n] = $2; desc[n] = $4 }
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
  if ! nodes=$(python3 -I "$GR_GRAPH" nodes 2>/dev/null); then gr__unreadable "no sink can be picked"; fi
  gr__pick "$nodes" skip-harness
  OTHER_SINK=""
  [ -n "$TARGET_SINK" ] || die "no Audio/Sink to target"
}

pick_ui_record_sink() {
  local nodes
  if ! nodes=$(python3 -I "$GR_GRAPH" nodes 2>/dev/null); then gr__unreadable "no sink can be picked"; fi
  gr__pick "$nodes" all
  [ -n "$TARGET_SINK" ] || die "no Audio/Sink to target"
}

# What plays on the default output, read just before a start that could record it: a both-Default start,
# the tray's, or one whose picked device is gone opens the default output's monitor and records everything
# playing there. A graph with no default sink, the key absent or naming no node, fails closed: nothing can
# be shown silent there (133d100:329-331).
refuse_if_the_default_output_plays() {  # <which start>
  local out sink playing=""
  if ! out=$(python3 -I "$GR_GRAPH" default-output 2>/dev/null); then
    gr__unreadable "nothing shows the default output silent; $1 is not made"
  fi
  sink=${out%%$'\n'*}
  [ -n "$sink" ] || die "no default output sink is in the graph, so nothing shows it silent; $1 is not made"
  [ "$out" = "$sink" ] || playing=${out#*$'\n'}
  [ -z "$playing" ] || die "something plays on the default output (${playing//$'\n'/, }); $1 could record it, so the pass refuses to make it"
}

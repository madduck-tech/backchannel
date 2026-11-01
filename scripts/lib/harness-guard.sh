# The harness's guard (#293): the harness never becomes the default input, and a recording opens the
# harness's microphone by name. Sourced by the core pass, `onboarding resumes` and the record pass's two
# entries. Each check prints why it failed on stderr and returns 1; the caller dies with it.
#
#   harness_description <src>                             the description of the node named <src>
#   harness_effective_source                              default.audio.source's name, or nothing
#   harness_guard_after_up <before>                       after `up`: the effective default is the one read
#                                                         before `up`, and not empty
#   harness_guard_before_start <prefs> <seed> <src>       before Start: the stored microphone is the seed, and
#                                                         exactly one Audio/Source carries the harness's
#                                                         description, the node named <src>
#   harness_guard_after_start <log> <from-line> <desc> <src> [secs] [root-pid]
#                                                         after Start: what the start opened, read from the
#                                                         log after <from-line>, and a link from <src> into
#                                                         the application within [secs]: a capture of a
#                                                         process under [root-pid], when it is given
#   harness_guard_drop_recordings <profile>               on a failure after Start: the recordings go before
#                                                         the profile is kept, the application's default
#                                                         save folders under the profile's HOME included,
#                                                         and so does the database their transcripts are in
#
# The graph is read through `capture-graph.py`, which reads a split `pw-dump` (two arrays, 8 of 696 reads
# on 2026-10-31) as one graph and fails on an unreadable one.

HARNESS_GUARD_GRAPH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capture-graph.py"

# The description PipeWire reports for the node named <src>, or nothing; non-zero on an unreadable graph.
# pw-loopback keeps only `Backchannel` of the one the harness asks for, so it is read, never assumed.
harness_description() {
  local nodes
  nodes=$(python3 -I "$HARNESS_GUARD_GRAPH" nodes 2>/dev/null) || return 1
  printf '%s\n' "$nodes" | awk -F'\t' -v n="$1" '$2 == n { print $4; exit }'
}

harness_effective_source() {
  pw-metadata -n default 0 default.audio.source 2>/dev/null \
    | sed -n "s/.*key:'default.audio.source' value:'\(.*\)' type:.*/\1/p" | tail -1 \
    | python3 -c 'import json,sys
t=sys.stdin.read().strip()
try: print(json.loads(t).get("name",""))
except Exception: print("")'
}

harness_guard_after_up() {
  local before="$1" after
  after=$(harness_effective_source)
  if [ -z "$before" ] || [ -z "$after" ]; then
    echo "the effective default input could not be read (before '$before', after '$after'), so nothing shows the harness left it alone" >&2
    return 1
  fi
  if [ "$after" != "$before" ]; then
    echo "the effective default input moved across 'up', from '$before' to '$after'" >&2
    return 1
  fi
}

harness_guard_before_start() {
  local prefs="$1" seed="$2" src="$3" stored nodes
  stored=$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["preferences"].get("preferred_mic_device") or "")
except Exception: print("")' "$prefs")
  if [ "$stored" != "$seed" ]; then
    echo "the stored microphone is '$stored', not the seed '$seed'" >&2
    return 1
  fi
  if ! nodes=$(python3 -I "$HARNESS_GUARD_GRAPH" nodes 2>/dev/null); then
    echo "the graph could not be read, so nothing shows the seed names one source" >&2
    return 1
  fi
  nodes=$(printf '%s\n' "$nodes" | awk -F'\t' -v d="${seed% (input)}" '$3 == "Audio/Source" && $4 == d { print $2 }')
  if [ "$(printf '%s\n' "$nodes" | grep -c .)" != 1 ]; then
    echo "$(printf '%s\n' "$nodes" | grep -c .) Audio/Source nodes carry the seed's description, not one: $(printf '%s ' $nodes)" >&2
    return 1
  fi
  if [ "$nodes" != "$src" ]; then
    echo "the one source carrying the seed's description is '$nodes', not this run's harness source '$src'" >&2
    return 1
  fi
}

harness_guard_after_start() {
  local log="$1" from="$2" desc="$3" src="$4" secs="${5:-20}" root="${6:-}" after i
  # Here-strings, not pipes: `grep -q` closing a pipe early fails the writer under pipefail, and the
  # form is what `a-gate-oracle-reads-a-line-the-app-writes` reads as a grep of the log.
  after=$(tail -n +"$from" "$log")
  if ! grep "Creating microphone stream: $desc" <<<"$after" >/dev/null; then
    echo "no 'Creating microphone stream: $desc' after the start" >&2; return 1
  fi
  if ! grep "Microphone stream created successfully" <<<"$after" >/dev/null; then
    echo "no 'Microphone stream created successfully' after the start" >&2; return 1
  fi
  if ! grep "Using microphone: '$desc'" <<<"$after" >/dev/null; then
    echo "no 'Using microphone: '$desc'' after the start" >&2; return 1
  fi
  if grep "Using microphone: '" <<<"$after" | grep -v "Using microphone: '$desc'" >/dev/null; then
    echo "the start used another microphone: $(grep -o "Using microphone: '[^']*'" <<<"$after" | grep -v "'$desc'" | head -1)" >&2; return 1
  fi
  if grep "The microphone '.*' is not available" <<<"$after" >/dev/null; then
    echo "the start failed on its microphone: $(grep -o "The microphone '.*' is not available.*" <<<"$after" | head -1)" >&2; return 1
  fi
  # The log names only the device asked for; the link is what shows it opened.
  for i in $(seq 1 $((secs * 4))); do
    if python3 -I "$HARNESS_GUARD_GRAPH" app-linked "$src" $root 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo "no link from '$src' into the application${root:+ under pid $root} within ${secs}s of the start" >&2
  return 1
}

harness_guard_drop_recordings() {
  local profile="$1"
  case "$profile" in
    */..|*/../*) echo "refusing a profile path that climbs: $profile" >&2; return 1 ;;
    # `$PROFILE/rec` is the seeded save folder; the other two are where the application saves when it
    # could not read the seed (`recording_preferences.rs`, Linux), which is also when it records the
    # default microphone. What it heard is in the database as text, so that goes too; the logs stay.
    /tmp/backchannel-*)
      rm -rf -- "$profile/rec" "$profile/home/Documents/backchannel-recordings" "$profile/home/backchannel-recordings" \
        "$profile/home/.local/share/tech.madduck.backchannel/meeting_minutes.sqlite" \
        "$profile/home/.local/share/tech.madduck.backchannel/meeting_minutes.sqlite-wal" \
        "$profile/home/.local/share/tech.madduck.backchannel/meeting_minutes.sqlite-shm" ;;
    *) echo "refusing to remove recordings outside a gate profile: $profile" >&2; return 1 ;;
  esac
}

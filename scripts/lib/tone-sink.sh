# A silent sink for the audio check's tone. Sourced by `stage2-core-check.sh`. (#168)
#
# The system row plays a 440 Hz tone through the machine's **default output** and listens on that
# output's monitor. Pressed with the person's own default, the tone sounds in their speakers or
# headphones; on 2026-10-24 the default was a Bluetooth headset. So for the length of one press the
# default output is this null sink, which nothing else plays into, and the row listens on its monitor.
# "Audio arrived" then means the tone, not whatever the machine happened to be playing.
#
# The sink is created before the application starts, so the device list the audio check enumerates
# contains its monitor. The default is moved only around the press, and put back from the value
# read just before the move, never from memory. `tone_sink_destroy` restores and removes; the pass's
# EXIT trap calls it, so a failure mid-press still puts the machine back. WirePlumber may keep the
# sink's name in its persisted fallback history; that entry is inert once the sink is gone, the same
# residue `audio-harness.sh down` reports for its source.

TONE_SINK_NAME=backchannel_tone_sink
TONE_SINK_ID=""
TONE_ORIG_SINK=""
TONE_SINK_DEFAULTED=""

tone_sink_configured() {
  pw-metadata -n default 0 default.configured.audio.sink 2>/dev/null \
    | sed -n "s/.*key:'default.configured.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

tone_sink_effective() {
  pw-metadata -n default 0 default.audio.sink 2>/dev/null \
    | sed -n "s/.*key:'default.audio.sink' value:'\(.*\)' type:.*/\1/p" | tail -1
}

tone_sink_create() {
  pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$TONE_SINK_NAME node.description=\"Backchannel tone sink\" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }" >/dev/null \
    || die "harness: could not create the tone sink"
  local n
  for n in $(seq 1 25); do
    TONE_SINK_ID=$(pw-dump | python3 -c '
import json, sys
for o in json.load(sys.stdin):
    p = (o.get("info") or {}).get("props") or {}
    if p.get("node.name") == sys.argv[1]:
        print(o["id"]); break
' "$TONE_SINK_NAME")
    [ -n "$TONE_SINK_ID" ] && return 0
    sleep 0.2
  done
  die "harness: the tone sink never appeared in the graph"
}

tone_sink_make_default() {
  TONE_ORIG_SINK=$(tone_sink_configured)
  [ -n "$TONE_ORIG_SINK" ] || die "harness: could not read the configured default output; refusing to change it"
  pw-metadata -n default 0 default.configured.audio.sink "{\"name\":\"$TONE_SINK_NAME\"}" >/dev/null
  TONE_SINK_DEFAULTED=1
  local n
  for n in $(seq 1 25); do
    [ "$(tone_sink_effective)" = "{\"name\":\"$TONE_SINK_NAME\"}" ] && { say "the default output is the tone sink for this press (was $TONE_ORIG_SINK)"; return 0; }
    sleep 0.2
  done
  die "harness: the tone sink did not become the default output; it is $(tone_sink_effective)"
}

tone_sink_restore() {
  [ -n "$TONE_SINK_DEFAULTED" ] || return 0
  pw-metadata -n default 0 default.configured.audio.sink "$TONE_ORIG_SINK" >/dev/null || true
  TONE_SINK_DEFAULTED=""
  say "the default output is back to $(tone_sink_configured)"
}

tone_sink_destroy() {
  tone_sink_restore
  [ -n "$TONE_SINK_ID" ] && pw-cli destroy "$TONE_SINK_ID" >/dev/null 2>&1
  TONE_SINK_ID=""
}

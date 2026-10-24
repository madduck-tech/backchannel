# The first-run audio check, pressed and judged. Sourced by the Stage 2 passes that reach it, after
# `lib/webdriver.sh` (for `click`) and after the pass defines `BASE`, `say`, `die` and `find_el`.
# (#167, #168)
#
# **Pressed, not counted.** Until #167 the onboarding pass counted this screen's controls and never
# pressed one. Every release build answered `Command check_capture_device not found`, and the product
# owner found it by hand.

AUDIO_CHECK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The microphone row's verdict, as the JSON `audio-check-outcome.js` returns. The script is sent as
# it is on disk, so the gate and the oracle's own test read the screen with one definition.
audio_check_read() {
  local body resp
  body=$(python3 -c 'import json,sys; print(json.dumps({"script": open(sys.argv[1]).read(), "args": []}))' \
    "$AUDIO_CHECK_LIB/audio-check-outcome.js")
  # A failed request must not end a `set -euo pipefail` pass in silence. This function runs inside
  # `v=$(audio_check_read)`, which does not inherit errexit, so what matters is its exit status: the
  # last pipeline below always succeeds, and a failed request becomes `found: false`, which the
  # caller names as the harness's failure. (It used to end on `curl | python3`, and pipefail handed
  # curl's 28 to the caller.)
  resp=$(curl -s -m 20 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$body")
  printf '%s' "$resp" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("value")
except Exception:
    v = None
print(v if isinstance(v, str) else json.dumps({"found": False, "driver": repr(v)[:200]}))'
}

# The row as the log may show it. With AUDIO_CHECK_REDACT=1 the decoded words are left out: a pass with
# no harness opens the machine's real microphone, and what the room said does not belong in a gate log.
audio_check_shown() {
  if [ "${AUDIO_CHECK_REDACT:-}" = 1 ] && [ "$(audio_check_field "$1" kind)" = HEARD ]; then
    printf 'Heard: <%s words, not logged: this pass has no harness and the microphone is the room>' \
      "$(audio_check_field "$1" decoded | wc -w | tr -d ' ')"
  else
    audio_check_field "$1" outcome | cut -c1-200
  fi
}

audio_check_field() { python3 -c 'import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"; }

# Press **Check by speaking** and wait for what it rendered. Sets AUDIO_CHECK to the final verdict.
#
#   1. The control must be enabled. It is `disabled={!value || …}`, so enabled means the picker holds
#      a device. A click on a disabled button still returns WebDriver success, so pressing one would
#      read as the product doing nothing. That is a harness failure, and it says so.
#   2. Then the press, and two waits. First, something that is false before the press: the label
#      leaves `Check by speaking`, or an outcome appears (the press arrived). Second, an outcome with
#      the control idle again. A single wait satisfied by `Listening…` would judge a screen that had
#      not answered yet.
audio_check_press() {
  local v el i
  v=$(audio_check_read)
  [ "$(audio_check_field "$v" found)" = "True" ] || die "harness: the audio check's microphone row is not on screen ($v)"
  [ "$(audio_check_field "$v" button)" = "Check by speaking" ] \
    || die "harness: the microphone control reads '$(audio_check_field "$v" button)' before anything was pressed"
  [ "$(audio_check_field "$v" disabled)" = "False" ] \
    || die "harness: 'Check by speaking' is disabled, so the picker holds no device ('$(audio_check_field "$v" device)'). A press here would return success and do nothing"
  [ -z "$(audio_check_field "$v" outcome)" ] || die "harness: an outcome is on screen before the press: $(audio_check_field "$v" outcome)"
  say "the microphone picker holds '$(audio_check_field "$v" device)', and Check by speaking is enabled"

  el=$(find_el '{"using":"xpath","value":"//button[normalize-space()=\"Check by speaking\"]"}')
  [ -n "$el" ] || die "harness: no element for 'Check by speaking'"
  click "$el" "Check by speaking"

  for i in $(seq 1 30); do
    v=$(audio_check_read)
    # A row that vanished is the driver or the page failing, not the control answering. Without
    # this, a missing `button` field read as "the label left Check by speaking" and the pass blamed
    # the product two minutes later.
    [ "$(audio_check_field "$v" found)" = "True" ] || die "harness: after the click the driver no longer reads the microphone row ($v)"
    { [ "$(audio_check_field "$v" button)" != "Check by speaking" ] || [ -n "$(audio_check_field "$v" outcome)" ]; } && break
    sleep 0.5
  done
  { [ "$(audio_check_field "$v" button)" != "Check by speaking" ] || [ -n "$(audio_check_field "$v" outcome)" ]; } \
    || die "the press did not arrive: 15s later the control still reads 'Check by speaking' and nothing rendered"
  say "the press arrived: the control reads '$(audio_check_field "$v" button)'"

  for i in $(seq 1 240); do
    v=$(audio_check_read)
    [ "$(audio_check_field "$v" found)" = "True" ] || die "harness: while waiting for an outcome the driver stopped reading the microphone row ($v)"
    [ -n "$(audio_check_field "$v" outcome)" ] && [ "$(audio_check_field "$v" button)" = "Check by speaking" ] && break
    sleep 0.5
  done
  [ -n "$(audio_check_field "$v" outcome)" ] \
    || die "the audio check never answered: after 120s the control reads '$(audio_check_field "$v" button)' and no outcome rendered"
  AUDIO_CHECK=$v
  say "the microphone check answered ($(audio_check_field "$v" kind)): $(audio_check_shown "$v")"
}

# Fail unless the outcome is one the command's body produces (#167): a rendered result, or an error
# `device_check.rs` returns. `Command … not found`, a Tauri argument error, or a failed load fails.
audio_check_require_body_answer() {
  case "$(audio_check_field "$AUDIO_CHECK" kind)" in
    HEARD|SILENT|NO_WORDS|BODY_ERROR) return 0 ;;
  esac
  die "the audio check answered with something its command does not say: '$(audio_check_shown "$AUDIO_CHECK")'"
}

# `dictation_probe` must not ship (#167). The expression's own value is compared, never the driver's
# error, so a missing `__TAURI_INTERNALS__` cannot read as a refusal.
probe_stays_out() {
  local body resp v
  body=$(python3 -c 'import json; print(json.dumps({"script": "return window.__TAURI_INTERNALS__.invoke(\"dictation_probe\").then(function (v) { return \"RESOLVED:\" + JSON.stringify(v); }, function (e) { return \"REJECTED:\" + String(e); });", "args": []}))')
  # `|| resp=""` matters only to a caller at the top level of a `set -e` script, which is how
  # `audio-check-harness.test.mjs` calls it. The onboarding pass calls it inside an `if` condition,
  # where errexit is off, so there the guard changes nothing. Said here because round 2 claimed
  # the opposite and the gate's adversary measured it.
  resp=$(curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$body") || resp=""
  v=$(printf '%s' "$resp" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("value")
except Exception:
    v = None
print(v if isinstance(v, str) else "DRIVER:" + repr(v)[:200])')
  case "$v" in
    DRIVER:*) die "harness: the driver could not run the probe expression, so nothing was learned about the build: $v" ;;
  esac
  [ "$v" = "REJECTED:Command dictation_probe not found" ] \
    || die "dictation_probe answered '$v'. A measurement whose header says it cannot ship is reachable in this build"
  say "dictation_probe is not in this build: $v"
}

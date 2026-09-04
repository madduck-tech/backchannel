#!/usr/bin/env bash
#
# Drive the built application through the settings tabs and the audio device pickers, and
# assert what a person would see there.
#
#   scripts/stage2-ui-check.sh <AppImage> [profile-dir]
#
# Stage 2's other driver reads the AT-SPI tree, and that tree has no action for a `page tab`:
# a click on one returns ok and does nothing, `perform-secondary-action select` is
# unsupported, keyboard input does not reach the webview, and a coordinate click delivers no
# pointer event even with real element bounds. So everything behind the settings tabs -- the
# device pickers, the transcription model list, the summary settings -- has never been driven
# by the gate. That is a limit of that instrument, not of the application.
#
# This one speaks WebDriver to `tauri-driver`, which proxies to WebKitWebDriver and launches
# the application with automation enabled. Clicks are W3C Element Clicks: real pointer events
# through WebKit, not `element.click()`.
#
# It is cheap on purpose -- about ten seconds, on a profile of a couple of megabytes with no
# models -- so it can run in the pass that does not wait for a 4.3 GB download. The audio
# round trip stays in `stage2-record-check.sh`, which needs a live PipeWire session.
#
# One rule this harness is built around, because breaking it is invisible: **a click that
# returns ok is not evidence it landed.** Measured -- with the window minimized, a W3C Element
# Click returns `{"value":null}`, the WebDriver success response, and nothing happens. So every
# click below is followed by an assertion on the DOM or on disk, never by the click's own
# return value.
#
# Two boundary facts the verdict must carry rather than discover:
#
#   * Under the driver the application runs with WEBKIT_INSPECTOR_SERVER set and
#     `navigator.webdriver === true`, and the webview's automation mode on -- the variable
#     that turns it on is TAURI_WEBVIEW_AUTOMATION, read at
#     tauri-runtime-wry-2.11.4/src/lib.rs:4792. `tauri-driver` also sets TAURI_AUTOMATION for
#     Tauri 1.x, which nothing in this tree reads; naming that one instead is an easy mistake
#     and was made once already. `gopnik.json` says Stage 2 launches the app "as a first-time
#     user would"; this pass does not, and the difference is real.
#   * The driver owns the process. `DELETE /session` stops the application cleanly; killing
#     tauri-driver without it leaves the app orphaned. So this bypasses the setsid/pidfile
#     teardown `stage2-record-check.sh` uses rather than reusing it.
set -euo pipefail

APP="${1:?usage: stage2-ui-check.sh <AppImage> [profile-dir]}"
PROFILE="${2:-}"   # created below, after the preconditions: a die() between mktemp and the
                   # EXIT trap leaks the directory, which is how the F10 fix was incomplete.
PORT="${BC_WD_PORT:-14444}"
NATIVE_PORT="${BC_WD_NATIVE_PORT:-14445}"
CACHE="${BC_MODELS_CACHE:-$HOME/.cache/backchannel-gate-models}"

say() { printf 'stage2-ui-check: %s\n' "$*"; }
die() { printf 'stage2-ui-check: %s\n' "$*" >&2; exit 1; }

command -v tauri-driver >/dev/null || die "tauri-driver is not installed: cargo install tauri-driver --locked"
[ -x /usr/bin/WebKitWebDriver ] || die "WebKitWebDriver is not installed: apt install webkit2gtk-driver"
[ -x "$APP" ] || die "not an executable AppImage: $APP"

# The application is single-instance: it claims com.conversationaly.ai.SingleInstance on the
# session bus, and a second copy hands its argv to the first and exits. Under the driver that
# looks like nothing at all -- the automation handshake never completes, five session attempts
# fail, and the driver log says `hyper::Error(IncompleteMessage)`, which names the symptom and
# not the cause. Found by running this against a machine that already had one up. Cheaper to
# say so than to let the next person read that log.
# Identify it by what each process *is*, never by a command line: `pgrep -f` matches the
# AppImage path in this script's own argv, so the first version of this guard refused its own
# caller on an idle machine -- including the exact invocation gopnik.json uses.
RUNNING=""
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
  # Basename, not the AppImage mount path: `target/release/conversationaly` -- what a local
  # build and `pnpm tauri:dev` produce, and what a developer is most likely to have open --
  # takes the same single-instance lock and produced the same silent 2m40s hang.
  case "$exe" in
    */conversationaly) RUNNING="$pid"; break ;;
  esac
done
[ -z "$RUNNING" ] || die "another copy of the application is already running (pid $RUNNING).
    It is single-instance -- tauri_plugin_single_instance claims a name on the session bus,
    which HOME/XDG isolation does not scope -- so the copy this pass launches hands its argv
    to that one and exits, and the WebDriver handshake then times out with 'IncompleteMessage'.
    Stop it and re-run."

if [ -z "$PROFILE" ]; then PROFILE=$(mktemp -d /tmp/backchannel-ui-check.XXXXXX); OWN_PROFILE=1; fi
APPDATA="$PROFILE/home/.local/share/com.conversationaly.ai"
mkdir -p "$APPDATA"
# The onboarding marker alone -- no models. This pass never records, so it does not need them,
# and that is what makes it cheap enough to run on every gate.
if [ -f "$CACHE/onboarding-status.json" ]; then
  cp -a "$CACHE/onboarding-status.json" "$APPDATA/"
  say "seeded the onboarding marker only ($(du -sh "$PROFILE" | cut -f1)); no models"
else
  say "no onboarding marker in $CACHE; the app will start at first-run and this pass will fail"
fi

DRIVER_LOG="$PROFILE/tauri-driver.log"
cleanup() {
  [ -n "${SESSION:-}" ] && curl -s -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1 || true
  # The group, not the name: `pkill -x WebKitWebDriver` kills drivers this run never started,
  # which defeats the BC_WD_PORT knobs whose only purpose is a second concurrent run. Same
  # class as the fix in 6db27e9 for the other harness. setsid is already used above, so the
  # group id is the driver's own pid.
  [ -n "${DRIVER_PID:-}" ] && kill -TERM -"$DRIVER_PID" 2>/dev/null || true
  sleep 1
  [ -n "${DRIVER_PID:-}" ] && kill -KILL -"$DRIVER_PID" 2>/dev/null || true
  # Kept on failure: the application's own logs/ live in there, and the driver log alone does
  # not say what the app was doing. stage2-record-check.sh keeps its profile for the same reason.
  if [ -n "${OWN_PROFILE:-}" ] && [ "${PASSED:-}" = "1" ]; then
    rm -rf "$PROFILE"
  elif [ -n "${OWN_PROFILE:-}" ]; then
    printf 'stage2-ui-check: profile kept for inspection: %s\n' "$PROFILE" >&2
  fi
}
trap cleanup EXIT

HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/home/.config" \
  XDG_DATA_HOME="$PROFILE/home/.local/share" XDG_CACHE_HOME="$PROFILE/home/.cache" \
  setsid tauri-driver --port "$PORT" --native-port "$NATIVE_PORT" > "$DRIVER_LOG" 2>&1 &
DRIVER_PID=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/status" && break; sleep 0.25; done

# One in four cold runs died with `hyper::Error(User(Service)) ... Connection reset by peer`
# between tauri-driver and WebKitWebDriver; tauri-driver sets retry_canceled_requests(false),
# so the retry has to live here. Sample of four, said as such.
SESSION=""
for attempt in 1 2 3 4 5; do
  RESP=$(curl -s -m 30 -X POST "http://127.0.0.1:$PORT/session" -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$APP\",\"args\":[]}}}}" || true)
  SESSION=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["value"]["sessionId"])
except Exception: print("")' 2>/dev/null)
  [ -n "$SESSION" ] && break
  # A driver that answers with `session not created` has diagnosed the failure; retrying it
  # four more times costs two and a half minutes and adds nothing. Only the silent shape --
  # the application starts and never completes the handshake -- is worth a retry.
  if printf '%s' "$RESP" | grep -q 'session not created'; then
    printf '%s\n' "$RESP" | sed 's/^/    /' >&2
    die "the driver refused to create a session; its answer is above"
  fi
  say "session attempt $attempt produced no answer; retrying"
  sleep 2
done
[ -n "$SESSION" ] || {
  say "the last response body was: ${RESP:-<empty>}"
  sed 's/^/    /' "$DRIVER_LOG" >&2
  die "no WebDriver session after 5 attempts, and the driver never answered"
}
say "session up against $(basename "$APP")"

BASE="http://127.0.0.1:$PORT/session/$SESSION"
js() { curl -s -m 20 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' \
        -d "{\"script\":$1,\"args\":[]}" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["value"]))'; }
find_el() { curl -s -m 20 -X POST "$BASE/element" -H 'Content-Type: application/json' -d "$1" \
        | python3 -c 'import json,sys
v=json.load(sys.stdin).get("value")
print(list(v.values())[0] if isinstance(v,dict) and v else "")'; }
click() { curl -s -m 20 -X POST "$BASE/element/$1/click" -H 'Content-Type: application/json' -d '{}' >/dev/null; }
by_text() { find_el "{\"using\":\"xpath\",\"value\":\"//button[normalize-space()=\\\"$1\\\"]\"}"; }

# Poll for a condition instead of sleeping a fixed amount. stage2-record-check.sh already
# learned this -- its `click_labelled` polls and says why -- and the reason is the same here:
# a fixed sleep that is long enough on this machine is a red gate on a slower one, and it
# reads exactly like a regression.
# The expression must use single quotes: it is embedded in a JSON string, and a double quote
# in it produces a malformed request that the driver answers with null -- which polls as
# "not yet" until the timeout, so the failure looks like a slow app rather than a typo.
await() {  # await <js-expression-returning-boolean> <what-we-are-waiting-for> [seconds]
  local want="$1" what="$2" secs="${3:-15}" n=0
  while [ "$n" -lt $((secs * 2)) ]; do
    [ "$(js "\"return $want\"")" = "true" ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  die "timed out after ${secs}s waiting for $what"
}

# A build that starts but never completes the automation handshake produces no driver error
# at all -- the request simply never returns. So the bound is ours, and on expiry it says what
# it was waiting for and shows the driver's output rather than a bare timeout.
READY=""
for _ in $(seq 1 40); do
  if [ "$(js '"return document.querySelectorAll(\"button\").length > 0"')" = "true" ]; then READY=1; break; fi
  sleep 0.5
done
[ -n "$READY" ] || {
  say "the application never rendered a button within 20s; driver output:"
  sed 's/^/    /' "$DRIVER_LOG" >&2
  die "gave up waiting for the UI"
}

# --- the settings tabs open -------------------------------------------------------------
S=$(by_text "Settings"); [ -n "$S" ] || die "no Settings button in the DOM"
click "$S"
await "document.querySelectorAll('[role=tab]').length > 0" 'the settings screen to render its tabs'
T=$(by_text "Recordings"); [ -n "$T" ] || die "no Recordings tab in the DOM"
click "$T"
# Name the tab. "some tab is active" is true before the click -- General already is -- so the
# earlier form returned instantly and the race it was added to close stayed open, surfacing as
# "the Recordings tab did not open", which reads exactly like the product regression this
# harness exists to detect.
await "[...document.querySelectorAll('[role=tab]')].some(t=>t.textContent.trim()==='Recordings'&&t.getAttribute('data-state')==='active')" \
      'the Recordings tab to become active'
TABS=$(js '"return [...document.querySelectorAll(\"[role=tab]\")].map(t=>t.textContent.trim()+\":\"+t.getAttribute(\"data-state\")).join(\", \")"')
say "tabs: $TABS"
printf '%s' "$TABS" | grep -q 'Recordings:active' \
  || die "the Recordings tab did not open: $TABS"

# --- the system-audio picker lists something a person could choose ----------------------
# Note what this does and does not assert: that there is more than the default entry, not
# that the entries are monitors. Only monitors enter the list as DeviceType::Output
# (configure_linux_audio), so monitor-ness is warranted by that code rather than by anything
# observed here -- and asserting the string "Monitor of" would be the display-string class
# #9 and #10 are about.
TRIG=$(find_el '{"using":"css selector","value":"#system-selection"}')
[ -n "$TRIG" ] || die "no #system-selection trigger behind the Recordings tab"
click "$TRIG"
await "document.querySelectorAll('[role=option]').length > 0" 'the dropdown to open'
OPTIONS=$(js '"return [...document.querySelectorAll(\"[role=option]\")].map(o=>o.textContent.trim())"')
say "system-audio options: $OPTIONS"
COUNT=$(printf '%s' "$OPTIONS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
# Two different failures, and conflating them would break this harness's own founding rule:
# zero options means the trigger click did not land, one means the application enumerated
# nothing. The first is a harness defect, the second is a product defect.
[ "$COUNT" -ge 1 ] || die "the dropdown did not open: the trigger click landed nowhere"
[ "$COUNT" -gt 1 ] || die "the system-audio picker offers nothing but the default: $OPTIONS"

# --- selecting one through the dropdown reaches the stored preference -------------------
FIRST=$(printf '%s' "$OPTIONS" | python3 -c 'import json,sys
o=[x for x in json.load(sys.stdin) if not x.startswith("Default")]
print(o[0] if o else "")')
[ -n "$FIRST" ] || die "no non-default option to select"
OPT=$(find_el "{\"using\":\"xpath\",\"value\":\"//*[@role=\\\"option\\\"][normalize-space()=\\\"$FIRST\\\"]\"}")
[ -n "$OPT" ] || die "could not locate the option element for $FIRST"
click "$OPT"
# The preference is written by the Rust side, so the wait is on the file rather than the DOM.
# Poll for the field, not for a non-empty file: the store writes the file and fills it in two
# steps, so `-s` can be true while preferred_system_device is still absent.
for _ in $(seq 1 30); do
  [ -n "$(python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print((d.get("preferences") or d).get("preferred_system_device") or "")
except Exception: print("")' "$APPDATA/recording_preferences.json" 2>/dev/null)" ] && break
  sleep 0.5
done
STORED=$(python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print((d.get("preferences") or d).get("preferred_system_device") or "")
except Exception: print("")' "$APPDATA/recording_preferences.json")
say "stored preference: ${STORED:-<none>}"
[ -n "$STORED" ] || die "selecting '$FIRST' stored no preferred_system_device"
# Exact, not a prefix. `AudioDevice::from_name` (configuration.rs:66-90) errors unless the
# value ends in `(input)`/`(output)`, so a prefix match would accept the bare name and the
# pre-#13 `"<name> (System Audio)"` form -- the very shapes the application cannot resolve --
# while printing that it round-tripped.
[ "$STORED" = "$FIRST (output)" ] \
  || die "selected '$FIRST' and the app stored '$STORED'; it must store exactly '$FIRST (output)'"

PASSED=1
say "PASS - tabs open, ${COUNT} system-audio entries offered, and the picked one round-trips to disk"

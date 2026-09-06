#!/usr/bin/env bash
# Does this application's webview load on a machine? (#101)
#
# A measurement, not a check. It always exits 0 and prints one machine-readable verdict, the same
# shape as `headless-launch-probe.sh` and `environment-record.sh` (ADR 0019) — because the honest
# answer may be "no", and a probe that fails the build when the answer is no is one nobody can afford
# to run.
#
# **What is not established today.** `headless-launch-probe.sh` asserts a live process and two greps
# of stdout. `Application setup complete` is `lib.rs:433`, the third statement in the `.setup()`
# closure, and the database initialisation that can still panic is 74 lines later. Nothing in the tree
# logs a window-ready or webview-loaded signal:
#
#     grep -rniE "window[ _-]?ready|webview[ _-]?(loaded|ready)|on_page_load|DomContentLoaded" \
#       --include=*.rs --include=*.ts --include=*.tsx src-tauri/src src   ->   0 matches
#
# So the existing probe could not have asserted a render even in principle. **A WebDriver needs a
# loaded webview, not a live process**, and that gap is the whole subject here.
#
# **What this deliberately does NOT do.** It does not run `stage2-ui-check.sh`. #43 refused to give
# that script a sound-free mode, with a reason — *"deleting most of what it checks. Not worth it;
# named so nobody retries it without reading this"* — and two of its three asserted outcomes are
# sound-dependent (the system-audio picker, and the preference round-trip). This probes the mechanism
# **upstream** of those: driver, session, webview, one element. None of it needs a sound server.
#
# **On Xvfb, stated as #20 states it.** #20 measured a click that returned WebDriver success and did
# nothing *with the window minimized* — `IconicState` is a window-manager state, so under `xvfb-run`
# with no WM that measurement says nothing about this environment. #20's own words are the honest
# ones: *"Whether items 1-2 can run headless under Xvfb is **not measured** … whether WebKit renders
# there is a guess."* This probe exists to replace the guess, not to confirm a prediction.
set -uo pipefail

APP=${1:-}
say() { printf 'webdriver-probe: %s\n' "$*"; }
# Exactly one line matching ^webdriver-probe: verdict=(YES|NO|NOT_ATTEMPTED)$, so a reader — or a
# check — can tell "measured and the answer was no" from "never ran". Without it an always-exit-0
# probe that silently did nothing is indistinguishable from one that answered.
verdict() { printf 'webdriver-probe: verdict=%s\n' "$1"; printf 'webdriver-probe: %s\n' "${2:-}"; }

say "--- what is here ---"
say "  appimage        ${APP:-<none given>}"
say "  tauri-driver    $(command -v tauri-driver || echo absent)"
say "  WebKitWebDriver $(command -v WebKitWebDriver || echo absent)"
say "  xvfb-run        $(command -v xvfb-run || echo absent)"
say "  webkit2gtk      $(dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || echo absent)"

[ -n "$APP" ] && [ -x "$APP" ] || { verdict NOT_ATTEMPTED "no executable AppImage was given. Nothing measured."; exit 0; }
for tool in tauri-driver WebKitWebDriver; do
  command -v "$tool" >/dev/null || { verdict NOT_ATTEMPTED "$tool is not installed. Nothing measured."; exit 0; }
done

# Two display strategies, and which one was used is always printed, because they answer different
# questions. A runner is headless and needs `xvfb-run`; a developer's machine has a session already,
# and #20 measured that the driver works there. Running under an existing display and reporting it as
# the headless answer would be exactly the substitution this issue was rewritten twice for.
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ "${BC_FORCE_XVFB:-}" != "1" ]; then
  DISPLAY_MODE="an existing session (DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-})"
  WRAP=(dbus-run-session --)
else
  command -v xvfb-run >/dev/null || { verdict NOT_ATTEMPTED "no display and xvfb-run is not installed. Nothing measured."; exit 0; }
  DISPLAY_MODE="xvfb-run, no window manager"
  WRAP=(xvfb-run -a dbus-run-session --)
fi

WORK=$(mktemp -d /tmp/webdriver-probe.XXXXXX)
PORT=${BC_PROBE_PORT:-4455}
NATIVE_PORT=$((PORT + 1))
DRIVER_LOG="$WORK/driver.log"
SESSION=""
# shellcheck disable=SC2329  # "this function is never invoked"
# It is, by the `trap cleanup EXIT` below — an indirection shellcheck cannot follow, and the rule's
# own text allows for it. Silenced with the reason rather than left as a standing info finding.
cleanup() {
  [ -n "$SESSION" ] && curl -s -m 5 -X DELETE "http://127.0.0.1:$PORT/session/$SESSION" >/dev/null 2>&1
  [ -n "${DRIVER_PGID:-}" ] && kill -- "-$DRIVER_PGID" 2>/dev/null
  sleep 1
  [ -n "${DRIVER_PGID:-}" ] && kill -9 -- "-$DRIVER_PGID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# A clean profile with the onboarding marker seeded. Without it the app starts at first-run, which is
# a different screen and a different question; #43 named this as one of four blockers.
mkdir -p "$WORK/home/.local/share" "$WORK/home/.config" "$WORK/home/.cache"

# The three variables `headless-launch-probe.sh` found were needed. Which of them are load-bearing is
# still unmeasured, and that is part of this probe's finding rather than a detail: they are printed.
say ""
say "--- environment forced on the driver ---"
say "  WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1  WEBKIT_DISABLE_COMPOSITING_MODE=1  LIBGL_ALWAYS_SOFTWARE=1"
say "  display                       $DISPLAY_MODE"

HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_DATA_HOME="$WORK/home/.local/share" \
  XDG_CACHE_HOME="$WORK/home/.cache" \
  WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 \
  setsid "${WRAP[@]}" tauri-driver --port "$PORT" --native-port "$NATIVE_PORT" \
  > "$DRIVER_LOG" 2>&1 &
DRIVER_PGID=$!

UP=no
for _ in $(seq 1 60); do curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/status" && { UP=yes; break; }; sleep 0.5; done
say ""
say "  driver answered /status        $UP"
[ "$UP" = yes ] || {
  sed 's/^/    /' "$DRIVER_LOG" 2>/dev/null | head -20
  verdict NO "tauri-driver never answered /status under $DISPLAY_MODE. It is installed and it does not come up here."
  exit 0
}

# Same five-attempt retry as stage2-ui-check.sh, and for the same measured reason: one cold run in
# four dies with a connection reset between tauri-driver and WebKitWebDriver.
for attempt in 1 2 3 4 5; do
  RESP=$(curl -s -m 60 -X POST "http://127.0.0.1:$PORT/session" -H 'Content-Type: application/json' \
    -d "{\"capabilities\":{\"alwaysMatch\":{\"tauri:options\":{\"application\":\"$APP\",\"args\":[]}}}}" || true)
  SESSION=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["value"]["sessionId"])
except Exception: print("")' 2>/dev/null)
  [ -n "$SESSION" ] && break
  printf '%s' "$RESP" | grep -q 'session not created' && break
  say "  session attempt $attempt produced no answer; retrying"
  sleep 3
done

say "  session created               $([ -n "$SESSION" ] && echo yes || echo no)"
[ -n "$SESSION" ] || {
  say "  last response: ${RESP:-<empty>}"
  sed 's/^/    /' "$DRIVER_LOG" 2>/dev/null | head -20
  verdict NO "the driver is up but no WebDriver session could be created against the AppImage."
  exit 0
}

BASE="http://127.0.0.1:$PORT/session/$SESSION"
js() { curl -s -m 30 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' \
        -d "{\"script\":$1,\"args\":[]}" 2>/dev/null \
     | python3 -c 'import json,sys
try: print(json.dumps(json.load(sys.stdin)["value"]))
except Exception: print("null")' 2>/dev/null; }

# **The observation this probe exists for.** Not "the process is alive" and not "the session
# attached" — a DOM fact, read back through the session. A driver can attach to an application whose
# webview never painted; `document.readyState` and a body child count come from the page itself.
READY=null; NODES=null
for _ in $(seq 1 40); do
  READY=$(js '"return document.readyState"')
  NODES=$(js '"return document.body ? document.body.childElementCount : -1"')
  [ "$READY" = '"complete"' ] && [ "$NODES" != "null" ] && [ "$NODES" != "-1" ] && [ "$NODES" != "0" ] && break
  sleep 0.5
done
TITLE=$(js '"return document.title"')
BUTTONS=$(js '"return document.querySelectorAll(\"button\").length"')

say ""
say "--- what the page reports through the session ---"
say "  document.readyState           $READY"
say "  body child elements           $NODES"
say "  document.title                $TITLE"
say "  button elements               $BUTTONS"
say ""
say "--- first 20 lines of the driver log ---"
head -20 "$DRIVER_LOG" 2>/dev/null | sed 's/^/    /'
say "--- end ---"

if [ "$READY" = '"complete"' ] && [ "$NODES" != "null" ] && [ "$NODES" != "-1" ] && [ "$NODES" != "0" ]; then
  if [ "$BUTTONS" != "null" ] && [ "$BUTTONS" != "0" ]; then
    verdict YES "a webview loaded and rendered $NODES top-level element(s) and $BUTTONS button(s). The mechanism stage2-ui-check.sh rests on works on this runner."
  else
    verdict YES "a webview loaded and rendered $NODES top-level element(s), but no button was found. The mechanism works; what the page shows is a separate question."
  fi
else
  verdict NO "a session attached but the page never reported a loaded document. The driver works and the webview does not render here."
fi
exit 0

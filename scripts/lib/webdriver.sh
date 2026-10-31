# Shared WebDriver helpers for the Stage 2 passes. Sourced, never executed.
#
# Why this file exists (#160). Four passes each carried their own
#
#     click() { curl -s -m 20 -X POST "$BASE/element/$1/click" ... >/dev/null; }
#
# and so not one of them could tell a click the driver performed from a click the driver refused.
# Measured 2026-09-10 in `stage2-two-channel-check.sh`: the Element Click on the settings screen's
# Back control, and the one on `Start recording` after it, both answered
#
#     {"value":{"error":"element not interactable","message":"","stacktrace":""}}
#
# The pass printed `recording`, slept eight seconds, read the application's log and reported "the
# application never created a microphone stream". The application had opened nothing because nothing
# had asked it to: twelve seconds after the click the settings screen was still on screen, with zero
# Stop controls. A harness fault wearing the shape of a product defect, for a day.
#
# The caller supplies `BASE`, `die` and `say`; bash resolves them at call time, so each pass keeps its
# own prefix.

# How long a transient refusal is waited out before it becomes fatal, in seconds.
WD_CLICK_BUDGET="${WD_CLICK_BUDGET:-10}"

# click <element-id> [what it is, for the message] — press it, or die naming the driver's refusal.
#
# `element not interactable` and `element click intercepted` are the two answers a correct
# application still produces transiently, so they are waited out rather than fatal on sight: Radix
# takes `pointer-events` off `document.body` while a Select is open and gives them back when the
# close animation ends, and these passes click through exactly that window. Measured at the Back
# control, one second apart, with the element's rect, visibility and opacity unchanged:
# `pointer-events: none`, `elementFromPoint` returning `HTML`; then `pointer-events: auto`,
# `elementFromPoint` returning the icon inside the button.
#
# Every other error is fatal at once. `no such element` is not a state that improves, and retrying it
# would turn a real regression into a ten-second pause followed by the same wrong sentence.
click() {
  local el="$1" what="${2:-element $1}" n=0 t0=$SECONDS resp err first_why=""
  while :; do
    resp=$(curl -s -m 20 -X POST "$BASE/element/$el/click" -H 'Content-Type: application/json' -d '{}')
    err=$(printf '%s' "$resp" | python3 -c 'import json, sys
try:
    v = json.load(sys.stdin).get("value")
except Exception:
    print("the driver returned nothing readable"); raise SystemExit
print(v.get("error") or "unnamed driver error" if isinstance(v, dict) else "")')
    if [ -z "$err" ]; then
      # A refusal the retry absorbed is still a fact about the application, and staying silent about
      # it is the same shape as the defect this helper was written for, one level in: a control that
      # was unpressable for six seconds is indistinguishable here from one that never was.
      # "the Back control took 1.5s" is about Radix; "Start recording took 8s" is about the product.
      if [ "$n" -gt 0 ]; then
        say "clicking $what took $((SECONDS - t0))s and $((n + 1)) attempts. At the first refusal: $first_why"
      fi
      return 0
    fi
    case "$err" in
      "element not interactable"|"element click intercepted")
        n=$((n + 1))
        # Sampled at the *first* refusal as well as the last: by the time the budget expires the page
        # has moved on, so a late read-back does not report the state that caused the refusal.
        [ -z "$first_why" ] && first_why=$(wd_why "$el")
        if [ "$n" -ge $((WD_CLICK_BUDGET * 2)) ]; then
          die "clicking $what: the driver refused for ${WD_CLICK_BUDGET}s with '$err'. At the first refusal: $first_why Now: $(wd_why "$el") The element is on screen and cannot be pressed — that is a state nothing is leaving, not a slow application."
        fi
        sleep 0.5
        ;;
      *)
        die "clicking $what: the driver answered '$err'"
        ;;
    esac
  done
}

# type_into <element-id> <text> [what it is] — type into a field, or die naming the driver's refusal.
#
# #166's gate found Element Send Keys in the same shape `click` was written for: three posts in two
# passes ended `> /dev/null`, so a refused input read as "waited 20s for the search to narrow the
# catalogue", a sentence about the application. Unlike a click, no refusal here is transient.
type_into() {
  local el="$1" text="$2" what="${3:-element $1}" body resp err
  body=$(TEXT="$text" python3 -c 'import json, os; print(json.dumps({"text": os.environ["TEXT"]}))')
  resp=$(curl -s -m 20 -X POST "$BASE/element/$el/value" -H 'Content-Type: application/json' -d "$body")
  err=$(printf '%s' "$resp" | python3 -c 'import json, sys
try:
    v = json.load(sys.stdin).get("value")
except Exception:
    print("the driver returned nothing readable"); raise SystemExit
print(v.get("error") or "unnamed driver error" if isinstance(v, dict) else "")')
  [ -z "$err" ] || die "typing into $what: the driver answered '$err'"
}

# wd_why <element-id> — ask the page why it refused, so the message names the application's state
# rather than the driver's verdict.
#
# WebKit answers `element not interactable` whenever the element is missing from the hit test at its
# own centre — and `disabled:pointer-events-none` is on every `Button` variant
# (`ui/button.tsx:16`) and on the recording controls (`RecordingControls.tsx:443`). So a control the
# application deliberately disabled produces the same three words as a Radix close animation, and
# without this read-back the pass would wait one out and then blame the driver for the other. This is
# the one thing the retry above can hide, so it is named rather than left to be inferred.
wd_why() {
  local ref="$1" script args
  script='return (function (el) {
    if (!el) return "the element is gone from the page";
    var cs = getComputedStyle(el), b = getComputedStyle(document.body);
    var why = [];
    if (el.disabled === true) why.push("the control is disabled");
    if (el.getAttribute("aria-disabled") === "true") why.push("aria-disabled=true");
    if (b.pointerEvents === "none") why.push("document.body has pointer-events:none, which is what Radix does while a Select closes");
    else if (cs.pointerEvents === "none") why.push("the control itself has pointer-events:none");
    if (cs.visibility !== "visible") why.push("visibility:" + cs.visibility);
    if (parseFloat(cs.opacity) === 0) why.push("opacity:0");
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) why.push("it has no size");
    if (r.bottom < 0 || r.top > innerHeight) why.push("it is outside the viewport");
    return why.length ? ("The page says: " + why.join("; ") + ".") : "The page reports nothing unusual about it.";
  })(arguments[0]);'
  args=$(python3 -c 'import json,sys; print(json.dumps({"script": sys.argv[1], "args": [{"element-6066-11e4-a52e-4f735466cecf": sys.argv[2]}]}))' "$script" "$ref")
  curl -s -m 20 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$args" \
    | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("value")
except Exception:
    v = None
print(v if isinstance(v, str) else "(the page could not be asked why.)")'
}

# wd_raw_find <css-selector> — Find Element's whole answer for the selector, as the driver gave it. Not
# `find_el`, which turns every miss into "" and so leaves a failure nothing to say (#296).
wd_raw_find() {
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"using": "css selector", "value": sys.argv[1]}))' "$1")
  curl -s -m 20 -X POST "$BASE/element" -H 'Content-Type: application/json' -d "$body" | head -c 400
}

# wd_panel_state <css-selector> — what the active tab panel shows in place of the element: the element
# itself, RecordingSettings' placeholder (the preferences are pending, `RecordingSettings.tsx:132-139`),
# DeviceSelection's (the device list is pending, `DeviceSelection.tsx:103-113`), or a panel rendered
# without it. Read from the DOM at the moment of asking, never inferred.
wd_panel_state() {
  local body
  body=$(python3 -c 'import json,sys
script = """return (function (sel) {
  var p = Array.from(document.querySelectorAll("[role=tabpanel]")).find(function (t) { return t.getAttribute("data-state") === "active"; });
  if (!p) return "no active tab panel";
  if (p.querySelector(sel)) return "the element itself";
  var a = p.querySelector(".animate-pulse");
  if (a && a.parentElement && a.parentElement.classList.contains("p-4")) return "DeviceSelection’s placeholder: the device list is pending";
  if (a) return "RecordingSettings’ placeholder: the preferences are pending";
  return "the panel rendered without it";
})(arguments[0]);"""
print(json.dumps({"script": script, "args": [sys.argv[1]]}))' "$1")
  curl -s -m 20 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$body" \
    | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("value")
except Exception:
    v = None
print(v if isinstance(v, str) else "(the page could not be asked: %r)" % (v,))'
}

# await_present <css-selector> <what> [seconds] — wait until the page holds an element matching the
# selector, then return. It polls `!!document.querySelector(<selector>)`, which is false while a
# placeholder renders in the element's place, so a lookup made the moment a tab opens no longer races
# the render (#296: entry 13 looked for the system-audio picker once, and lost to its device list 3 of
# 3 times on one artifact). It says how long it waited, and whether the element was absent at the first
# check. On a timeout it dies with what the panel shows and Find Element's own answer.
await_present() {
  local sel="$1" what="$2" secs="${3:-30}" t0 first="" v body
  t0=$(date +%s%3N)
  body=$(python3 -c 'import json,sys; print(json.dumps({"script": "return !!document.querySelector(" + json.dumps(sys.argv[1]) + ")", "args": []}))' "$sel")
  while :; do
    v=$(curl -s -m 20 -X POST "$BASE/execute/sync" -H 'Content-Type: application/json' -d "$body" \
      | python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin).get("value")))
except Exception:
    print("null")')
    [ -z "$first" ] && first="$v"
    [ "$v" = "true" ] && break
    if [ $(( $(date +%s%3N) - t0 )) -ge $((secs * 1000)) ]; then
      die "timed out after ${secs}s waiting for $what ($sel). The panel shows $(wd_panel_state "$sel"); Find Element answers $(wd_raw_find "$sel")"
    fi
    sleep 0.25
  done
  say "$what rendered after $(( $(date +%s%3N) - t0 )) ms; at the first check it was $([ "$first" = true ] && echo present || echo "absent ($first)")"
}

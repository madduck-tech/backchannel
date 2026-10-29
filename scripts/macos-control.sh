#!/usr/bin/env bash
# Drive a recording on the development Mac without the UI (#281, ADR 0034).
#
#   macos-control.sh build                    build the bundle with the HEAD revision embedded
#   macos-control.sh launch                   start that bundle with control enabled
#   macos-control.sh send <command> [args]    run one command and print its result line
#       start --mic "<name> (input)" --system "<name> (output)" [--meeting <name>]
#             (the suffixed form the UI passes; a bare name is refused by the command)
#       stop | status | set-backend --backend <id>
#
# Every `send` first checks that the app owning the single-instance socket is the bundle built
# from EXPECT_REV (default: HEAD), by finding that revision's hash inside its executable. An
# older bundle, the main checkout's included, has no dispatcher and could not answer `status`.
#
# What a control run does not exercise is listed in #281: every UI surface, the onboarding
# gate, the frontend's model check and title, and the meeting's database row.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
BUNDLE=${BUNDLE:-$REPO/target/release/bundle/macos/Backchannel.app}
EXE=$BUNDLE/Contents/MacOS/backchannel
SOCKET=/tmp/tech_madduck_backchannel_si.sock   # the identifier, dots and dashes as underscores
RESULTS="$HOME/Library/Application Support/tech.madduck.backchannel/control-results.jsonl"
TIMEOUT=${TIMEOUT:-120}

die() { echo "macos-control: $*" >&2; exit 1; }

expect_rev() { echo "${EXPECT_REV:-$(git -C "$REPO" rev-parse HEAD)}"; }

socket_owner() {
  # The executable of the process listening on the socket, or nothing.
  local pid
  pid=$(lsof -t "$SOCKET" 2>/dev/null | head -1) || true
  [ -n "$pid" ] || return 0
  ps -o comm= -p "$pid" 2>/dev/null || true
}

check_running_bundle() {
  [ -S "$SOCKET" ] || die "no app is running ($SOCKET missing); run '$0 launch' first. Not starting the binary from this shell: it would own the TCC grants."
  local owner rev
  owner=$(socket_owner)
  [ -n "$owner" ] || die "nothing listens on $SOCKET"
  rev=$(expect_rev)
  [ "$owner" = "$EXE" ] || die "the running app is $owner, not $EXE (expected revision $rev)"
  grep -aqF "$rev" "$owner" || die "the running app $owner was not built from $rev (no such revision inside it; built from another revision, or before #281)"
}

case "${1:-}" in
  build)
    [ -z "$(git -C "$REPO" status --porcelain)" ] || die "the tree is dirty; the embedded revision would not describe the build"
    rev=$(git -C "$REPO" rev-parse HEAD)
    (cd "$REPO/frontend" && BACKCHANNEL_BUILT_FROM=$rev pnpm run tauri:build)
    grep -aqF "$rev" "$EXE" || die "built, but $rev is not inside $EXE"
    echo "built $EXE from $rev"
    ;;
  launch)
    [ ! -S "$SOCKET" ] || [ -z "$(socket_owner)" ] || die "an app is already running: $(socket_owner)"
    rev=$(expect_rev)
    grep -aqF "$rev" "$EXE" || die "$EXE was not built from $rev; run '$0 build'"
    # LaunchServices, so the app is the responsible process for TCC; -n so this exact bundle
    # starts (a plain `open` was measured to start the main checkout's bundle instead).
    open -n -a "$BUNDLE" --args --control-enabled
    for _ in $(seq 1 30); do
      [ -n "$(socket_owner)" ] && break
      sleep 1
    done
    [ "$(socket_owner)" = "$EXE" ] || die "launched, but the socket is owned by '$(socket_owner)', not $EXE"
    echo "running $EXE ($rev), control enabled"
    ;;
  send)
    shift
    command=${1:?command: start, stop, status, set-backend}
    shift
    check_running_bundle
    id="$(date +%s)-$$-$RANDOM"
    mkdir -p "$(dirname "$RESULTS")"
    before=$( [ -f "$RESULTS" ] && wc -l < "$RESULTS" || echo 0 )
    # The second process forwards these arguments over the socket and exits 0 whatever happens
    # next, so its status is not read. The result line is.
    "$EXE" --control "$command" --control-id "$id" "$@" >/dev/null 2>&1 || true
    for _ in $(seq 1 "$TIMEOUT"); do
      line=$(tail -n +"$((before + 1))" "$RESULTS" 2>/dev/null | grep -F "\"id\":\"$id\"" | head -1 || true)
      if [ -n "$line" ]; then
        echo "$line"
        case "$line" in *'"ok":true'*) exit 0 ;; *) exit 1 ;; esac
      fi
      sleep 1
    done
    die "no result for $command ($id) within ${TIMEOUT}s"
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac

#!/usr/bin/env bash
# Does the committed disk-floor hook reach a real Claude Code session? (#259)
#
#   scripts/disk-floor-hook-reach.sh
#
# Measured for a verdict, and again whenever Claude Code's version changes; not a gate entry, since it
# drives the claude binary. It clones HEAD fresh, starts scripts/lib/messages-stub.py on 127.0.0.1, and
# runs `claude -p` in the clone under `env -i`: an empty HOME, a dummy key, the stub as the endpoint,
# nonessential traffic off, and a `cargo` shim first on PATH that leaves a marker when it runs. The
# stub answers the first request that offers Bash with a `tool_use` for `cargo build`. No --settings:
# the hook must come from the committed .claude/settings.json.
#
#   hook        the floor raised: the tool_result Claude sends back carries the floor's message, and
#               the marker does not exist (the command was blocked)
#   no hook     control: the hook removed from the clone's settings; the marker exists and the
#               message is absent
#   floor at 0  control: the marker exists
#
# It then reads the hook's cost from the debug log's `Hooks: PreToolUse:Bash [...] finished with
# status N (X ms)` line, for `ls`, which the matcher ignores, and for `cargo build` above the floor.
set -euo pipefail

say() { printf 'reach: %s\n' "$*"; }
die() { printf 'reach: %s\n' "$*" >&2; exit 1; }

TOP=$(git rev-parse --show-toplevel)
CLAUDE=$(command -v claude) || die "no claude on PATH"
CLAUDE_DIR=$(dirname "$(readlink -f "$CLAUDE")")
WORK=$(mktemp -d /tmp/disk-floor-reach.XXXXXX)
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true; rm -rf -- "$WORK"; }
trap cleanup EXIT

say "claude $("$CLAUDE" --version 2>/dev/null | head -1); the clone is of $TOP at $(git -C "$TOP" rev-parse --short HEAD)"
mkdir -p "$WORK/bin"
printf '#!/bin/sh\ntouch "%s/marker"\necho "cargo shim: built nothing"\n' "$WORK" > "$WORK/bin/cargo"
chmod +x "$WORK/bin/cargo"

# One run: <name> <command the stub asks for> <floor GB> [no-hook]
run() {
  local name=$1 command=$2 floor=$3 nohook=${4:-} dir="$WORK/$1"
  mkdir -p "$dir/home"
  git clone -q --no-local "$TOP" "$dir/clone"
  git -C "$dir/clone" checkout -q "$(git -C "$TOP" rev-parse HEAD)"
  if [ -n "$nohook" ]; then
    python3 -I -c 'import json,sys; p=sys.argv[1]; s=json.load(open(p)); s["hooks"]["PreToolUse"]=[e for e in s["hooks"]["PreToolUse"] if e.get("matcher")!="Bash"]; json.dump(s,open(p,"w"))' "$dir/clone/.claude/settings.json"
  fi
  rm -f "$WORK/marker" "$dir/port"
  python3 -I "$TOP/scripts/lib/messages-stub.py" "$dir/requests.jsonl" "$dir/port" "$command" &
  STUB_PID=$!
  for _ in $(seq 1 50); do [ -s "$dir/port" ] && break; sleep 0.1; done
  [ -s "$dir/port" ] || die "$name: the stub did not start"
  (cd "$dir/clone" && env -i HOME="$dir/home" PATH="$WORK/bin:$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin" \
     ANTHROPIC_API_KEY=stub-key-not-real ANTHROPIC_BASE_URL="http://127.0.0.1:$(cat "$dir/port")" \
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 BC_DISK_FLOOR_GB="$floor" \
     timeout 180 "$CLAUDE" -p "Build the project." --dangerously-skip-permissions --debug-file "$dir/debug.log" \
     < /dev/null > "$dir/out.txt" 2>&1) || true
  kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; STUB_PID=""
  [ -e "$WORK/marker" ] && MARKER=1 || MARKER=""
  # The tool_result the session sent back for the stub's tool_use.
  RESULT=$(python3 -I -c 'import json,sys
for line in open(sys.argv[1]):
    body = json.loads(line).get("body") or {}
    for m in body.get("messages") or []:
        for c in (m.get("content") if isinstance(m.get("content"), list) else []):
            if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") == "toolu_disk_floor_reach_01":
                content = c.get("content")
                print(content if isinstance(content, str) else json.dumps(content)); sys.exit(0)
print("")' "$dir/requests.jsonl" 2>/dev/null || true)
  COST=$(grep -o 'PreToolUse:Bash.*finished with status [0-9]* ([0-9]* *ms)' "$dir/debug.log" 2>/dev/null | head -1 || true)
}

FAIL=0
check() { if eval "$2"; then say "  ok: $1"; else say "  FAILED: $1"; FAIL=1; fi; }

say "hook, floor raised:"
run hook "cargo build" 1000000
check "the request carrying the tool_result exists" '[ -n "$RESULT" ]'
check "the tool_result carries the floor's message" 'printf "%s" "$RESULT" | grep -q "below the 1000000 GB floor"'
check "cargo never ran" '[ -z "$MARKER" ]'
say "  tool_result: $(printf '%s' "$RESULT" | head -c 300)"

say "control, the hook removed from the clone's settings:"
run nohook "cargo build" 1000000 no-hook
check "cargo ran" '[ -n "$MARKER" ]'
check "the floor's message is absent" '! printf "%s" "$RESULT" | grep -q "GB floor"'

say "control, the floor at 0:"
run zero "cargo build" 0
check "cargo ran" '[ -n "$MARKER" ]'
say "  cost of cargo build above the floor: ${COST:-not found in the debug log}"

say "cost of a command the matcher ignores:"
run ignored "ls" 1000000
say "  ${COST:-not found in the debug log}"

[ "$FAIL" = 0 ] || die "the hook does not reach a session as it should"
say "PASS: the committed hook blocks cargo build below the floor in a real session, and nothing else does"

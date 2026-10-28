#!/usr/bin/env bash
# A Claude Code PreToolUse hook (matcher: Bash): the disk floor in front of every command that
# compiles. (#259)
#
# scripts/disk-floor.sh guarded only the gate, and the builds that fill target/ are the ones a
# session runs outside it. This reads the command Claude is about to run, and when it compiles
# (scripts/lib/disk-floor-match.py) measures the floor:
#
#   above it               the command runs, silently
#   below it               scripts/disk-sweep.sh removes what it judges safe (never whole profiles),
#                          keeping the worktree the session works in; then the floor is measured
#                          again, and only if the disk is still below it is the command blocked
#   cannot tell            the command runs, and a systemMessage says it was not guarded
#
# Exit 2 has one source, the block: an exit 2 refuses the command even under
# --dangerously-skip-permissions, so a stray one would refuse every Bash call in the session. A
# systemMessage is printed as JSON on stdout with exit 0, because Claude never sees a hook's stderr
# when it exits 0. Every removal is logged to ${XDG_STATE_HOME:-$HOME/.local/state}/backchannel/
# disk-sweep.log. On anything but Linux it does nothing: the floor reads GNU df.
#
# A guard against accidents, not a boundary: a command assembled at run time passes it.
set -uo pipefail

here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/backchannel
SWEEP_LOG=$STATE/disk-sweep.log
UNREADABLE="The disk floor could not read the free space, so this command runs without the floor's guard."

# A message for the session: at most 20 lines and 4000 characters, as Claude Code truncates a hook's
# systemMessage outside the user's own settings.
message() {
  python3 -I -c 'import json,sys
lines = sys.argv[1].split("\n")
if len(lines) > 20: lines = lines[:19] + ["- and %d more, all in the log" % (len(lines) - 19)]
text = "\n".join(lines)
if len(text) > 4000: text = text[:3990] + " [...]"
print(json.dumps({"systemMessage": text}))' "$1"
}
pass_with() { message "$1"; exit 0; }

[ "$(uname -s)" = Linux ] || exit 0

input=$(cat)
# Every command the matcher can catch names one of these words; the table's test holds that. Most Bash
# calls name none, and leave here without starting Python (measured: 158 ms a call with it, on 2.1.312).
PREFILTER='cargo|tauri|clean_run|clean_build|build-gpu|dev-gpu|stage2-core-check'
printf '%s' "$input" | grep -qE "$PREFILTER" || exit 0

verdict=$(printf '%s' "$input" | python3 -I "$here/lib/disk-floor-match.py" --hook 2>/dev/null) \
  || pass_with "The disk-floor hook's matcher failed, so this command runs unguarded."
case "$verdict" in
  skip) exit 0 ;;
  compiles$'\t'*) CWD=${verdict#compiles$'\t'} ;;
  error$'\t'*) pass_with "The disk-floor hook could not read its input (${verdict#error$'\t'}), so this command runs unguarded." ;;
  *) pass_with "The disk-floor hook's matcher answered '$verdict', so this command runs unguarded." ;;
esac

[ -x "$here/disk-floor.sh" ] || pass_with "The disk-floor hook found no scripts/disk-floor.sh beside it, so this command runs unguarded."

# The floor is measured where the command runs: its filesystems are the session's.
measure() { (cd "$CWD" 2>/dev/null || cd /; "$here/disk-floor.sh" --brief 2>&1); }
out=$(measure); rc=$?
below() { [ "$1" = 1 ] && printf '%s' "$2" | grep -q 'below the [0-9][0-9]* GB floor'; }
case "$rc" in
  0) exit 0 ;;
  3) pass_with "$UNREADABLE" ;;
esac
below "$rc" "$out" || pass_with "The disk floor failed (exit $rc), so this command runs unguarded: $out"

# Below the floor: sweep once, on this repository only, keeping the worktree the session works in.
REPO=${CLAUDE_PROJECT_DIR:-$(cd "$here/.." && pwd)}
sweep_out=$("$here/disk-sweep.sh" --repo "$REPO" --keep "$CWD" 2>&1); sweep_rc=$?
removed=$(printf '%s\n' "$sweep_out" | sed -n 's/^disk-sweep: removed //p')
if [ -n "$removed" ]; then
  mkdir -p "$STATE" && printf '%s\n' "$removed" | while IFS= read -r line; do
    printf '%s removed %s\n' "$(date -Iseconds)" "$line" >> "$SWEEP_LOG"
  done
fi
count=$(printf '%s' "$removed" | grep -c . || true)

out=$(measure); rc=$?
if below "$rc" "$out"; then
  {
    printf 'Blocked by the disk floor: %s\n' "${out#disk-floor: }"
    if [ "$count" -gt 0 ]; then printf 'The sweep removed %s item(s) first (logged in %s), and it was not enough.\n' "$count" "$SWEEP_LOG"
    elif [ "$sweep_rc" = 4 ]; then printf 'Another sweep had just run; nothing more was removed.\n'
    else printf 'The sweep found nothing it could safely remove.\n'; fi
    printf 'Run scripts/disk-floor.sh to see what is taking the space.\n'
  } >&2
  exit 2
fi
case "$rc" in
  0) ;;
  3) pass_with "$UNREADABLE" ;;
  *) pass_with "The disk floor failed after the sweep (exit $rc), so this command runs unguarded: $out" ;;
esac
[ "$count" -gt 0 ] || exit 0
total=$(printf '%s\n' "$removed" | sed -n 's/.*(\([0-9.]*[KMGT]\{0,1\}\)[B]\{0,1\})$/\1/p' | numfmt --from=iec 2>/dev/null | awk '{s+=$1} END {printf "%.1f GB", s/1e9}')
pass_with "The disk was below its floor, so the sweep removed $count item(s), $total in all, before this command ($SWEEP_LOG lists them):
$(printf '%s\n' "$removed" | sed 's/^/- /')"

#!/usr/bin/env bash
# Remove what engineering leaves behind, and cap the build caches. (#257)
#
# The disk the gate runs on is where the product owner records meetings. #248 bounded the kept Stage 2
# profiles; this bounds the other two things that filled it on 2026-10-27: worktrees of merged work
# (13 of 18 registered, removed by hand) and Cargo's target/ directories (29 GiB and 19 GiB), which
# Cargo never prunes.
#
#   disk-sweep.sh [--dry-run] [--profiles] [--keep <path>] [--repo <dir>]
#
# 1. A registered worktree of this repository is removed when it is done: not the main worktree, not
#    locked, not holding $CLAUDE_PROJECT_DIR, its HEAD a commit reachable from the local origin/main,
#    no commit that only its HEAD's reflog holds, nothing untracked, nothing ignored outside what a
#    build regenerates, nothing written for 24 hours, and no process working inside it. Anything else
#    keeps it, and the reason is printed. A check that cannot be made keeps it too.
# 2. Each distinct target/ that carries Cargo's CACHEDIR.TAG is held under BC_TARGET_CAP_GB. Over it,
#    a target loses every */incremental/, then every AppImage but the newest, then -- only with
#    --profiles, which only Stage 1 entry 2 passes, before any build -- whole profiles, least
#    recently written first. Only whole directories go: a build script's out/ file deleted alone can
#    leave Cargo trusting an output that is gone. A profile whose Cargo lock is held is not touched,
#    and the sweep holds the locks while it deletes there. Nor is one a process runs a file from,
#    works in or holds open: a test binary `cargo test` runs, or a bundler, holds no Cargo lock.
#
# Every removal is printed with its size. --dry-run prints and removes nothing.
#
# --keep <path> keeps the worktree holding <path>, as $CLAUDE_PROJECT_DIR's is kept; --repo <dir>
# acts on the repository holding <dir> rather than the working directory's (the disk-floor hook,
# #259, runs in a session's cwd). A real run holds an exclusive lock on
# ${XDG_STATE_HOME:-$HOME/.local/state}/backchannel/disk-sweep.lock, so the gate's sweep and a hook's
# in another session never run at once. One that finds it held waits, then exits 4 without sweeping:
# the other run has just swept, and the caller measures again.
set -uo pipefail

DRY=""; PROFILES=""; KEEP=""; REPO=${BC_SWEEP_REPO:-.}
usage() { echo "usage: disk-sweep.sh [--dry-run] [--profiles] [--keep <path>] [--repo <dir>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --profiles) PROFILES=1 ;;
    --keep) [ $# -ge 2 ] || usage; KEEP=$2; shift ;;
    --repo) [ $# -ge 2 ] || usage; REPO=$2; shift ;;
    *) usage ;;
  esac
  shift
done
say() { printf 'disk-sweep: %s\n' "$*" >&2; }
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib/target-cap-default.sh"
CAP=${BC_TARGET_CAP_BYTES:-$(( ${BC_TARGET_CAP_GB:-$TARGET_CAP_DEFAULT_GB} * 1000000000 ))}
# The signature is the generic cache-directory one: pipx, uv and fontconfig write it too. Cargo's own
# second line is what makes a target/ a target.
CACHEDIR_SIGNATURE='Signature: 8a477f597d28d172789f06886806bc55'
CACHEDIR_CARGO='# This file is a cache directory tag created by cargo.'
LOCKS=(.cargo-lock .cargo-build-lock .cargo-artifact-lock)
verb=$([ -n "$DRY" ] && echo "would remove" || echo "removed")
size_of() { du -sxh -- "$1" 2>/dev/null | cut -f1; }

# The repository to act on: the one holding the working directory, or --repo / BC_SWEEP_REPO. Every
# repository-level command goes through it, so the sweep can run from outside every worktree.
g() { git -C "$REPO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || { say "not inside a checkout of this repository"; exit 1; }

if [ -z "$DRY" ]; then
  LOCKDIR=${XDG_STATE_HOME:-$HOME/.local/state}/backchannel
  mkdir -p "$LOCKDIR" || { say "cannot create $LOCKDIR for the sweep's lock"; exit 1; }
  exec {SWEEP_LOCK}>"$LOCKDIR/disk-sweep.lock" || { say "cannot open the sweep's lock"; exit 1; }
  if ! flock -n "$SWEEP_LOCK"; then
    say "another sweep is running; waiting for it"
    flock "$SWEEP_LOCK"
    say "it has finished; not sweeping again, so measure again"
    exit 4
  fi
fi

# ---- 1. worktrees that are done --------------------------------------------------------------------

# What a build or the gate regenerates, by path prefix. On 2026-10-27, Stage 1 and Stage 2's builds
# left exactly these in a fresh worktree (#257), and every one is ignored. So this list is read for
# ignored paths only: an untracked path is somebody's work even where a build writes, such as the
# gen/android a `tauri android init` creates beside gen/schemas.
regenerated() {
  case "$1" in
    target|target/*|node_modules|node_modules/*|frontend/node_modules|frontend/node_modules/*) return 0 ;;
    frontend/.next/*|frontend/out/*|frontend/storybook-static/*|frontend/src-tauri/binaries/*) return 0 ;;
    frontend/src-tauri/gen/schemas/*|frontend/tsconfig.tsbuildinfo|frontend/next-env.d.ts) return 0 ;;
    __pycache__/*|*/__pycache__/*) return 0 ;;
  esac
  return 1
}

# The first reason a worktree is not done, or nothing.
why_kept() {
  local w=$1 line path pid cwd head lost st
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    case "$(readlink -f -- "$CLAUDE_PROJECT_DIR")/" in "$w"/*) echo "it holds \$CLAUDE_PROJECT_DIR"; return ;; esac
  fi
  if [ -n "$KEEP" ]; then
    case "$(readlink -f -- "$KEEP")/" in "$w"/*) echo "it holds $KEEP, which the caller keeps"; return ;; esac
  fi
  g rev-parse -q --verify refs/remotes/origin/main >/dev/null || { echo "there is no local origin/main to judge it by"; return; }
  head=$(git -C "$w" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || { echo "its HEAD is no commit"; return; }
  g merge-base --is-ancestor "$head" refs/remotes/origin/main 2>/dev/null || { echo "its HEAD is not in origin/main"; return; }
  # A commit its HEAD once held and no branch, tag or remote holds lives only in this worktree's reflog,
  # and goes with it. The second --not makes the reflog's commits the positive side.
  lost=$(git -C "$w" log -g --format=%H HEAD 2>/dev/null | sort -u \
    | xargs -r git -C "$w" rev-list -n 1 --not --branches --tags --remotes --not 2>/dev/null) \
    || { echo "its HEAD's reflog could not be read"; return; }
  [ -n "$lost" ] && { echo "its HEAD's reflog holds ${lost:0:12}, which no branch, tag or remote holds"; return; }
  st=$(git -C "$w" status --porcelain=v1 --untracked-files=all --ignored 2>/dev/null) || { echo "git status failed in it"; return; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path=${line:3}; path=${path%/}
    case "${line:0:2}" in
      '!!') regenerated "$path" || regenerated "$path/" || { echo "it holds !! $path, which no build regenerates"; return; } ;;
      '??') echo "it holds ?? $path, which nobody has added"; return ;;
      *) echo "a tracked file changed: $path"; return ;;
    esac
  done <<< "$st"
  path=$(find "$w" -mindepth 1 \( -name .git -o -name target -o -name node_modules -o -name __pycache__ \
           -o -path "$w/frontend/.next" -o -path "$w/frontend/out" -o -path "$w/frontend/storybook-static" \
           -o -path "$w/frontend/src-tauri/binaries" -o -path "$w/frontend/src-tauri/gen/schemas" \
           -o -path "$w/frontend/tsconfig.tsbuildinfo" -o -path "$w/frontend/next-env.d.ts" \) -prune \
           -o -newermt '24 hours ago' -print -quit 2>/dev/null)
  [ -n "$path" ] && { echo "${path#"$w"/} was written in the last 24 hours"; return; }
  for pid in /proc/[0-9]*; do
    cwd=$(readlink -f -- "$pid/cwd" 2>/dev/null) || continue
    case "$cwd/" in "$w"/*) echo "process ${pid#/proc/} works in it"; return ;; esac
  done
}

first=1
while IFS= read -r line; do
  case "$line" in
    "worktree "*) w=$(readlink -f -- "${line#worktree }" 2>/dev/null || printf '%s' "${line#worktree }"); locked=""; prunable=""; seen=1 ;;
    locked*) locked=1 ;;
    prunable*) prunable=1 ;;
    "")
      [ -n "${seen:-}" ] || continue; seen=""
      if [ -n "$first" ]; then first=""; continue; fi        # the main worktree
      [ -n "$locked" ] && continue                            # git refuses it, and so does this
      if [ -n "$prunable" ] || [ ! -d "$w" ]; then
        say "$verb the registration of $w, whose directory is gone"
        [ -z "$DRY" ] && g worktree prune
        continue
      fi
      reason=$(why_kept "$w")
      if [ -n "$reason" ]; then say "kept $w: $reason"; continue; fi
      say "$verb $w ($(size_of "$w"))"
      # Without --force, so git refuses on its own a worktree that gained untracked work since the check.
      [ -z "$DRY" ] && { err=$(g worktree remove "$w" 2>&1) || say "could not remove $w: $err"; }
      ;;
  esac
done < <(g worktree list --porcelain; echo)

# ---- 2. the cap on target/ -----------------------------------------------------------------------

bytes_of() { du -sxB1 -- "$1" 2>/dev/null | cut -f1; }

# Every distinct target/, once, by its resolved path.
targets=()
while IFS= read -r line; do
  case "$line" in "worktree "*)
    t=$(readlink -f -- "${line#worktree }/target" 2>/dev/null) || continue
    [ -d "$t" ] || continue
    case " ${targets[*]-} " in *" $t "*) ;; *) targets+=("$t") ;; esac ;;
  esac
done < <(g worktree list --porcelain)

for t in "${targets[@]+"${targets[@]}"}"; do
  if ! grep -qxF "$CACHEDIR_SIGNATURE" "$t/CACHEDIR.TAG" 2>/dev/null || ! grep -qxF "$CACHEDIR_CARGO" "$t/CACHEDIR.TAG"; then
    say "left $t alone: it has no Cargo CACHEDIR.TAG"; continue
  fi
  [ "$(bytes_of "$t")" -le "$CAP" ] && continue
  # Profiles: a directory directly under target/, or under a target triple, that Cargo locks.
  profiles=()
  while IFS= read -r p; do profiles+=("$p"); done < <(
    for l in "${LOCKS[@]}"; do find "$t" -mindepth 2 -maxdepth 3 -name "$l" -printf '%h\n'; done | sort -u)
  # Ranked before anything is removed: deleting incremental/ resets a directory's mtime.
  declare -A newest=()
  for p in "${profiles[@]+"${profiles[@]}"}"; do
    newest[$p]=$(find "$p" -type f ! -name '.cargo-*lock' -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
  done
  # The newest AppImage, which no step removes.
  keep_app=$(find "$t" -path '*/release/bundle/*' -name '*.AppImage' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)

  # Hold every lock of a profile, or report it busy. The descriptors stay open until close_locks.
  held=()
  take_locks() {
    local p=$1 l fd
    for l in "${LOCKS[@]}"; do
      [ -e "$p/$l" ] || continue
      exec {fd}<"$p/$l"
      if ! flock -n "$fd"; then exec {fd}<&-; close_locks; return 1; fi
      held+=("$fd")
    done
  }
  close_locks() { local fd; for fd in "${held[@]+"${held[@]}"}"; do exec {fd}<&-; done; held=(); }
  # What is left. A real run measures it again after every removal: a hard-linked file frees nothing
  # until its last path goes, and a removal can fail. A dry run removes nothing, so it counts down,
  # never counting a path twice, a path under one it counted, or what it counted under a path again.
  # Its one blind spot is the hard link, which it counts at each path: it can stop an entry before
  # the real run. On 2026-10-27 the shared target held 82-85 MB of hard links (#257).
  remaining=$(bytes_of "$t")
  over() { [ "$remaining" -gt "$CAP" ]; }
  planned=(); declare -A counted=()
  remove() {
    local n q
    for q in "${planned[@]+"${planned[@]}"}"; do case "$1" in "$q"|"$q"/*) return 0 ;; esac; done
    n=$(bytes_of "$1"); n=${n:-0}
    for q in "${planned[@]+"${planned[@]}"}"; do case "$q" in "$1"/*) n=$(( n - ${counted[$q]:-0} )) ;; esac; done
    planned+=("$1"); counted[$1]=$n
    say "$verb $1 ($(size_of "$1"))"
    if [ -n "$DRY" ]; then remaining=$(( remaining - n )); return 0; fi
    rm -rf -- "$1" || say "could not remove all of $1"
    remaining=$(bytes_of "$t"); remaining=${remaining:-0}
  }
  # A process whose executable, working directory or an open file is at or under a path.
  in_use() {
    local pat hit
    pat=$(printf '%s' "$1" | sed 's/[][*?\\]/\\&/g')
    hit=$(find /proc/[0-9]*/exe /proc/[0-9]*/cwd /proc/[0-9]*/fd -maxdepth 1 \( -lname "$pat" -o -lname "$pat/*" \) -print -quit 2>/dev/null)
    [ -n "$hit" ] || return 1
    hit=${hit#/proc/}; echo "${hit%%/*}"
  }
  profile_of() { local p; for p in "${profiles[@]+"${profiles[@]}"}"; do case "$1" in "$p"/*) echo "$p"; return ;; esac; done; }
  # Empty a directory of everything but the lock files at a profile's top and the kept AppImage with
  # its .built-from, walking down only the path that leads to the AppImage.
  empty_except() {
    local d=$1 e
    while IFS= read -r -d '' e; do
      over || return 0
      case "${e##*/}" in .cargo-lock|.cargo-build-lock|.cargo-artifact-lock) [ "${e%/*}" = "$top" ] && continue ;; esac
      if [ -n "$keep_app" ]; then
        [ "$e" = "$keep_app" ] || [ "$e" = "$keep_app.built-from" ] && continue
        case "$keep_app" in "$e"/*) empty_except "$e"; continue ;; esac
      fi
      remove "$e"
    done < <(find "$d" -mindepth 1 -maxdepth 1 -print0 | sort -z)
  }

  # Step 1: incremental/.
  for p in "${profiles[@]+"${profiles[@]}"}"; do
    over || break
    [ -d "$p/incremental" ] || continue
    if take_locks "$p"; then remove "$p/incremental"; close_locks; else say "left $p alone: Cargo holds its lock"; fi
  done
  # Step 2: AppImages but the newest, each with its .built-from.
  while IFS= read -r a; do
    over || break
    [ -n "$a" ] && [ "$a" != "$keep_app" ] || continue
    if pid=$(in_use "$a"); then say "left $a alone: process $pid uses it"; continue; fi
    p=$(profile_of "$a")
    if [ -n "$p" ] && ! take_locks "$p"; then say "left $a alone: Cargo holds $p's lock"; continue; fi
    remove "$a"; [ -e "$a.built-from" ] && remove "$a.built-from"
    close_locks
  done < <(find "$t" -path '*/release/bundle/*' -name '*.AppImage' -type f 2>/dev/null | sort)
  # Step 3, only under --profiles: whole profiles, least recently written first.
  if [ -n "$PROFILES" ]; then
    # Read line by line: a path may hold a space.
    while IFS= read -r top; do
      over || break
      if pid=$(in_use "$top"); then say "left $top alone: process $pid uses it"; continue; fi
      if ! take_locks "$top"; then say "left $top alone: Cargo holds its lock"; continue; fi
      empty_except "$top"
      close_locks
    done < <(for q in "${profiles[@]+"${profiles[@]}"}"; do printf '%s %s\n' "${newest[$q]:-0}" "$q"; done | sort -n | cut -d' ' -f2-)
  fi
  unset newest counted
done
exit 0

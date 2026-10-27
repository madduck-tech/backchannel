#!/usr/bin/env bash
# Remove what engineering leaves behind, and cap the build caches. (#257)
#
# The disk the gate runs on is where the product owner records meetings. #248 bounded the kept Stage 2
# profiles; this bounds the other two things that filled it on 2026-10-27: worktrees of merged work
# (13 of 18 registered, removed by hand) and Cargo's target/ directories (29 GiB and 19 GiB), which
# Cargo never prunes.
#
#   disk-sweep.sh [--dry-run] [--profiles]
#
# 1. A registered worktree of this repository is removed when it is done: not the main worktree, not
#    locked, not holding $CLAUDE_PROJECT_DIR, its HEAD reachable from the local origin/main, nothing
#    untracked or ignored outside what a build regenerates, nothing written for 24 hours, and no
#    process working inside it. Anything else keeps it, and the reason is printed.
# 2. Each distinct target/ that carries Cargo's CACHEDIR.TAG is held under BC_TARGET_CAP_GB. Over it,
#    a target loses every */incremental/, then every AppImage but the newest, then -- only with
#    --profiles, which only Stage 1 entry 2 passes, before any build -- whole profiles, least
#    recently written first. Only whole directories go: a build script's out/ file deleted alone can
#    leave Cargo trusting an output that is gone. A profile whose Cargo lock is held is not touched,
#    and the sweep holds the locks while it deletes there.
#
# Every removal is printed with its size. --dry-run prints and removes nothing.
set -uo pipefail

DRY=""; PROFILES=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --profiles) PROFILES=1 ;;
    *) echo "usage: disk-sweep.sh [--dry-run] [--profiles]" >&2; exit 2 ;;
  esac
done
say() { printf 'disk-sweep: %s\n' "$*" >&2; }
here=$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib/target-cap-default.sh"
CAP=${BC_TARGET_CAP_BYTES:-$(( ${BC_TARGET_CAP_GB:-$TARGET_CAP_DEFAULT_GB} * 1000000000 ))}
CACHEDIR_SIGNATURE='Signature: 8a477f597d28d172789f06886806bc55'
LOCKS=(.cargo-lock .cargo-build-lock .cargo-artifact-lock)
verb=$([ -n "$DRY" ] && echo "would remove" || echo "removed")
size_of() { du -sxh -- "$1" 2>/dev/null | cut -f1; }

# The repository to act on: the one holding the working directory, or BC_SWEEP_REPO. Every repository-
# level command goes through it, so the sweep can run from outside every worktree.
REPO=${BC_SWEEP_REPO:-.}
g() { git -C "$REPO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || { say "not inside a checkout of this repository"; exit 1; }

# ---- 1. worktrees that are done --------------------------------------------------------------------

# What a build or the gate regenerates, by path prefix. On 2026-10-27, Stage 1 and Stage 2's builds
# left exactly these in a fresh worktree (#257). Anything else, untracked or ignored, is somebody's.
regenerated() {
  case "$1" in
    target|target/*|node_modules|node_modules/*|frontend/node_modules|frontend/node_modules/*) return 0 ;;
    frontend/.next/*|frontend/out/*|frontend/storybook-static/*|frontend/src-tauri/binaries/*) return 0 ;;
    frontend/src-tauri/gen/*|frontend/tsconfig.tsbuildinfo|frontend/next-env.d.ts) return 0 ;;
    __pycache__/*|*/__pycache__/*) return 0 ;;
  esac
  return 1
}

# The first reason a worktree is not done, or nothing.
why_kept() {
  local w=$1 line path pid cwd
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    case "$(readlink -f -- "$CLAUDE_PROJECT_DIR")/" in "$w"/*) echo "it holds \$CLAUDE_PROJECT_DIR"; return ;; esac
  fi
  g rev-parse -q --verify refs/remotes/origin/main >/dev/null || { echo "there is no local origin/main to judge it by"; return; }
  g merge-base --is-ancestor "$(git -C "$w" rev-parse HEAD)" refs/remotes/origin/main 2>/dev/null \
    || { echo "its HEAD is not in origin/main"; return; }
  while IFS= read -r line; do
    path=${line:3}; path=${path%/}
    case "${line:0:2}" in
      '??'|'!!') regenerated "$path" || regenerated "$path/" || { echo "it holds ${line:0:2} $path, which no build regenerates"; return; } ;;
      *) echo "a tracked file changed: $path"; return ;;
    esac
  done < <(git -C "$w" status --porcelain=v1 --untracked-files=all --ignored 2>/dev/null)
  path=$(find "$w" -mindepth 1 \( -name .git -o -name target -o -name node_modules -o -name __pycache__ \
           -o -path "$w/frontend/.next" -o -path "$w/frontend/out" -o -path "$w/frontend/storybook-static" \
           -o -path "$w/frontend/src-tauri/binaries" -o -path "$w/frontend/src-tauri/gen" \
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
      [ -z "$DRY" ] && { g worktree remove --force "$w" 2>/dev/null || say "could not remove $w"; }
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
  if ! grep -qxF "$CACHEDIR_SIGNATURE" "$t/CACHEDIR.TAG" 2>/dev/null; then
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
  # What is left, counted down as things go, so a dry run stops where a real one would.
  remaining=$(bytes_of "$t")
  over() { [ "$remaining" -gt "$CAP" ]; }
  # A dry run removes nothing, so it remembers what it would have removed, and never counts a path
  # twice, or a path under one it already counted.
  planned=()
  remove() {
    local n q
    for q in "${planned[@]+"${planned[@]}"}"; do case "$1" in "$q"|"$q"/*) return 0 ;; esac; done
    planned+=("$1")
    n=$(bytes_of "$1"); remaining=$(( remaining - ${n:-0} ))
    say "$verb $1 ($(size_of "$1"))"; [ -n "$DRY" ] || rm -rf -- "$1"
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
    p=$(profile_of "$a")
    if [ -n "$p" ] && ! take_locks "$p"; then say "left $a alone: Cargo holds $p's lock"; continue; fi
    remove "$a"; [ -e "$a.built-from" ] && remove "$a.built-from"
    close_locks
  done < <(find "$t" -path '*/release/bundle/*' -name '*.AppImage' -type f 2>/dev/null | sort)
  # Step 3, only under --profiles: whole profiles, least recently written first.
  if [ -n "$PROFILES" ]; then
    for top in $(for q in "${profiles[@]+"${profiles[@]}"}"; do printf '%s %s\n' "${newest[$q]:-0}" "$q"; done | sort -n | cut -d' ' -f2-); do
      over || break
      if ! take_locks "$top"; then say "left $top alone: Cargo holds its lock"; continue; fi
      empty_except "$top"
      close_locks
    done
  fi
  unset newest
done
exit 0

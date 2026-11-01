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
# The signature is the generic cache-directory one: pipx, uv and fontconfig write it too. Cargo's own
# second line is what makes a target/ a target.
CACHEDIR_SIGNATURE='Signature: 8a477f597d28d172789f06886806bc55'
CACHEDIR_CARGO='# This file is a cache directory tag created by cargo.'
LOCKS=(.cargo-lock .cargo-build-lock .cargo-artifact-lock)
verb=$([ -n "$DRY" ] && echo "would remove" || echo "removed")
size_of() { du -sxh -- "$1" 2>/dev/null | cut -f1; }

# The repository to act on: the one holding the working directory, or BC_SWEEP_REPO. Every repository-
# level command goes through it, so the sweep can run from outside every worktree.
REPO=${BC_SWEEP_REPO:-.}
# Where processes are listed: /proc, or a fixture's stand-in. An empty listing proves nothing is running, so
# every check that reads it keeps what it judges (#257, round 8).
PROC=${BC_SWEEP_PROC:-/proc}
procs_listed() { compgen -G "$PROC/[0-9]*" >/dev/null; }
g() { git -C "$REPO" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || { say "not inside a checkout of this repository"; exit 1; }

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
  local w=$1 line path pid cwd head lost st reflog frc
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    case "$(readlink -f -- "$CLAUDE_PROJECT_DIR")/" in "$w"/*) echo "it holds \$CLAUDE_PROJECT_DIR"; return ;; esac
  fi
  g rev-parse -q --verify refs/remotes/origin/main >/dev/null || { echo "there is no local origin/main to judge it by"; return; }
  head=$(git -C "$w" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || { echo "its HEAD is no commit"; return; }
  g merge-base --is-ancestor "$head" refs/remotes/origin/main 2>/dev/null || { echo "its HEAD is not in origin/main"; return; }
  # `git log -g` exits 0 with no output when the reflog cannot be read, or sits behind a logs/ directory that
  # cannot be searched (measured, git 2.43.0), so the file itself must be a readable regular file.
  reflog=$(git -C "$w" rev-parse --path-format=absolute --git-path logs/HEAD 2>/dev/null) \
    && [ -f "$reflog" ] && [ -r "$reflog" ] || { echo "its HEAD's reflog could not be read"; return; }
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
           -o -newermt '24 hours ago' -print -quit 2>/dev/null); frc=$?
  [ -n "$path" ] && { echo "${path#"$w"/} was written in the last 24 hours"; return; }
  # A directory nobody can open: git status only warns about it, and git worktree remove would leave it behind.
  [ "$frc" -eq 0 ] || { echo "a directory under it could not be read, so nothing shows it idle"; return; }
  procs_listed || { echo "no process is listed in $PROC, so nothing shows it idle"; return; }
  # An entry it cannot read is skipped: another user's process, or a non-dumpable one (a stated blind spot).
  for pid in "$PROC"/[0-9]*; do
    cwd=$(readlink -f -- "$pid/cwd" 2>/dev/null) || continue
    case "$cwd/" in "$w"/*) echo "process ${pid#"$PROC"/} works in it"; return ;; esac
  done
}

# Whether a process works inside a worktree, for the cap's other-worktree rule. Its caller checks the listing first.
busy_in() {
  local w=$1 pid cwd
  for pid in "$PROC"/[0-9]*; do
    cwd=$(readlink -f -- "$pid/cwd" 2>/dev/null) || continue
    case "$cwd/" in "$w"/*) return 0 ;; esac
  done
  return 1
}

# Two passes: conditions 1-7 judge every worktree first, then condition 8 keeps the last link to a target outside
# every checkout, from this run's judgements alone, so --dry-run keeps the same one as the live run (#257).
first=1; done_wts=(); kept_wts=(); all_wts=()
while IFS= read -r line; do
  case "$line" in
    "worktree "*) w=$(readlink -f -- "${line#worktree }" 2>/dev/null || printf '%s' "${line#worktree }"); locked=""; prunable=""; seen=1 ;;
    locked*) locked=1 ;;
    prunable*) prunable=1 ;;
    "")
      [ -n "${seen:-}" ] || continue; seen=""
      all_wts+=("$w")
      if [ -n "$first" ]; then first=""; kept_wts+=("$w"); main_wt=$w; continue; fi        # the main worktree
      [ -n "$locked" ] && { kept_wts+=("$w"); continue; }     # git refuses it, and so does this
      if [ -n "$prunable" ] || [ ! -d "$w" ]; then
        say "$verb the registration of $w, whose directory is gone"
        [ -z "$DRY" ] && g worktree prune
        continue
      fi
      reason=$(why_kept "$w")
      if [ -n "$reason" ]; then say "kept $w: $reason"; kept_wts+=("$w"); continue; fi
      done_wts+=("$w")
      ;;
  esac
done < <(g worktree list --porcelain; echo)

# A target's resolved path, if the worktree's `target` leads outside every registered worktree.
outside_target() {
  local t a
  [ -e "$1/target" ] || return 1
  t=$(readlink -f -- "$1/target" 2>/dev/null) || return 1
  for a in "${all_wts[@]+"${all_wts[@]}"}"; do case "$t/" in "$a"/*) return 1 ;; esac; done
  printf '%s\n' "$t"
}
anchors=(); declare -A anchored=()
for w in "${done_wts[@]+"${done_wts[@]}"}"; do
  t=$(outside_target "$w") || continue
  reached=""
  for k in "${kept_wts[@]+"${kept_wts[@]}"}" "${anchors[@]+"${anchors[@]}"}"; do
    [ "$(readlink -f -- "$k/target" 2>/dev/null)" = "$t" ] && { reached=1; break; }
  done
  [ -n "$reached" ] && continue
  anchors+=("$w"); anchored[$w]=1
  say "kept $w: it is the last link to $t ($(size_of "$t")), which nothing else would cap"
done
for w in "${done_wts[@]+"${done_wts[@]}"}"; do
  [ -n "${anchored[$w]:-}" ] && continue
  say "$verb $w ($(size_of "$w"))"
  # Without --force, so git refuses on its own a worktree that gained untracked work since the check.
  [ -z "$DRY" ] && { err=$(g worktree remove "$w" 2>&1) || say "could not remove $w: $err"; }
done

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
  # Why a path is in use, if it is: a process whose executable, working directory or an open file is at or
  # under it. An empty process listing counts as in use: it proves nothing is running.
  in_use() {
    local pat hit
    procs_listed || { echo "no process is listed in $PROC"; return 0; }
    pat=$(printf '%s' "$1" | sed 's/[][*?\\]/\\&/g')
    hit=$(find "$PROC"/[0-9]*/exe "$PROC"/[0-9]*/cwd "$PROC"/[0-9]*/fd -maxdepth 1 \( -lname "$pat" -o -lname "$pat/*" \) -print -quit 2>/dev/null)
    [ -n "$hit" ] || return 1
    hit=${hit#"$PROC"/}; echo "process ${hit%%/*} uses it"
  }
  # A process working in another worktree whose `target` resolves here: one gate's Stage 1 entry 2 must not
  # empty a profile under another gate's run, between two test binaries, where Cargo holds no lock. The main
  # worktree is not judged (the agent and the IDE always work there; gates run in linked worktrees, by rule),
  # nor the worktree the sweep runs in.
  others_busy() {
    local a here
    here=$(readlink -f -- "$PWD")
    for a in "${all_wts[@]+"${all_wts[@]}"}"; do
      [ "$a" = "${main_wt:-}" ] && continue
      case "$here/" in "$a"/*) continue ;; esac
      [ "$(readlink -f -- "$a/target" 2>/dev/null)" = "$t" ] || continue
      procs_listed || { echo "no process is listed in $PROC, so nothing shows $a idle"; return 0; }
      if busy_in "$a"; then echo "a process works in $a, which links this target"; return 0; fi
    done
    return 1
  }
  stays=()
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
    done < <(find "$d" -mindepth 1 -maxdepth 1 -print0 | LC_ALL=C sort -z)
  }

  # Step 1: incremental/.
  for p in "${profiles[@]+"${profiles[@]}"}"; do
    over || break
    [ -d "$p/incremental" ] || continue
    if take_locks "$p"; then remove "$p/incremental"; close_locks; else say "left $p alone: Cargo holds its lock"; stays+=("Cargo holds $p's lock"); fi
  done
  # Step 2: AppImages but the newest, each with its .built-from.
  while IFS= read -r a; do
    over || break
    [ -n "$a" ] && [ "$a" != "$keep_app" ] || continue
    if why=$(in_use "$a"); then say "left $a alone: $why"; stays+=("$why"); continue; fi
    p=$(profile_of "$a")
    if [ -n "$p" ] && ! take_locks "$p"; then say "left $a alone: Cargo holds $p's lock"; stays+=("Cargo holds $p's lock"); continue; fi
    remove "$a"; [ -e "$a.built-from" ] && remove "$a.built-from"
    close_locks
  done < <(find "$t" -path '*/release/bundle/*' -name '*.AppImage' -type f 2>/dev/null | sort)
  # Step 3, only under --profiles: whole profiles, least recently written first.
  if [ -z "$PROFILES" ]; then
    over && stays+=("profiles are emptied only under --profiles")
  elif over && why=$(others_busy); then
    stays+=("$why")
  else
    # Read line by line: a path may hold a space.
    while IFS= read -r top; do
      over || break
      if why=$(in_use "$top"); then say "left $top alone: $why"; stays+=("$why"); continue; fi
      if ! take_locks "$top"; then say "left $top alone: Cargo holds its lock"; stays+=("Cargo holds $top's lock"); continue; fi
      empty_except "$top"
      close_locks
    done < <(for q in "${profiles[@]+"${profiles[@]}"}"; do printf '%s %s\n' "${newest[$q]:-0}" "$q"; done | sort -n | cut -d' ' -f2-)
  fi
  # A target still over the cap is named, with what kept it there.
  if over; then
    reasons=$(printf '%s\n' "${stays[@]+"${stays[@]}"}" | awk 'NF && !seen[$0]++' | paste -sd ';' - | sed 's/;/; /g')
    say "$t stays over the cap at $(size_of "$t"): ${reasons:-nothing more could be removed}"
  fi
  unset newest counted
done
exit 0

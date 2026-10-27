# Kept Stage 2 profiles keep their evidence, not their models (#248). Sourced, never executed.
#
# A pass that fails keeps its profile for inspection. Every pass seeds that profile with models
# copied from a cache (5.2 GB for stage2-core), and nothing removed a kept profile before
# systemd-tmpfiles' 30 days: on 2026-10-27, 38 of them held 57 GB, and the product owner's disk was
# at 99% the morning of a meeting they were to record. The model bytes are never the evidence; the
# logs, the driver log and the recording are.
#
# The caller supplies `say`; bash resolves it at call time, so each pass keeps its own prefix. Five of
# the passes run under `set -euo pipefail`, and so do the tests of this file.

# The bytes a file occupies, or 0.
kept_profile__size() { stat -c %s -- "$1" 2>/dev/null || echo 0; }

# kept_profile_strip <profile> — record every model file under the profile's app-data directories in
# `kept-models.txt`, then delete them, and print the bytes freed.
#
# Append-only: a second strip of the same profile (the prune strips the profiles it keeps, and one
# pass runs several times in a row) never rewrites a line already there. A profile with no model
# file left is not touched at all, so its manifest stays byte-identical.
kept_profile_strip() {
  local profile=$1 manifest list records="" freed=0 f size
  [ -d "$profile" ] || return 0
  if [ "${BC_KEEP_MODELS:-}" = 1 ]; then
    say "BC_KEEP_MODELS=1: the models in $profile are kept, with no manifest"
    return 0
  fi
  manifest="$profile/kept-models.txt"
  # Every `models/` directly under an app-data directory, whichever identifier wrote it: an older
  # build keeps its models under `com.conversationaly.ai`.
  list=$(find "$profile"/home/.local/share/*/models -type f 2>/dev/null | sort) || true
  [ -n "$list" ] || return 0
  while IFS= read -r f; do
    size=$(kept_profile__size "$f")
    records+=$(printf '%s\t%s\t%s\t%s' "${f#"$profile"/}" "$size" "$(stat -c %.9Y -- "$f" 2>/dev/null)" \
      "$(sha256sum -- "$f" 2>/dev/null | cut -d' ' -f1)")$'\n'
    freed=$((freed + size))
  done <<< "$list"
  # One write per run, appended: what an earlier run recorded is never rewritten. On a full disk
  # the write can fail, and the files are what frees it, so they go anyway and the list goes to
  # the log instead.
  printf '%s' "$records" >> "$manifest" || { say "could not write $manifest; the models removed were:"; printf '%s' "$records" >&2; }
  while IFS= read -r f; do rm -f -- "$f"; done <<< "$list"
  say "stripped $freed bytes of models from $profile; kept-models.txt lists them"
}

# kept_profile_lock <profile> — hold `flock` on <profile>/.lock for as long as this shell runs, so a
# concurrent prune can tell a live profile from a kept one. File descriptor 9 is this file's.
kept_profile_lock() {
  : > "$1/.lock" || return 1
  exec 9> "$1/.lock" && flock -n 9
}

# The newest mtime of anything in a tree, in seconds. A directory's own mtime records when a run
# created it, not whether files under it are still being written (measured 2026-10-27).
# A maximum rather than `sort | head`: head closing the pipe early is a SIGPIPE, and a pass under
# `set -eo pipefail` would die of it in a profile with enough files.
kept_profile__newest() { { find "$1" -printf '%T@\n' 2>/dev/null || true; } | awk '$1 > m { m = $1 } END { printf "%d\n", m }'; }

# kept_profile_keep_count <script-name> [gopnik.json] — how many kept profiles of a pass to keep: two, or the
# number of Stage 2 entries in gopnik.json that run that script, if more. A gate run in which three
# onboarding modes fail must not lose the first one's logs before the verdict is written.
kept_profile_keep_count() {
  local n gopnik=${2:-$(dirname -- "${BASH_SOURCE[0]}")/../../gopnik.json}
  n=$(python3 -I -c '
import json, re, sys
stage2 = json.load(open(sys.argv[2]))["verification"]["stage2"]
# The script by its path, so stage2-record-check.sh never counts stage2-ui-record-check.sh.
print(sum(1 for c in stage2 if re.search(r"(^|[ /])" + re.escape(sys.argv[1]) + r"\b", c)))' "$1" "$gopnik" 2>/dev/null) || n=0
  [ "${n:-0}" -gt 2 ] 2>/dev/null && echo "$n" || echo 2
}

# kept_profile_prune <root> <kind> <keep> — remove kept profiles of one kind, all but the newest
# <keep>, and strip the ones it keeps. It considers only directories this user owns, that are not
# symlinks, and that are named exactly `backchannel-<kind>.` plus six characters, so `stage2` never
# matches `stage2-audio`. It skips a profile whose lock is held, and one with no lock file in which
# anything was written in the last hour. It prints every path it removed or stripped, with its size.
kept_profile_prune() {
  local root=$1 kind=$2 keep=$3 now cutoff d newest candidates=() sorted kept=0
  now=$(date +%s); cutoff=$((now - 3600))
  for d in "$root"/backchannel-"$kind".??????; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] || continue
    case "${d##*/}" in "backchannel-$kind".??????) ;; *) continue ;; esac
    if [ -e "$d/.lock" ]; then
      flock -n "$d/.lock" true 2>/dev/null || continue
    else
      newest=$(kept_profile__newest "$d")
      [ "${newest:-0}" -ge "$cutoff" ] && continue
    fi
    candidates+=("$(kept_profile__newest "$d") $d")
  done
  [ "${#candidates[@]}" -gt 0 ] || return 0
  sorted=$(printf '%s\n' "${candidates[@]}" | sort -rn | cut -d' ' -f2-)
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ "$kept" -lt "$keep" ]; then
      kept=$((kept + 1))
      kept_profile_strip "$d"
    else
      say "removed $d ($(du -sh -- "$d" 2>/dev/null | cut -f1)), an old kept profile of $kind"
      rm -rf -- "$d"
    fi
  done <<< "$sorted"
}

# seed_copy <source> <destination> — copy a pass's seed, unless the copy would leave less than the
# floor free (BC_DISK_FLOOR_GB, default as scripts/disk-floor.sh). It names the bytes needed, and
# returns the copy's own status, so a full disk stops the pass rather than failing it as something
# else (`stage2-core-check.sh` runs without `set -e`).
seed_copy() {
  local src=$1 dst=$2 need avail floor dir
  need=$(du -sb -- "$src" 2>/dev/null | cut -f1) || need=""
  [ -n "$need" ] || { say "cannot size the seed $src"; return 1; }
  dir=$dst; while [ ! -e "$dir" ]; do dir=$(dirname -- "$dir"); done
  avail=$(df --output=avail -B1 -- "$dir" 2>/dev/null | tail -1 | tr -d ' ') || avail=""
  [ -n "$avail" ] && [ "$avail" -eq "$avail" ] 2>/dev/null || { say "cannot read the free space under $dir"; return 1; }
  floor=$(( ${BC_DISK_FLOOR_GB:-20} * 1000000000 ))
  if [ $((avail - need)) -lt "$floor" ]; then
    say "refusing to seed $dst: it needs $need bytes, and would leave $((avail - need)) of a $floor-byte floor"
    return 1
  fi
  cp -a --reflink=auto -- "$src" "$dst" 2>/dev/null || cp -a -- "$src" "$dst"
}

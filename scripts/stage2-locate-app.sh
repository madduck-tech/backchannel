#!/usr/bin/env bash
# Resolve the AppImage a Stage 2 entry is about to observe, and prove it is the revision under test.
#
# #103. Five stage 2 entries each ran their own `ls -t target/release/bundle/appimage/*.AppImage`,
# and `test -x` was the only guard on the result. Measured on 2026-09-06 at HEAD 3ef8879: that
# expression selected a binary built at 11:53:35, **36 commits behind HEAD**, `test -x` passed it,
# entry 5 launched it, and the log reported `Application setup complete` with no panic. A full green
# launch pass against a revision nobody tested. Two builds from different commits also produce the
# same filename -- the bundle is named from `tauri.conf.json`'s version, `conversationaly_1.4.1_amd64`
# -- so `ls -t` falls through to mtime and a person reading the path sees nothing wrong.
#
# The guard for exactly this was already written and never wired: entry 4 did
# `git rev-parse HEAD > "$S2/expected-sha"`, and `grep -rn expected-sha` returned **one** occurrence,
# the write. Zero reads. Present, plausible and inert -- the `#[ignore]` defect in a different
# costume.
#
# Nothing in the binary carries a revision: `grep -rn -E 'CARGO_PKG_VERSION|GIT_SHA|vergen' src-tauri`
# is empty, and the startup log emits only "Starting application..." and "Application setup complete".
# So identity has to travel beside the file. It travels in a provenance file written at build time,
# and this script is the only thing that reads it. Not called a "sidecar": that word already means the
# llama-helper binary in this repository, and one word for two things is how a term stops carrying.
#
# Two paths, and which one was taken is always printed, because "it worked" must never be ambiguous
# about *what* worked:
#
#   * `BC_APPIMAGE=<path>` -- an artifact a person supplied, normally downloaded from
#     `stage2-artifact.yml`. This is the path `stage2-artifact.yml:10` and #43 have claimed exists
#     since they were written; it did not, because entry 5 read `$S2/app`, which only entry 4 wrote,
#     from its own `ls -t`.
#   * no override -- the newest local build, the historical behaviour, now checked rather than
#     trusted.
#
# Prints the resolved path on stdout and nothing else, so callers can `APP=$(...)`.
set -euo pipefail

say() { printf 'stage2-locate-app: %s\n' "$*" >&2; }
die() { printf 'stage2-locate-app: %s\n' "$*" >&2; exit 1; }

BUNDLE_DIR=${BC_BUNDLE_DIR:-target/release/bundle/appimage}

if [ -n "${BC_APPIMAGE:-}" ]; then
  APP=$BC_APPIMAGE
  SOURCE="supplied through BC_APPIMAGE"
else
  # `2>/dev/null` so the failure is this script's message rather than a bare glob error.
  #
  # shellcheck disable=SC2012  # "use find instead of ls"
  # Deliberate. `ls -t` is not a listing here, it is the semantic being preserved: "the newest local
  # build", which is what every entry did before #103 and what a person building locally expects.
  # `find -printf '%T@'` expresses it only with a sort and a cut, and the filenames are produced by
  # tauri from tauri.conf.json (conversationaly_1.4.1_amd64.AppImage) rather than by a user, so the
  # non-alphanumeric case the rule guards against cannot arise. Silenced with the reason rather than
  # left as a standing info finding nobody reads.
  APP=$(ls -t "$BUNDLE_DIR"/*.AppImage 2>/dev/null | head -1 || true)
  [ -n "$APP" ] || die "no AppImage in $BUNDLE_DIR and BC_APPIMAGE is unset. Build one, or download the
  artifact from stage2-artifact.yml and point BC_APPIMAGE at it."
  SOURCE="newest local build in $BUNDLE_DIR"
fi

[ -x "$APP" ] || die "$APP is not executable ($SOURCE)"

# --- the identity check, which is the whole point of this script ---------------------------------
#
# `BC_SKIP_IDENTITY=1` exists for one case and is loud about it: bisecting, where the tree is
# deliberately not the revision the binary was built from. It is not a way to make a red pass green.
EXPECTED=${BC_EXPECTED_SHA:-$(git rev-parse HEAD)}
PROVENANCE="$APP.built-from"

if [ "${BC_SKIP_IDENTITY:-}" = "1" ]; then
  say "IDENTITY CHECK SKIPPED by BC_SKIP_IDENTITY=1 -- this pass proves nothing about $EXPECTED"
elif [ ! -f "$PROVENANCE" ]; then
  die "$APP has no $PROVENANCE beside it, so nothing says which revision it was built from.
  A build older than #103 leaves none. Rebuild, or download an artifact that carries one.
  Refusing rather than assuming: assuming is what let a 36-commit-old binary pass a whole Stage 2."
else
  BUILT_FROM=$(tr -d '[:space:]' < "$PROVENANCE")
  if [ "$BUILT_FROM" != "$EXPECTED" ]; then
    BEHIND=$(git log --oneline "$BUILT_FROM..$EXPECTED" 2>/dev/null | wc -l || echo '?')
    die "the AppImage is not the revision under test.
  built from : $BUILT_FROM
  expected   : $EXPECTED
  distance   : $BEHIND commit(s) from the built revision to the expected one
  source     : $SOURCE
  Every observation after this one would have been made against the wrong binary."
  fi
fi

say "using $APP ($SOURCE), built from ${BUILT_FROM:-<identity skipped>}"
printf '%s\n' "$APP"

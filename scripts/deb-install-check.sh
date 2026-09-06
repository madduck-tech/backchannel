#!/usr/bin/env bash
# Does the .deb install and start on a machine that is not the one that built it? (#67, #5)
#
# This is the observation #5 could not be made without. That defect — `libopenblas.so.0` linked
# and undeclared — was found by hand, once, on a bundle somebody had to produce by hand first, and
# nothing could catch it again. The build runner has every build dependency installed, so
# installing there passes while the package is still broken: **the clean container is the whole
# point, not a detail of how it is run.**
#
# Unlike `headless-launch-probe.sh` this DOES fail. It is a check: a package that cannot be
# installed, or that installs and cannot start, is a release nobody should be able to cut.
#
# Usage: scripts/deb-install-check.sh <path/to/*.deb> [seconds-alive]

set -euo pipefail

DEB=$(readlink -f "${1:?usage: deb-install-check.sh <deb> [seconds]}")
ALIVE_FOR=${2:-20}
IMAGE=${DEB_CHECK_IMAGE:-ubuntu:24.04}

say() { printf '%s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

say "deb install check"
say "  package     $DEB"
say "  image       $IMAGE"
say "  alive-for   ${ALIVE_FOR}s"

command -v docker >/dev/null || die "docker is not available; this check needs a clean container"

# What the *package* declares, before anything is installed. Printed rather than asserted: the
# assertion is that the install works, and this is the evidence a reader needs to see why.
say ""
say "--- Depends, as the package declares them ---"
dpkg-deb -f "$DEB" Depends || true
say "--- DT_NEEDED of the binary inside ---"
WORK=$(mktemp -d /tmp/deb-check.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
dpkg-deb -x "$DEB" "$WORK/root"
BIN=$(find "$WORK/root/usr/bin" -maxdepth 1 -type f -name 'conversationaly*' | head -1)
[ -n "$BIN" ] || die "the package contains no usr/bin/conversationaly"
readelf -d "$BIN" | sed -n 's/.*NEEDED.*\[\(.*\)\]/  \1/p'

# The container gets the package and nothing else. `apt-get install ./file.deb` resolves and
# installs what Depends names — and only that, which is exactly the property under test.
say ""
say "--- installing in a clean $IMAGE ---"
docker run --rm -i \
  -v "$DEB:/tmp/app.deb:ro" \
  -v "$(readlink -f "$(dirname "$0")")/deb-install-check-inner.sh:/tmp/inner.sh:ro" \
  -e ALIVE_FOR="$ALIVE_FOR" \
  "$IMAGE" bash /tmp/inner.sh

say ""
say "PASSED: the package installs on a machine that did not build it, and the application starts."

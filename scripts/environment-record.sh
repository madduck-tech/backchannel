#!/usr/bin/env bash
# The environment a verification result was produced in (#42, ADR 0019).
#
# A gate verdict records what was run and not what it was run with. On 2026-09-05 the clippy
# adoption was verified locally at 0 findings and CI reported 35 on the identical tree, because
# "0 findings" was a property of rustc 1.96.1 and nobody had written that down. This prints the
# properties that have actually made two runs of one tree disagree in this repository.
#
# Three rules this script must keep, each because breaking it would defeat the purpose:
#
#   1. **It always exits 0.** It is a record, not a check. Half these tools are legitimately
#      absent on a CI runner -- there is no sound server, no display and no ffmpeg -- and a
#      record that dies there is a record for the one case that matters least.
#   2. **Absence is a value, not a silence.** `absent` is printed. A missing line and a tool
#      that is missing must not look the same, which is the shape of #10.
#   3. **One `key<space>value` per line, keys stable.** The point is that a local record and a
#      CI record can be diffed. Anything that reorders or reformats per host breaks that.
#
# Deliberately not here: anything that makes a *decision*. It never compares, never fails, and
# never writes a file. Comparing two records is a person's job and the workflow says so.

set -u

line() { printf '%-16s %s\n' "$1" "$2"; }

# `command -v` rather than `which`: it is a shell builtin, so it needs nothing installed to
# report that nothing is installed.
have() { command -v "$1" >/dev/null 2>&1; }

# First line of a --version, whitespace-collapsed, or `absent`.
version_of() {
  local bin=$1; shift
  have "$bin" || { printf 'absent'; return; }
  "$bin" "$@" 2>/dev/null | head -1 | tr -s '[:space:]' ' ' | sed 's/ $//' || printf 'unreadable'
}

echo "backchannel environment record v1"

line os "$(uname -srm)"
if [ -r /etc/os-release ]; then
  line distro "$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}")"
else
  line distro absent
fi

# --- the Rust side ---------------------------------------------------------------------
line rustc "$(version_of rustc --version)"
line cargo "$(version_of cargo --version)"
line clippy "$(version_of cargo-clippy --version)"
# The pin as written, next to the toolchain actually in use. ADR 0018 exists because those
# two were different and nothing said so. `test.yml` hardcodes the same number in a third
# place (#41), so a three-way disagreement is possible and this makes two thirds of it visible.
if [ -r rust-toolchain.toml ]; then
  line toolchain-pin "$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml | head -1)"
else
  line toolchain-pin absent
fi
# `show active-toolchain`, not `default`: with a `rust-toolchain.toml` in the tree those two
# disagree -- `default` says `stable`, the active one says 1.98.1 -- and the active one is what
# produced every number below it.
line rustup-active "$(have rustup && rustup show active-toolchain 2>/dev/null | head -1 | cut -d' ' -f1 || printf absent)"

# --- the JavaScript side ---------------------------------------------------------------
line node "$(version_of node --version)"
# Run from the repository root, so corepack resolves frontend/package.json's packageManager
# pin the way `pnpm test` does. Outside that directory this machine answers 9.15.0 and inside
# it 11.25.0, and the second is the one every measurement in this repository is made with.
if have pnpm; then
  line pnpm "$( (cd frontend 2>/dev/null && pnpm --version 2>/dev/null | head -1) || pnpm --version 2>/dev/null | head -1)"
else
  line pnpm absent
fi

# --- the host facts that have changed an outcome ---------------------------------------
# ffmpeg is here because its absence changes which code path a test takes, not because it is
# interesting: see #29, where local and CI ran different code under one test name for three
# wrong diagnoses.
line ffmpeg "$(have ffmpeg && command -v ffmpeg || printf absent)"
line ffmpeg-version "$(version_of ffmpeg -version)"

# Stage 2 only, and absent in CI by definition. Recorded because every audio observation this
# repository has ever made depended on them and no verdict has ever named a version (#43).
# These two print their own name on line 1 and the version on line 2 ("Compiled with
# libpipewire 1.0.5"), so the generic reader above would record the word "pipewire" as a
# version -- present-looking and useless. Take the last field of the Compiled-with line.
sound_version() {
  have "$1" || { printf 'absent'; return; }
  "$1" --version 2>/dev/null | sed -n 's/^Compiled with lib[a-z]* //p' | head -1 | tr -d '\n' \
    || printf 'unreadable'
}
line pipewire "$(sound_version pipewire)"
line wireplumber "$(sound_version wireplumber)"
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  line display "wayland ${WAYLAND_DISPLAY}"
elif [ -n "${DISPLAY:-}" ]; then
  line display "x11 ${DISPLAY}"
else
  line display none
fi

line ci "${CI:-no}"

exit 0

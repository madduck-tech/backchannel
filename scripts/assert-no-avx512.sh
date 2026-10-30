#!/usr/bin/env bash
# Fails a Linux build if the ggml CPU backend was not compiled at the portable x86 floor: AVX2, and
# nothing above it. The Linux counterpart of assert-no-avx512.ps1. (#289)
#
# ggml turns GGML_NATIVE on by default, which is -march=native on the build machine. A GitHub runner
# may have AVX-512; on 2026-10-29 a Stage 2 artifact built on one died with an invalid opcode at
# ggml_cpu_init on a laptop without it, and the next artifact of the same workflow, built on another
# runner, had none. The fix is TRANSCRIBE_CMAKE_ARGS=-DGGML_NATIVE=OFF on the build; this asserts it
# took, because the build succeeds either way, and every check CI runs afterwards runs on the machine
# that built it.
#
# Asserted against each CMakeCache.txt, as the Windows script does, and every cache is judged on its
# own: CMake's option() never overwrites a cached value, so a tree configured NATIVE once keeps every
# instruction-set tier OFF when the flag arrives later, and would build a scalar-only backend.
#
# An above-floor option is on when its value is not one of CMake's false constants, whatever its type:
# -DGGML_AVX512=1 is cached as GGML_AVX512:BOOL=1, and if() takes the branch for it. The compile flags
# ggml-cpu was built with are read too, because CFLAGS and CXXFLAGS reach them past every option.
#
# Run from anywhere in the repository; it reads target/ at the repository's root. Exit 0 only when at
# least one cache defines GGML_NATIVE and every such cache passes.
set -uo pipefail
say() { printf 'assert-no-avx512: %s\n' "$*"; }
fail() { printf 'assert-no-avx512: %s\n' "$*" >&2; FAILED=1; }

TOP=$(git rev-parse --show-toplevel 2>/dev/null) || { say "not inside the repository"; exit 1; }
cd "$TOP" || exit 1
say "build host: $(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo 2>/dev/null | head -1); avx512f: $(grep -qw avx512f /proc/cpuinfo 2>/dev/null && echo yes || echo no)"

shopt -s nullglob
trees=(target/release/build/transcribe-cpp-sys-*/out target/*/release/build/transcribe-cpp-sys-*/out)
[ ${#trees[@]} -gt 0 ] || { say "no transcribe-cpp-sys build tree under $TOP/target - verified nothing"; exit 1; }
caches=()
for t in "${trees[@]}"; do
  say "tree: $t"
  while IFS= read -r -d '' c; do caches+=("$c"); done < <(find "$t" -name CMakeCache.txt -print0 2>/dev/null)
done
[ ${#caches[@]} -gt 0 ] || { say "no CMakeCache.txt under the build trees - verified nothing"; exit 1; }

FAILED=""; checked=0
for c in "${caches[@]}"; do
  if ! grep -q '^GGML_NATIVE:' "$c"; then say "passed over, it defines no GGML_NATIVE: $c"; continue; fi
  checked=$((checked + 1))
  flags="$(dirname "$c")/ggml/src/CMakeFiles/ggml-cpu.dir/flags.make"
  if [ -f "$flags" ]; then
    say "$c: compile flags: $(grep -o -E -- '-m[a-z0-9=_.-]+' "$flags" | sort -u | tr '\n' ' ')"
    bad=$(grep -o -E -- '-march=[a-z0-9_.-]+|-mavx512[a-z0-9]*|-mavxvnni[a-z0-9]*|-mamx[a-z0-9-]*' "$flags" \
      | grep -v -x -E -- '-march=x86-64(-v[23])?' | sort -u | tr '\n' ' ')
    [ -z "$bad" ] || fail "COMPILE FLAGS: $flags: ${bad}- ggml-cpu was compiled for more than the floor, past its options (CFLAGS or CXXFLAGS?)"
  else
    fail "COMPILE FLAGS: no ggml-cpu flags.make beside $c, so the flags it was compiled with were not read"
  fi
  grep -q '^GGML_NATIVE:BOOL=OFF$' "$c" \
    || fail "NATIVE: $c: $(grep '^GGML_NATIVE:' "$c") - ggml was configured against the build machine's CPU, and a binary from this build dies with an invalid opcode on a CPU without what that machine has"
  grep -q '^GGML_AVX2:BOOL=ON$' "$c" \
    || fail "AVX2: $c: $(grep '^GGML_AVX2:' "$c" || echo 'no GGML_AVX2 entry') - the CPU backend is below the AVX2 floor. Either the tree was configured NATIVE before (locally: cargo clean --release -p transcribe-cpp-sys; in CI: bump the rust-cache key), or SOURCE_DATE_EPOCH was set for the build (unset it, then the same clean: the OFF it produced is cached)"
  above=""
  while IFS= read -r line; do
    val=${line#*=}
    case "${val^^}" in 0|OFF|NO|FALSE|N|IGNORE|NOTFOUND|''|*-NOTFOUND) ;; *) above+="$line " ;; esac
  done < <(grep -E '^GGML_(AVX512[A-Z0-9_]*|AVX_VNNI|AMX_[A-Z0-9_]+):[A-Z]+=' "$c")
  [ -z "$above" ] || fail "ABOVE THE FLOOR: $c: ${above}- a binary from this build dies with an invalid opcode on a CPU without them"
done
[ "$checked" -gt 0 ] || { say "no CMakeCache.txt defines GGML_NATIVE - verified nothing"; exit 1; }
[ -z "$FAILED" ] || exit 1
say "OK: $checked cache(s), each with GGML_NATIVE=OFF, GGML_AVX2=ON and nothing above the floor"

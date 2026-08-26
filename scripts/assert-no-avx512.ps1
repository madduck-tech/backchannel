#!/usr/bin/env pwsh
# Fails the build if AVX-512 reached the ggml compile line.
#
# transcribe-cpp-sys does not set GGML_NATIVE, so ggml used to default it ON.
# On MSVC that pulls in FindSIMD.cmake, which *runs* AVX probes on the build
# machine — a GitHub Xeon runner has AVX-512, an Alder Lake laptop does not,
# and the shipped app died with 0xC000001D at the first transcription. The fix
# is TRANSCRIBE_CMAKE_ARGS=-DGGML_NATIVE=OFF in the workflow env; this asserts
# it actually took, because the build succeeds either way and only the user's
# machine notices the difference.

$ErrorActionPreference = 'Stop'

$trees = @(Get-ChildItem -Directory -ErrorAction SilentlyContinue `
    -Path "target/*/release/build/transcribe-cpp-sys-*/out", "target/release/build/transcribe-cpp-sys-*/out")
if (-not $trees) { throw "no transcribe-cpp-sys build tree found - the guard verified nothing" }

$hits = $trees |
    ForEach-Object { Get-ChildItem -Path $_.FullName -Recurse -Include *.vcxproj, *.rsp, CMakeCache.txt -ErrorAction SilentlyContinue } |
    Select-String -Pattern 'arch:AVX512', 'AVX512_FOUND:BOOL=TRUE'
if ($hits) {
    $hits | ForEach-Object { Write-Host "$($_.Path): $($_.Line.Trim())" }
    throw "ggml built with AVX-512 - this binary would die with 0xC000001D on any CPU without it"
}

# Same failure mode in reverse: CMake's option() keeps whatever a restored
# CMakeCache.txt holds, so a stale cache can leave GGML_AVX2 at the OFF it got
# while NATIVE was ON, and quietly ship a scalar-only CPU backend.
$avx2 = $trees |
    ForEach-Object { Get-ChildItem -Path $_.FullName -Recurse -Include *.vcxproj, *.rsp -ErrorAction SilentlyContinue } |
    Select-String -Pattern 'arch:AVX2' | Select-Object -First 1
if (-not $avx2) { throw "ggml built without /arch:AVX2 - stale CMake cache? bump the rust-cache key" }

Write-Host "OK: /arch:AVX2, no AVX-512 ($($trees.Count) build tree(s) checked)"

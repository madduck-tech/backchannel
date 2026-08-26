#!/usr/bin/env pwsh
# Fails the Windows build if the ggml CPU backend was not compiled at the
# portable x86 floor (/arch:AVX2, no AVX-512).
#
# transcribe-cpp-sys does not set GGML_NATIVE, so ggml used to default it ON.
# On MSVC that pulls in FindSIMD.cmake, which *runs* AVX probes on the build
# machine — a GitHub Xeon runner has AVX-512, an Alder Lake laptop does not,
# and the shipped app died with 0xC000001D at the first transcription. The fix
# is TRANSCRIBE_CMAKE_ARGS=-DGGML_NATIVE=OFF in the workflow env; this asserts
# it took, because the build succeeds either way and only a user's machine
# notices. The AVX2 half matters just as much: CMake's option() keeps whatever
# a restored CMakeCache.txt holds, so a stale cache can pin GGML_AVX2 to the
# OFF it got while NATIVE was ON and quietly ship a scalar-only backend.

$ErrorActionPreference = 'Stop'

$trees = @(Get-ChildItem -Directory -ErrorAction SilentlyContinue `
    -Path "target/*/release/build/transcribe-cpp-sys-*/out", "target/release/build/transcribe-cpp-sys-*/out")
if (-not $trees) { throw "no transcribe-cpp-sys build tree found - the guard verified nothing" }

# \\?\ + IgnoreInaccessible: the cmake tree nests far past MAX_PATH (the -sys
# crate builds through a junction for exactly that reason), and Get-ChildItem
# drops those subtrees on the floor.
$opts = [System.IO.EnumerationOptions]::new()
$opts.RecurseSubdirectories = $true
$opts.IgnoreInaccessible = $true

$files = @()
foreach ($tree in $trees) {
    Write-Host "tree: $($tree.FullName)"
    try {
        $files += [System.IO.Directory]::EnumerateFiles("\\?\$($tree.FullName)", "*", $opts)
    } catch {
        Write-Host "  enumeration failed: $($_.Exception.Message)"
    }
}

$compileLines = @($files | Where-Object { $_ -match '\.(vcxproj|rsp)$' -or $_ -match 'CMakeCache\.txt$' })
Write-Host "$($files.Count) file(s) in tree, $($compileLines.Count) compile-line file(s) to inspect"

$hits = @($compileLines | Select-String -Pattern 'arch:AVX512', 'AVX512_FOUND:BOOL=TRUE')
if ($hits) {
    $hits | ForEach-Object { Write-Host "$($_.Path): $($_.Line.Trim())" }
    throw "ggml built with AVX-512 - this binary would die with 0xC000001D on any CPU without it"
}

$avx2 = @($compileLines | Select-String -Pattern 'arch:AVX2')
if (-not $avx2) {
    Write-Host "top-level entries under each tree:"
    $trees | ForEach-Object { Get-ChildItem $_.FullName -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.FullName)" } }
    throw "no /arch:AVX2 in any compile line - either GGML_AVX2 is off, or the build tree the guard can see does not contain the compile lines (so it verified nothing)"
}

Write-Host "OK: /arch:AVX2 present ($($avx2.Count) hit(s)), no AVX-512"

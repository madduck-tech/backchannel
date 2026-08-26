#!/usr/bin/env pwsh
# Fails the Windows build if the ggml CPU backend was not compiled at the
# portable x86 floor: AVX2, never AVX-512.
#
# transcribe-cpp-sys does not set GGML_NATIVE, so ggml used to default it ON.
# On MSVC that pulls in FindSIMD.cmake, which *runs* AVX probes on the build
# machine — a GitHub Xeon runner has AVX-512, an Alder Lake laptop does not,
# and the shipped app died with 0xC000001D at the first transcription. The fix
# is TRANSCRIBE_CMAKE_ARGS=-DGGML_NATIVE=OFF in the workflow env; this asserts
# it took, because the build succeeds either way and only a user's machine
# notices.
#
# Asserted against CMakeCache.txt rather than the compile line: cache entries
# are generator-independent, while /arch: reaches the compile line differently
# per generator (the VS generator maps it to the MSBuild property
# EnableEnhancedInstructionSet rather than passing the flag through).

$ErrorActionPreference = 'Stop'

$trees = @(Get-ChildItem -Directory -ErrorAction SilentlyContinue `
    -Path "target/*/release/build/transcribe-cpp-sys-*/out", "target/release/build/transcribe-cpp-sys-*/out")
if (-not $trees) { throw "no transcribe-cpp-sys build tree found - the guard verified nothing" }

# \\?\ + IgnoreInaccessible: the cmake tree nests far past MAX_PATH (the -sys
# crate builds through a junction for exactly that reason), and Get-ChildItem
# drops those subtrees on the floor. The prefix is stripped again because the
# PowerShell providers below do not accept it.
$opts = [System.IO.EnumerationOptions]::new()
$opts.RecurseSubdirectories = $true
$opts.IgnoreInaccessible = $true

$files = @()
foreach ($tree in $trees) {
    Write-Host "tree: $($tree.FullName)"
    try {
        $files += [System.IO.Directory]::EnumerateFiles("\\?\$($tree.FullName)", "*", $opts) |
            ForEach-Object { $_ -replace '^\\\\\?\\', '' }
    } catch {
        Write-Host "  enumeration failed: $($_.Exception.Message)"
    }
}

$caches = @($files | Where-Object { $_ -match 'CMakeCache\.txt$' })
if (-not $caches) { throw "no CMakeCache.txt under the build tree - the guard verified nothing" }
Write-Host "$($files.Count) file(s) in tree, $($caches.Count) CMakeCache.txt"

# Evidence, printed either way: what the compile lines actually ended up with.
# Best-effort only - a compile line nested past MAX_PATH is unreadable here and
# is not what the assertions below rely on.
$compileLines = @($files | Where-Object { $_ -match '\.(vcxproj|rsp)$' })
if ($compileLines) {
    Select-String -LiteralPath $compileLines -ErrorAction SilentlyContinue `
        -Pattern 'EnableEnhancedInstructionSet>[^<]*', 'arch:AVX\w*' |
        ForEach-Object { $_.Matches.Value } | Sort-Object -Unique |
        ForEach-Object { Write-Host "  instruction set: $_" }
}

$bad = @(Select-String -LiteralPath $caches -Pattern 'GGML_NATIVE:BOOL=ON', 'AVX512_FOUND:BOOL=TRUE', 'GGML_AVX512:BOOL=ON')
if ($bad) {
    $bad | ForEach-Object { Write-Host "$($_.Path): $($_.Line.Trim())" }
    throw "ggml was configured against the build machine's CPU - a binary from this build dies with 0xC000001D on any CPU without AVX-512"
}

if (-not @(Select-String -LiteralPath $caches -Pattern 'GGML_NATIVE:BOOL=OFF')) {
    throw "no GGML_NATIVE entry in any CMakeCache.txt - TRANSCRIBE_CMAKE_ARGS did not reach cmake, or ggml changed its option name"
}

# CMake's option() never overwrites an existing cache entry, so a restored
# CMakeCache.txt can pin GGML_AVX2 to the OFF it got while NATIVE was ON and
# quietly ship a scalar-only CPU backend.
if (-not @(Select-String -LiteralPath $caches -Pattern 'GGML_AVX2:BOOL=ON')) {
    Select-String -LiteralPath $caches -Pattern 'GGML_AVX2:BOOL=' | ForEach-Object { Write-Host "$($_.Path): $($_.Line.Trim())" }
    throw "GGML_AVX2 is not ON - stale CMake cache? bump the rust-cache key"
}

Write-Host "OK: GGML_NATIVE=OFF, GGML_AVX2=ON, no AVX-512"

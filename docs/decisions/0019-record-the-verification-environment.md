# ADR 0019: a verification result carries the environment that produced it

Date: 2026-09-05

Status: accepted. Extends [ADR 0016](0016-quality-cycle-tests-and-red-first.md)'s quality cycle with a
  sixth rule, and completes the half of [ADR 0018](0018-adopt-clippy.md) that pinning the Rust
  toolchain closed only for Rust.

## Context

Dated facts, each with the command that produced it.

1. **The occurrence.** 2026-09-05, #36. The clippy adoption was verified locally at **0** findings,
   exit 0, and the verdict said `91 → 0`. CI reported **35 errors** on the identical tree —
   `redundant reference in info!/error!/format! argument`, a lint the local compiler does not emit.
   Local rustc was **1.96.1**; CI's `dtolnay/rust-toolchain@stable` had moved to **1.98.1**. Nothing
   about the code differed. The gate ran every command it was configured to run, every one passed,
   and the verdict was still false — because "0 findings" was a property of a compiler nobody had
   written down.

2. **It was not the only one that day.** #29 spent three wrong diagnoses on a flake whose whole
   mechanism was that `command -v ffmpeg` answers `/usr/bin/ffmpeg` on a developer machine and
   nothing on a runner, so local and CI executed **different code paths under one test name**. A
   record naming ffmpeg's presence would have made that visible on the first look instead of the
   fourth. #32's device-enumeration hang is a third, still unexplained, in a layer — PipeWire,
   WirePlumber, the display server — that no verdict has ever named a version of.

3. **The skews that remained after ADR 0018.** `test.yml` set `node-version: '22'`; the machine every
   Stage 1 and Stage 2 measurement in this repository has been made on runs **v24.14.0**. `pnpm` was
   provisioned as `version: 11` — floating within the major — while corepack held a developer to
   `frontend/package.json`'s `packageManager: pnpm@11.25.0`. Both were read from the files.

4. **`gopnik.json` stage 1 was ten command strings and recorded nothing about the machine.** A verdict
   pastes their output. So a verdict is a claim about a repository and its evidence is a claim about a
   laptop, and nothing in the format made the difference visible.

## Decision

1. **`scripts/environment-record.sh` prints the environment**, and is the first entry of
   `gopnik.json` stage 1 and a step of its own in `test.yml`. It records the OS and distribution,
   rustc/cargo/clippy, the `rust-toolchain.toml` pin **next to** the active toolchain, node, pnpm,
   ffmpeg's presence *and* path, PipeWire, WirePlumber, the display server, and `$CI`.

2. **It always exits 0, and absence is printed as `absent`.** It is a record, not a check. Half of
   what it reports is legitimately missing on a runner — no sound server, no display, no ffmpeg — and
   a record that fails there is a record for the case that matters least. Printing `absent` also
   keeps a missing tool distinguishable from a missing line, which is the defect shape of #10.

3. **One `key value` per line, keys stable**, so two records diff. Anything that reorders or
   reformats per host defeats the only purpose the file has.

4. **Where drift can be removed instead of recorded, it is removed.** `.nvmrc` holds the Node version
   and `test.yml` reads it with `node-version-file` rather than repeating a literal; pnpm is
   provisioned at the exact `11.25.0` that `packageManager` pins. `lint-step-is-enforced.test.mjs`
   asserts both, and that `.nvmrc` names an exact version rather than a major — a major floats, which
   is precisely what `version: 11` was doing.

5. **A `READY` verdict on an executable change carries the record.** Rule 6 of the quality cycle in
   `docs/development-workflow.md`. **Honesty-based, and said so**: no tool parses a verdict, exactly
   as with rules 1–5.

6. **What is enforced is that the command is *configured on both sides*** — present in `gopnik.json`
   stage 1 and run as a step in `test.yml`, with no `continue-on-error`, no `if`, and no `|| true`.
   `lint-step-is-enforced.test.mjs` holds it, which widens that file from "lint commands" to "commands
   CI and the gate must agree on". **It does not enforce that anybody compared two records**, and this
   ADR says so rather than letting a green check read as closure.

## Consequences

- Stage 1 is 11 commands, the first of which is the record. A verdict that pastes stage 1 output now
  contains its own environment whether or not the author thought about it, which is the point:
  rule 6 is honesty-based, but the *evidence* for it arrives by construction.
- The Node skew is closed: CI provisions 24.14.0 from `.nvmrc`, the version every measurement in this
  repository was already being made on. The pnpm skew is closed at 11.25.0. Both are now held by a
  test, so the next person to write a literal into `test.yml` gets a red check rather than a verdict
  about the wrong runtime six weeks later.
- **Not bought, and named so the absence stays a decision:** nothing compares two records; nothing
  refuses a verdict that omits one; PipeWire, WirePlumber and the display server are *recorded* and
  never *controlled*, because they are facts about a host and a repository cannot pin them. Stage 2
  still runs nowhere but one machine, which is #43 and not this.
- The record makes one thing visible that was previously invisible and is not fixed here: `test.yml`
  hardcodes `toolchain: 1.98.1` as a literal rather than reading `rust-toolchain.toml`, so the pin
  lives in two places. The record prints both, so a disagreement shows up in the evidence. Closing it
  properly is #41's problem, because #41 adds two more copies of that literal.

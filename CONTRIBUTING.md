# Contributing to Backchannel

Backchannel is a meeting copilot that records, transcribes and summarises meetings on your own machine: a Tauri desktop app with a Rust core and a Next.js interface. This file covers the mechanics.

**What is normative lives elsewhere, and wins over this file:**
- [`docs/development-workflow.md`](docs/development-workflow.md): the cycles, approval gates and definition of done.
- [`docs/decisions/README.md`](docs/decisions/README.md): every accepted decision (ADR).
- [`CLAUDE.md`](CLAUDE.md) and the rules in `.claude/rules/`: the hard rules every change follows, for people and agents alike.

## Getting started

1. Clone the repository. `main` is the only long-lived branch, and it always builds. The one
   exception is `exp/virtual-audio`, the virtual audio experiment (ADR 0033).
   ```bash
   git clone https://github.com/madduck-tech/backchannel.git
   cd backchannel
   ```
2. Install the toolchain and the system packages for your platform: [`docs/BUILDING.md`](docs/BUILDING.md).
3. Run the app in development:
   ```bash
   cd frontend
   pnpm install
   pnpm run tauri:dev
   ```

[`docs/codebase-guide.md`](docs/codebase-guide.md) explains how the code is laid out: the audio pipeline, live transcription, the Tauri command and event pattern, and the summary sidecar. Read it before working on any of them.

## Working with a coding agent

The repository carries the same instructions for three agents. `.claude/` is the one source; what Codex and opencode read is generated from it.

| | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| **Instructions it loads** | `CLAUDE.md`, plus `.claude/rules/workflow.md` and `testing.md` | the root `AGENTS.md` | the root `AGENTS.md` |
| **Rules for specific paths** (design, docs, platform code) | loaded on their own when a matching file is read | listed in `AGENTS.md`'s index: open the rule before you read or edit what it governs | the same |
| **Work an issue through the whole cycle** | `/work 42` | `$work 42` | `/work 42` |
| **Run the critic on an issue first** | `/critique 42` | `$critique 42` | `/critique 42` |
| **Turn a discussion into an issue** | `/issue` | `$issue …`, only when named | `/issue …`, after asking you |

**Start an agent at the repository's root.** A session started in `frontend/` misses the root's instructions. Codex reads `frontend/AGENTS.md` too, which is Next.js's own.

**Changing the instructions:**
- Edit `CLAUDE.md`'s "read this first" section, the files in `.claude/rules/`, `.claude/skills/` or `.claude/commands/`.
- Then run `node scripts/gen-agent-files.mjs`. It rewrites `AGENTS.md`, `.agents/skills/`, `.opencode/command/` and `opencode.json`.
- Never edit those by hand. `pnpm test` fails when they drift from their sources, and the generator refuses to delete a file it did not write.
- The gopnik skills (`.claude/skills/gopnik*`) stay identical to upstream [madduck-tech/gopnik](https://github.com/madduck-tech/gopnik); changes to them go there.
- What each agent receives, file by file, is in [`docs/agent-harness-matrix.md`](docs/agent-harness-matrix.md).

## How a change is made

Every change that executes goes through one cycle. [`docs/development-workflow.md`](docs/development-workflow.md) is the full text, and `/work N` (`$work N` in Codex) walks it.

1. **An issue says what would settle it:** the observation that decides whether the change worked.
2. **A critic attacks the issue before work starts.** The issue gets the `ready` label when it holds.
3. **If the change touches the UI,** prototype variants are approved by the product owner first.
4. **Stage 0:** the behaviour matrix is posted on the issue, before the first commit.
5. **The work is done on a branch from `main`** (from `exp/virtual-audio` for that experiment's steps, ADR 0033).
   - A bug starts with a test shown red on the unfixed code.
   - A feature ships with controls: break the behaviour on purpose, show the test going red, restore.
   - The rules are in `.claude/rules/testing.md`.
6. **The gate is run:** the commands in [`gopnik.json`](gopnik.json), Stage 1 and then Stage 2, with the verdict posted on the issue.
   - Stage 2 drives the built app on Linux, with a display and a PipeWire session. On `exp/virtual-audio` it is the experiment's macOS instrument (ADR 0033).
   - Its last passes play speech through the default output, so keep the machine quiet while it runs.
7. **The pull request says `Closes #N`, links the verdict, and is merged once CI is green.** Into `exp/virtual-audio` it says `Refs #N` and the issue is closed by hand after the merge (ADR 0033).

**Documentation-only changes** skip the gate, but still go through a pull request, because CI must pass before `main` accepts a commit.

## Commits

- Conventional commits: `feat|fix|docs|design|refactor|test|chore|ci(scope): subject`.
- **Everything in the repository is in English:** code, comments, commit messages, issues and pull requests (ADR 0010).
- A commit an agent wrote ends with a `Co-Authored-By:` trailer naming the model.

## Tests

```bash
cd frontend && pnpm test && pnpm typecheck && pnpm lint
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

These are the first entries of Stage 1. The rest, including the tests that open real audio devices, are listed in `gopnik.json`.

## Releases

Every release has the same shape (ADR 0031):
- it is built by `release.yml` from `main`, as a pre-release while the version is `0.x`;
- the same seven files, with `SHA256SUMS`;
- notes written from [`docs/release-notes-template.md`](docs/release-notes-template.md).

Publishing is the product owner's call.

## License

By contributing, you agree that your contributions are licensed under the project's MIT License.

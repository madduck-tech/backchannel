#!/usr/bin/env node
// Point git at .githooks/, so the pre-commit hook regenerates the agent files. (#271, ADR 0033)
//
// `prepare` in frontend/package.json runs this on `pnpm install`, through node rather than a shell
// line, because pnpm runs scripts with cmd.exe on Windows. It never fails an install, and it leaves
// things alone, saying why, when there is no git work tree (an unpacked tarball), when core.hooksPath
// already points elsewhere, or when the hooks directory holds hooks of its own, which a hooksPath
// would silently stop. pnpm skips `prepare` when an install is already up to date, so an existing
// clone runs `pnpm run prepare` once (CONTRIBUTING.md).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const say = (m) => console.log(`install-git-hooks: ${m}`);
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
// This repository's root: the work tree must be this one, not one this tree was unpacked into.
const mine = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

try {
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    say('not in a git work tree; nothing to install');
  } else if (fs.realpathSync(git('rev-parse', '--show-toplevel').stdout.trim()) !== mine) {
    say(`not this repository's work tree (git's is ${git('rev-parse', '--show-toplevel').stdout.trim()}); nothing to install`);
  } else {
    const current = git('config', '--get', 'core.hooksPath').stdout.trim();
    // `--git-path hooks` is right in a linked worktree, where .git is a file.
    const hooks = git('rev-parse', '--path-format=absolute', '--git-path', 'hooks').stdout.trim();
    const own = hooks && fs.existsSync(hooks) ? fs.readdirSync(hooks).filter((n) => !n.endsWith('.sample')) : [];
    if (current === '.githooks') say('core.hooksPath is already .githooks');
    else if (current) say(`core.hooksPath is ${current}; leaving it, so .githooks/pre-commit does not run`);
    else if (own.length) say(`${hooks} has hooks of its own (${own.join(', ')}); leaving core.hooksPath unset, so they keep running`);
    else if (git('config', 'core.hooksPath', '.githooks').status === 0) say('core.hooksPath set to .githooks');
    else say('could not set core.hooksPath; the pre-commit hook will not run');
  }
} catch (e) {
  say(`skipped: ${e.message}`);
}

#!/usr/bin/env node
// Refresh scripts/gopnik-upstream.lock.json from upstream gopnik. (#233, #249)
//
// The gopnik skills stay identical to upstream; changes go upstream, not here. The lock records the
// git blob id of every file under upstream's plugins/gopnik/skills/ at one tag, and
// frontend/tests/lib/gopnik-stays-upstreams.test.mjs holds .agents/skills/gopnik* and their
// .claude/ copies to it, reading only the lock, so the suite never needs the network.
//
// Usage: node scripts/refresh-gopnik-lock.mjs [tag]   (default: the lock's own tag)
//
// To take a new upstream release: copy its skills into .agents/skills/, which is their source since
// #271 (ADR 0033), run this with the new tag, then run scripts/gen-agent-files.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'gopnik-upstream.lock.json');
const old = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : {};
const repository = old.repository ?? 'https://github.com/madduck-tech/gopnik';
const prefix = old.path ?? 'plugins/gopnik/skills/';
const tag = process.argv[2] ?? old.tag;
if (!tag) { console.error('refresh-gopnik-lock: name a tag'); process.exit(2); }

const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gopnik-upstream-'));
try {
  const git = (...a) => execFileSync('git', ['-C', bare, ...a], { encoding: 'utf8' });
  git('init', '-q', '--bare');
  git('fetch', '-q', '--depth', '1', repository, `refs/tags/${tag}:refs/tags/${tag}`);
  const files = {};
  for (const line of git('ls-tree', '-r', tag, prefix).trim().split('\n')) {
    const [meta, file] = line.split('\t');
    files[file.slice(prefix.length)] = meta.split(' ')[2];
  }
  fs.writeFileSync(LOCK, `${JSON.stringify({
    comment: 'Written by scripts/refresh-gopnik-lock.mjs; never edit by hand. Git blob ids at the tag, LF line endings. (#233)',
    repository, tag, path: prefix, files,
  }, null, 2)}\n`);
  console.log(`refresh-gopnik-lock: ${Object.keys(files).length} files at ${tag}`);
} finally {
  fs.rmSync(bare, { recursive: true, force: true });
}

// The gopnik skills stay identical to upstream, in both places a harness reads them. (#233, #249)
//
// The product owner's decision of 2026-10-27: gopnik is not edited here, changes go upstream. The
// skills live in .claude/skills/ for Claude Code and are copied to .agents/skills/ for Codex and
// opencode, so an edit to either is a fork nobody decided on. This test reads only
// scripts/gopnik-upstream.lock.json, the git blob id of every file under upstream's
// plugins/gopnik/skills/ at one tag, and never the network; scripts/refresh-gopnik-lock.mjs writes it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'gopnik-upstream.lock.json'), 'utf8'));

// A git blob id, from the file's bytes with CRLF folded to LF, as git stores a Windows checkout.
function blobId(file) {
  const body = Buffer.from(fs.readFileSync(file).toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test('the lock is upstream gopnik at a tag, ten files today', () => {
  assert.equal(lock.repository, 'https://github.com/madduck-tech/gopnik');
  assert.equal(lock.path, 'plugins/gopnik/skills/');
  assert.match(lock.tag, /^v\d+\.\d+\.\d+$/);
  assert.equal(Object.keys(lock.files).length, 10, 'upstream v6.0.0 has ten files under plugins/gopnik/skills/');
});

for (const root of ['.claude/skills', '.agents/skills']) {
  test(`${root}/gopnik* is upstream's, file for file`, () => {
    const dir = path.join(repo, root);
    const ours = fs.readdirSync(dir).filter((n) => n.startsWith('gopnik'))
      .flatMap((n) => walk(path.join(dir, n))).map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
    assert.deepEqual(ours, Object.keys(lock.files).sort(), `${root} holds a different set of gopnik files than upstream ${lock.tag}`);
    for (const f of ours) {
      assert.equal(blobId(path.join(dir, f)), lock.files[f],
        `${root}/${f} differs from upstream gopnik ${lock.tag}. Gopnik changes go upstream (#233); to take a new release, see scripts/refresh-gopnik-lock.mjs.`);
    }
  });
}

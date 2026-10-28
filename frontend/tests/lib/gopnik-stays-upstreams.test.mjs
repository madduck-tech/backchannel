// The gopnik skills stay identical to upstream, in both places a harness reads them. (#233, #249)
//
// The product owner's decision of 2026-10-27: gopnik is not edited here, changes go upstream. The
// skills live in .agents/skills/ for Codex and opencode and are copied to .claude/skills/ for Claude
// Code (#271, ADR 0033), so an edit to either is a fork nobody decided on. This test reads only
// scripts/gopnik-upstream.lock.json, the git blob id of every file under upstream's
// plugins/gopnik/skills/ at one tag, and never the network; scripts/refresh-gopnik-lock.mjs writes it.
// It holds both what is checked out and what is staged: a CRLF blob committed with core.autocrlf off
// folds to the right text on disk and is still not upstream's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'gopnik-upstream.lock.json'), 'utf8'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

// A git blob id, from the file's bytes with CRLF folded to LF, as git stores a Windows checkout.
function blobId(bytes) {
  const body = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

test('the lock is upstream gopnik at a tag, ten files today', () => {
  assert.equal(lock.repository, 'https://github.com/madduck-tech/gopnik');
  assert.equal(lock.path, 'plugins/gopnik/skills/');
  assert.match(lock.tag, /^v\d+\.\d+\.\d+$/);
  assert.equal(Object.keys(lock.files).length, 10, 'upstream v6.0.0 has ten files under plugins/gopnik/skills/');
});

for (const root of ['.claude/skills', '.agents/skills']) {
  test(`${root}/gopnik* is upstream's, file for file, on disk and in the index`, () => {
    const listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', root).split('\0').filter(Boolean);
    const ours = [...new Set(listed)].filter((f) => /^[^/]+\/[^/]+\/gopnik[^/]*\//.test(f) && fs.existsSync(path.join(repo, f)))
      .map((f) => f.slice(root.length + 1)).sort();
    assert.deepEqual(ours, Object.keys(lock.files).sort(), `${root} holds a different set of gopnik files than upstream ${lock.tag}`);
    const staged = Object.fromEntries(git('ls-files', '-s', '--', root).trim().split('\n').filter(Boolean)
      .map((l) => { const [meta, f] = l.split('\t'); return [f.slice(root.length + 1), meta.split(' ')[1]]; }));
    for (const f of ours) {
      const why = `Gopnik changes go upstream (#233); to take a new release, see scripts/refresh-gopnik-lock.mjs.`;
      assert.equal(blobId(fs.readFileSync(path.join(repo, root, f))), lock.files[f], `${root}/${f} differs from upstream gopnik ${lock.tag}. ${why}`);
      if (staged[f]) assert.equal(staged[f], lock.files[f], `${root}/${f} is staged as a blob upstream gopnik ${lock.tag} does not have, ${staged[f]}. ${why}`);
    }
  });
}

test('a CRLF checkout of the skills folds to upstream\'s blob ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gopnik-crlf-'));
  try {
    for (const f of Object.keys(lock.files)) {
      const p = path.join(dir, f.replaceAll('/', '_'));
      fs.writeFileSync(p, fs.readFileSync(path.join(repo, '.agents', 'skills', f), 'utf8').replace(/\n/g, '\r\n'));
      assert.equal(blobId(fs.readFileSync(p)), lock.files[f], `${f} in CRLF does not fold to upstream's blob`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

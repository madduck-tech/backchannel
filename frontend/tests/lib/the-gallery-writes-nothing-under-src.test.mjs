// No test writes under `src/` while other tests read it (#224).
//
// The gallery wrote `src/__gallery_entry.tsx` per card and deleted it, while ten other tests walk or
// copy `src/`. A file listed and then deleted before it was read failed them with ENOENT: measured on
// 2026-10-26 in Stage 1 (`sidebar.test.mjs`, through `boundaryStubs`) and in CI (`cpSync` in
// `published-controls-still-hold.test.mjs`), on changes that touched neither file. A red the code
// under test did not cause is the kind a reviewer learns to rerun past.
//
// **Not `fs.watch`.** On Linux, Node 24's recursive watcher finds a new file by listing the directory
// again when it handles the event, and `buildCards` runs each card under `execFileSync`, so the entry
// is gone before the watcher looks: today's gallery would show zero events. Metadata cannot miss it:
// creating or removing an entry moves its directory's mtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENTRY_BASE_DEFAULT, buildCards } from './gallery.mjs';
import { newestSource } from './storybook-server.mjs';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = path.join(frontend, 'src');
const within = (dir, p) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** `ino`, `mtimeNs` and `ctimeNs` of every directory and file under `dir` (not `atime`: reads move it). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    const s = fs.statSync(d, { bigint: true });
    out[d] = `${s.ino}:${s.mtimeNs}:${s.ctimeNs}`;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const f = fs.statSync(p, { bigint: true });
        out[p] = `${f.ino}:${f.mtimeNs}:${f.ctimeNs}`;
      }
    }
  };
  walk(dir);
  return out;
}

test('the gallery writes its entry outside src/', () => {
  assert.ok(!within(src, ENTRY_BASE_DEFAULT), `the gallery's entry base ${ENTRY_BASE_DEFAULT} is under src/`);
});

test('a card leaves src/ exactly as it found it, and writes under its own base', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-base-'));
  try {
    const baseBefore = fs.statSync(base, { bigint: true }).mtimeNs;
    const before = snapshot(src);
    const target = path.join(src, 'components', 'Logo.tsx');
    assert.ok(before[target], 'precondition: the snapshot walked the card\'s own target');
    const [card] = buildCards(['src/components/Logo.tsx'], { base });
    // And a card with no options: the path both callers and CI's gallery take, where a default
    // pointing under src/ is seen only (round 3 measured all three checks green with it).
    const [byDefault] = buildCards(['src/components/Logo.tsx']);
    const after = snapshot(src);
    // Positive sentinels from the same run: the cards drew, and the first wrote (and removed) under `base`.
    assert.equal(card.kind, 'drawn', `the card did not draw: ${card.reason ?? ''}`);
    assert.equal(byDefault.kind, 'drawn', `the default card did not draw: ${byDefault.reason ?? ''}`);
    assert.notEqual(fs.statSync(base, { bigint: true }).mtimeNs, baseBefore, 'the card wrote nothing under its base');
    const changed = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p]);
    assert.deepEqual(changed, [], `a card changed src/:\n  ${changed.join('\n  ')}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the storybook freshness check skips no name, and nothing ignores a gallery file in src/', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'newest-source-'));
  try {
    fs.mkdirSync(path.join(tree, 'a'));
    fs.writeFileSync(path.join(tree, 'a', 'old.tsx'), '');
    fs.utimesSync(path.join(tree, 'a', 'old.tsx'), 1_000, 1_000);
    fs.writeFileSync(path.join(tree, '__x.tsx'), '');
    fs.utimesSync(path.join(tree, '__x.tsx'), 2_000, 2_000);
    assert.equal(newestSource([tree]), 2_000_000, 'a `__` file was skipped');
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
  const ignore = fs.readFileSync(path.join(frontend, '.gitignore'), 'utf8');
  assert.ok(!/__gallery_entry/.test(ignore), '.gitignore still hides a gallery file under src/');
});

// Nothing in the frontend names Google's font service. (#264)
//
// A build that fetches its fonts fails when the fetch does, and on 2026-10-27 it did. This reads
// every file under src/ and .storybook/, whatever its extension -- a stylesheet @import or a
// preview-head <link> is how Google's fonts usually come back, and a test reading only TypeScript
// would pass with both in place -- and fails on any of the four strings that would bring them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORBIDDEN = ['next/font/google', '@next/font/google', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const files = ['src', '.storybook'].flatMap((d) => walk(path.join(frontend, d)));

test(`no file under src/ or .storybook/ names Google's font service (${files.length} files read)`, () => {
  const rel = files.map((f) => path.relative(frontend, f));
  for (const must of ['src/app/fonts.css', 'src/app/layout.tsx', 'src/app/globals.css', '.storybook/preview-head.html']) assert.ok(rel.includes(must), `the census did not read ${must}`);
  assert.ok(files.length >= 190, `only ${files.length} files read`);
  const hits = files.flatMap((f) => { const t = fs.readFileSync(f, 'latin1'); return FORBIDDEN.filter((s) => t.includes(s)).map((s) => `${path.relative(frontend, f)}: ${s}`); });
  assert.deepEqual(hits, [], `files that would fetch fonts from Google, out of ${files.length} read:\n  ${hits.join('\n  ')}`);
});

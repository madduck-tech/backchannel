// Nothing in the frontend names Google's font service. (#264)
//
// A build that fetches its fonts fails when the fetch does, and on 2026-10-27 it did. This reads every
// file under frontend/ that git sees -- tracked, or untracked and not ignored -- whatever its
// extension, except tests/, which may name the strings as data. A stylesheet @import or a
// preview-head <link> is how Google's fonts usually come back, and a test reading only TypeScript, or
// only src/, would pass with either in place (the gate adversary, round 1: a Google @import in
// frontend/styles/ imported from layout.tsx). It fails on any of the four strings that would bring them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from './workflow-yaml.mjs';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORBIDDEN = ['next/font/google', '@next/font/google', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', '.'], { cwd: frontend, encoding: 'utf8' })
  .split('\0').filter((f) => f && !f.startsWith('tests/') && fs.existsSync(path.join(frontend, f)) && fs.statSync(path.join(frontend, f)).isFile());

test(`no file in the frontend names Google's font service (${files.length} files read)`, () => {
  for (const must of ['src/app/fonts.css', 'src/app/layout.tsx', 'src/app/globals.css', '.storybook/preview-head.html', 'package.json', 'next.config.js']) {
    assert.ok(files.includes(must), `the census did not read ${must}`);
  }
  assert.ok(files.length >= 450, `only ${files.length} files read`);
  const hits = files.flatMap((f) => { const t = fs.readFileSync(path.join(frontend, f), 'latin1'); return FORBIDDEN.filter((s) => t.includes(s)).map((s) => `${f}: ${s}`); });
  assert.deepEqual(hits, [], `files that would fetch fonts from Google, out of ${files.length} read:\n  ${hits.join('\n  ')}`);
});

// A dependency's stylesheet is not a file of the frontend's own, so CI reads the built frontend too.
test('CI reads the built frontend for Google\'s font service, and fails on it', () => {
  const wf = readWorkflow(fs.readFileSync(path.join(frontend, '..', '.github', 'workflows', 'stage2-artifact.yml'), 'utf8'));
  const steps = wf.jobs.flatMap((j) => j.steps);
  const build = steps.findIndex((s) => String(s.keys.run ?? '').includes('tauri build --bundles appimage'));
  const check = steps.findIndex((s) => String(s.keys.run ?? '').includes("grep -rlE 'fonts\\.(googleapis|gstatic)\\.com' frontend/out"));
  assert.ok(build >= 0, 'no AppImage build step found');
  assert.ok(check > build, 'no step after the build reads frontend/out for Google\'s font hosts');
  const run = String(steps[check].keys.run);
  assert.match(run, /then .*exit 1; fi/, 'the check does not fail when it finds one');
  assert.match(run, /\[ "\$N" -gt 0 \] \|\| \{[^}]*exit 1; \}/, 'the check passes on an empty or missing frontend/out');
  assert.match(run, /^\s*N=\$\(find frontend\/out -type f 2>\/dev\/null \| wc -l\)$/m, 'N no longer counts the files under frontend/out');
  // A step that cannot fail the job, or that may not run, checks nothing.
  for (const k of ['continue-on-error', 'if']) assert.ok(!(k in steps[check].keys), `the check carries ${k}:, so it can pass without checking`);
  const job = wf.jobs.find((j) => j.steps.includes(steps[check]));
  assert.ok(!('continue-on-error' in (job.keys ?? {})), 'the job running the check carries continue-on-error:');
});

// Stage 2's font probe asks WebKit which faces draw the app's text, and fonts-verdict.py judges its
// answer. (#264) The probe itself runs only in the built app; this holds the judgement, and holds the
// probe's list of faces and symbols to what fonts.css declares and what the product owner left to the
// system, so the two cannot drift apart.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const verdict = (answer) => spawnSync('python3', ['-I', path.join(repo, 'scripts/lib/fonts-verdict.py')], { input: typeof answer === 'string' ? answer : JSON.stringify(answer), encoding: 'utf8' }).stdout.trim();
const probe = fs.readFileSync(path.join(repo, 'scripts/lib/fonts-probe.js'), 'utf8');
const FACES = [...probe.matchAll(/\['(IBM Plex \w+)', '(\d+)', '(\w+)'\]/g)].map(([, f, w, s]) => [f, w, s]);
const SYMBOLS = JSON.parse(probe.match(/const SYMBOLS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
const answer = ({ status = 'loaded', drawn = null, only = null } = {}) => ({
  faces: FACES.slice(0, only ?? FACES.length).map(([f, w, s]) => ({
    face: `${f} ${w} ${s}`, text: [[f, w, s, status].join('|')],
    symbols: Object.fromEntries(SYMBOLS.map((c) => [c, drawn === c ? [[f, w, s, 'loaded'].join('|')] : []])),
  })),
});

test('the probe asks about the ten faces fonts.css declares, and the symbols the product owner left out', () => {
  const css = fs.readFileSync(path.join(repo, 'frontend/src/app/fonts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, b]) => [b.match(/font-family:\s*['"]([^'"]+)/)[1], b.match(/font-weight:\s*(\d+)/)?.[1], b.match(/font-style:\s*(\w+)/)?.[1]])
    .filter(([f]) => /^IBM Plex (Sans|Serif|Mono)$/.test(f)).map((x) => x.join(' ')).sort();
  assert.deepEqual(FACES.map((x) => x.join(' ')).sort(), declared);
  for (const c of ['✓', '❌', '◊', '⬎']) assert.ok(SYMBOLS.includes(c), `the probe does not ask about ${c}`);
});

test('the verdict: ok only when every face draws text, loaded, and none draws a symbol', () => {
  assert.match(verdict(answer()), /^ok: 10 faces loaded from the shipped files, and none draws ✓ ❌ ◊ ⬎$/);
  assert.match(verdict(answer({ drawn: '✓' })), /^IBM Plex Sans 400 normal would draw ✓ with/);
  assert.match(verdict(answer({ status: 'error' })), /draws text with \["IBM Plex Sans\|400\|normal\|error"\]/);
  assert.match(verdict(answer({ only: 9 })), /reported 9 faces, not ten/);
  assert.match(verdict({ error: 'TypeError' }), /^the font probe failed: TypeError$/);
  assert.match(verdict('not json'), /not JSON/);
  const empty = answer(); empty.faces[3].text = [];
  assert.match(verdict(empty), /draws text with \[\]/);
});

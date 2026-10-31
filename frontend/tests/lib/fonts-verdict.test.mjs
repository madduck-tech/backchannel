// Stage 2's font probe asks WebKit which faces it would draw a text with, and fonts-verdict.py judges its
// answer. (#264) The probe itself runs only in the built app; this holds the judgement, and holds the
// probe's list of faces and symbols to what fonts.css declares and what the product owner left to the
// system, so the two cannot drift apart.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROBE = path.join(repo, 'scripts/lib/fonts-probe.js');
// One line on stdout, nothing on stderr, exit 0, whatever the answer: a traceback ends the UI check with
// neither the verdict nor its message.
const verdict = (answer, probePath = PROBE) => {
  const r = spawnSync('python3', ['-I', path.join(repo, 'scripts/lib/fonts-verdict.py'), probePath], { input: typeof answer === 'string' ? answer : JSON.stringify(answer), encoding: 'utf8' });
  assert.equal(r.status, 0, `the verdict exited ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr, '', 'the verdict wrote to stderr');
  return r.stdout.trim();
};
const probe = fs.readFileSync(PROBE, 'utf8');
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

test('the verdict: ok only when every face would draw text with itself, loaded, and none a symbol', () => {
  assert.match(verdict(answer()), /^ok: 10 faces loaded, each at its own weight and style, and none draws ✓ ❌ ◊ ⬎$/);
  assert.match(verdict(answer({ drawn: '✓' })), /^IBM Plex Sans 400 normal would draw ✓ with/);
  assert.match(verdict(answer({ status: 'error' })), /would draw text with \["IBM Plex Sans\|400\|normal\|error"\]/);
  assert.match(verdict(answer({ only: 9 })), /^the font probe reported the faces \[.*\], not the ten fonts-probe\.js declares$/);
  assert.match(verdict({ error: 'TypeError' }), /^the font probe failed: TypeError$/);
  assert.match(verdict('not json'), /not JSON/);
  const empty = answer(); empty.faces[3].text = [];
  assert.match(verdict(empty), /would draw text with \[\]/);
});

// The answer is held to the probe's own lists, not to what it happens to list: a probe whose loops stop
// asking would otherwise read as a pass (#264's gate adversary, round 4).
test('the verdict holds the answer to the faces and symbols the probe declares', () => {
  const noSymbols = answer(); for (const f of noSymbols.faces) f.symbols = {};
  assert.match(verdict(noSymbols), /^IBM Plex Sans 400 normal was asked about \[\], not ✓ ❌ ◊ ⬎; /);
  const oneSymbol = answer(); for (const f of oneSymbol.faces) delete f.symbols['⬎'];
  assert.match(verdict(oneSymbol), /^IBM Plex Sans 400 normal was asked about \["◊", "✓", "❌"\], not ✓ ❌ ◊ ⬎; /);
  const onlyFirst = answer(); for (const f of onlyFirst.faces.slice(1)) f.symbols = {};
  assert.match(verdict(onlyFirst), /^IBM Plex Sans 500 normal was asked about \[\]/);
  const sameFace = answer(); sameFace.faces = sameFace.faces.map(() => structuredClone(sameFace.faces[0]));
  assert.match(verdict(sameFace), /^the font probe reported the faces \["IBM Plex Sans 400 normal", "IBM Plex Sans 400 normal", /);
  const reordered = answer(); reordered.faces.reverse();
  assert.match(verdict(reordered), /not the ten fonts-probe\.js declares$/);
  for (const shape of ['[]', 'null', '"an error"', '7']) assert.match(verdict(shape), /^the font probe answered JSON that is not an object: /, shape);
  assert.match(verdict({}), /^the font probe answered no list of faces: \{\}$/);
  assert.match(verdict({ faces: [null] }), /^the font probe answered no list of faces: /);
  const noKey = answer(); delete noKey.faces[2].symbols;
  assert.match(verdict(noKey), /^IBM Plex Sans 600 normal was asked about null, not ✓ ❌ ◊ ⬎$/);
  // A probe whose lists the verdict cannot read fails it, rather than leaving nothing to compare.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fonts-verdict-'));
  try {
    fs.writeFileSync(path.join(dir, 'probe.js'), probe.replace(/const FACES = \[[\s\S]*?\n\];/, 'const FACES = PLEX_FACES;'));
    assert.match(verdict(answer(), path.join(dir, 'probe.js')), /^fonts-probe\.js declares 0 faces and 4 symbols, not ten faces and at least one symbol$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The block in the UI check, run as written against a port nothing listens on: the driver gone. Under
// pipefail a failing curl ended the script there with exit 7 and no output (#264's gate adversary,
// round 3, m4); it must reach the verdict and die with its message.
test('a probe that does not answer ends the UI check with the verdict, not in silence', async () => {
  const lines = fs.readFileSync(path.join(repo, 'scripts/stage2-ui-check.sh'), 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('# --- the ten faces load'));
  const to = lines.findIndex((l, i) => i > from && l.startsWith('# --- '));
  const prologue = lines.filter((l) => l === 'set -euo pipefail' || /^(say|die)\(\) \{/.test(l));
  assert.ok(from > 0 && to > from, 'the font block is not where this test looks for it');
  assert.equal(prologue.length, 3, `the UI check's set line, say and die are not where this test looks: ${prologue}`);
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  // The block finds lib/ beside itself, as the UI check does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fonts-block-'));
  try {
    fs.symlinkSync(path.join(repo, 'scripts', 'lib'), path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'block.sh'), [...prologue, ...lines.slice(from, to), 'say "after the block"', ''].join('\n'));
    const r = spawnSync('bash', [path.join(dir, 'block.sh')], { env: { ...process.env, BASE: `http://127.0.0.1:${port}/session/none` }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, `the block exited ${r.status} (${r.signal}), not 1, against a dead port:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^stage2-ui-check: fonts: the font probe failed: the probe did not answer: None$/m);
    assert.match(r.stderr, /^stage2-ui-check: the faces fonts\.css declares do not load as declared, or a face draws a symbol: the font probe failed: the probe did not answer: None$/m);
    assert.doesNotMatch(r.stdout, /after the block/);
  } finally {
    fs.unlinkSync(path.join(dir, 'lib'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

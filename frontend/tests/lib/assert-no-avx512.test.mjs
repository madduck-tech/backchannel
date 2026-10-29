// scripts/assert-no-avx512.sh fails a Linux build whose ggml CPU backend is not at the portable floor
// (#289). Each cell is a fixture repository whose target/ holds transcribe-cpp-sys build trees with
// CMakeCache.txt files written as cmake writes them, and the check is run in it. Every red names the
// condition it went red on, because the only real cache on a machine that built NATIVE has every
// tier OFF as well, and a red on the wrong condition would prove nothing about the right one.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repo, 'scripts', 'assert-no-avx512.sh');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-no-avx512-'));
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));

const GOOD = { GGML_NATIVE: 'OFF', GGML_AVX2: 'ON', GGML_AVX: 'ON', GGML_FMA: 'ON', GGML_AVX512: 'OFF', GGML_AVX_VNNI: 'OFF', GGML_AMX_TILE: 'OFF' };
// A fixture repository with one tree per entry of `trees`; an entry is a cache's options, `null` for
// a tree with no CMakeCache.txt, or a string for a cache with no GGML_NATIVE at all.
function fixture(name, trees) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  trees.forEach((opts, i) => {
    const out = path.join(root, 'target', 'release', 'build', `transcribe-cpp-sys-${i}abc`, 'out', 'build');
    fs.mkdirSync(out, { recursive: true });
    if (opts === null) return;
    const body = typeof opts === 'string' ? opts : Object.entries(opts).map(([k, v]) => `${k}:BOOL=${v}`).join('\n');
    fs.writeFileSync(path.join(out, 'CMakeCache.txt'), `# This is the CMakeCache file.\nCMAKE_BUILD_TYPE:STRING=Release\n${body}\n`);
  });
  return root;
}
const run = (root) => {
  const r = spawnSync('bash', [script], { cwd: path.join(root), encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};

test('a tree at the floor passes, and says what it read and where it ran', () => {
  const r = run(fixture('good', [GOOD]));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^assert-no-avx512: build host: .+; avx512f: (yes|no)$/m);
  assert.match(r.out, /^assert-no-avx512: tree: target\/release\/build\/transcribe-cpp-sys-0abc\/out$/m);
  assert.match(r.out, /OK: 1 cache\(s\)/);
});

test('NATIVE on with AVX2 on is red on the NATIVE condition', () => {
  const r = run(fixture('native', [{ ...GOOD, GGML_NATIVE: 'ON' }]));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /NATIVE: .*GGML_NATIVE:BOOL=ON/);
  assert.doesNotMatch(r.out, /AVX2: |ABOVE THE FLOOR/);
});

test('AVX2 off with NATIVE off is red on the AVX2 condition, and names both causes and their fixes', () => {
  const r = run(fixture('avx2', [{ ...GOOD, GGML_AVX2: 'OFF' }]));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /AVX2: .*GGML_AVX2:BOOL=OFF/);
  assert.match(r.out, /cargo clean --release -p transcribe-cpp-sys/);
  assert.match(r.out, /SOURCE_DATE_EPOCH/);
  assert.doesNotMatch(r.out, /NATIVE: |ABOVE THE FLOOR/);
});

for (const option of ['GGML_AVX512', 'GGML_AVX512_VNNI', 'GGML_AVX_VNNI', 'GGML_AMX_TILE']) {
  test(`${option} on, with NATIVE off and AVX2 on, is red on that option`, () => {
    const r = run(fixture(`above-${option}`, [{ ...GOOD, [option]: 'ON' }]));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`ABOVE THE FLOOR: .*${option}:BOOL=ON`));
    assert.doesNotMatch(r.out, /NATIVE: |AVX2: /);
  });
}

test('no CMakeCache.txt, and caches that define no GGML_NATIVE, verify nothing and fail', () => {
  const none = run(fixture('no-cache', [null]));
  assert.equal(none.status, 1, none.out);
  assert.match(none.out, /no CMakeCache\.txt under the build trees - verified nothing/);
  const foreign = run(fixture('foreign', ['SOME_OTHER:BOOL=ON']));
  assert.equal(foreign.status, 1, foreign.out);
  assert.match(foreign.out, /no CMakeCache\.txt defines GGML_NATIVE - verified nothing/);
  const empty = fixture('no-tree', []);
  const r = run(empty);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no transcribe-cpp-sys build tree .* - verified nothing/);
});

test('two trees, one at the floor and one not: red, naming the second', () => {
  const r = run(fixture('two', [GOOD, { ...GOOD, GGML_AVX2: 'OFF' }]));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /AVX2: target\/release\/build\/transcribe-cpp-sys-1abc\/out\/build\/CMakeCache\.txt/);
  assert.doesNotMatch(r.out, /AVX2: target\/release\/build\/transcribe-cpp-sys-0abc/);
});

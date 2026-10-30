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
// The compile flags ggml-cpu's flags.make carries on a build at the floor, as this laptop's showed.
const FLOOR_FLAGS = 'C_FLAGS = -O3 -DNDEBUG -m64 -mavx -mavx2 -mbmi2 -mf16c -mfma -msse4.2\nCXX_FLAGS = -O3 -DNDEBUG -m64 -mavx -mavx2 -mbmi2 -mf16c -mfma -msse4.2\n';
// A fixture repository with one tree per entry of `trees`; an entry is a cache's options, `null` for
// a tree with no CMakeCache.txt, or a string for a cache with no GGML_NATIVE at all. An option's value
// may carry its own type, `STRING=TRUE`; otherwise it is written as cmake writes an option, `BOOL`.
// `flags` is the flags.make beside each cache, `null` for none; `tree` is where under target/ the
// trees sit.
function fixture(name, trees, { flags = FLOOR_FLAGS, tree = ['release'] } = {}) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  trees.forEach((opts, i) => {
    const out = path.join(root, 'target', ...tree, 'build', `transcribe-cpp-sys-${i}abc`, 'out', 'build');
    fs.mkdirSync(out, { recursive: true });
    if (opts === null) return;
    const entry = ([k, v]) => (v.includes('=') ? `${k}:${v}` : `${k}:BOOL=${v}`);
    const body = typeof opts === 'string' ? opts : Object.entries(opts).map(entry).join('\n');
    fs.writeFileSync(path.join(out, 'CMakeCache.txt'), `# This is the CMakeCache file.\nCMAKE_BUILD_TYPE:STRING=Release\n${body}\n`);
    if (flags === null) return;
    const dir = path.join(out, 'ggml', 'src', 'CMakeFiles', 'ggml-cpu.dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'flags.make'), flags);
  });
  return root;
}
const run = (root, cwd = root) => {
  const r = spawnSync('bash', [script], { cwd, encoding: 'utf8' });
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

// CMake caches -DGGML_AVX512=1 as `:BOOL=1`, and a -D with a type of its own keeps it, and if() takes the
// branch for every value that is not a false constant (#289's gate adversary, measured with cmake).
for (const [option, value] of [['GGML_AVX512', '1'], ['GGML_AVX512', 'STRING=ON'], ['GGML_AMX_TILE', 'STRING=TRUE'], ['GGML_AVX_VNNI', 'BOOL=YES']]) {
  test(`${option}:${value.includes('=') ? value : 'BOOL=' + value} counts as on`, () => {
    const r = run(fixture(`spelled-${option}-${value.replace(/\W/g, '')}`, [{ ...GOOD, [option]: value }]));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`ABOVE THE FLOOR: .*${option}:`));
  });
}

test("CMake's false constants, in any type and case, are off", () => {
  const r = run(fixture('false-constants', [{ ...GOOD, GGML_AVX512: '0', GGML_AVX512_VNNI: 'STRING=no', GGML_AVX_VNNI: 'BOOL=False', GGML_AMX_TILE: 'STRING=AMX-NOTFOUND' }]));
  assert.equal(r.status, 0, r.out);
});

test('compile flags above the floor are red, whatever the options say', () => {
  for (const [name, flag] of [['native', '-march=native'], ['avx512f', '-mavx512f'], ['skylake', '-march=skylake-avx512']]) {
    const r = run(fixture(`flags-${name}`, [GOOD], { flags: FLOOR_FLAGS.replace('-msse4.2\n', `-msse4.2 ${flag}\n`) }));
    assert.equal(r.status, 1, `${flag}: ${r.out}`);
    assert.match(r.out, new RegExp(`COMPILE FLAGS: .*${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  const plain = run(fixture('flags-x86-64-v3', [GOOD], { flags: FLOOR_FLAGS.replace('-m64', '-m64 -march=x86-64-v3') }));
  assert.equal(plain.status, 0, plain.out);
});

test('a cache with no flags.make beside it is red: its flags were not read', () => {
  const r = run(fixture('no-flags', [GOOD], { flags: null }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /COMPILE FLAGS: no ggml-cpu flags\.make beside/);
});

test('a tree under target/<triple>/release is read, as a --target build writes it', () => {
  const r = run(fixture('triple', [{ ...GOOD, GGML_AVX2: 'OFF' }], { tree: ['x86_64-unknown-linux-gnu', 'release'] }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /AVX2: target\/x86_64-unknown-linux-gnu\/release\/build\/transcribe-cpp-sys-0abc/);
});

test('run from a subdirectory, as gate entry 3 runs it from frontend/, it reads the root target/', () => {
  const root = fixture('from-frontend', [GOOD]);
  fs.mkdirSync(path.join(root, 'frontend'), { recursive: true });
  const r = run(root, path.join(root, 'frontend'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /OK: 1 cache\(s\)/);
});

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

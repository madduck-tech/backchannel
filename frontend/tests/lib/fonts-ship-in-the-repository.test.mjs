// The typefaces ship in the repository: IBM's own files, each face to its own file. (#264)
//
// Until #264 every build fetched IBM Plex from Google, and a build failed when Google answered in a
// form the loader did not parse. The files are IBM's `complete/woff2`, unmodified: the licence
// reserves the name "Plex", so a subset or a converted copy may not carry it. This holds the ten files
// and the licence to the sha256 recorded in SOURCES.md; holds each of fonts.css's ten faces to its own
// file, so a swap of two weights is caught even where their widths are equal (Mono 400 and 500 are);
// and holds the fallback faces to the metrics Next's Google loader generated, so `ch` does not move.
// And it holds git to storing them as they are: the licence has CRLF line endings, which
// core.autocrlf=input would store as LF, so the clone CI checks out would carry other bytes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(frontend, 'src', 'app', 'fonts');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// Line endings normalised: a core.autocrlf=true checkout writes fonts.css with CRLF.
const css = fs.readFileSync(path.join(frontend, 'src', 'app', 'fonts.css'), 'utf8').replace(/\r\n/g, '\n');

test('the ten files and the licence are IBM\'s, byte for byte, as SOURCES.md records', () => {
  const rows = [...fs.readFileSync(path.join(dir, 'SOURCES.md'), 'utf8').replace(/\r\n/g, '\n').matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \| (https:\/\/raw\.githubusercontent\.com\/IBM\/plex\/\S+) \|$/gm)];
  assert.equal(rows.length, 11, 'SOURCES.md does not record ten files and the licence');
  for (const [, file, bytes, digest, url] of rows) {
    const p = path.join(dir, file);
    assert.ok(fs.existsSync(p), `${file} is recorded and missing`);
    assert.equal(fs.statSync(p).size, Number(bytes), `${file}: size`);
    assert.equal(sha(p), digest, `${file} is not the file SOURCES.md records`);
    assert.ok(url.endsWith(`/${file}`), `${file}: its URL names another file`);
  }
  // Each row names its own file, and the rows name exactly the files on disk: a row copied over
  // another would otherwise let an unrecorded file through.
  const recorded = rows.map(([, file]) => file);
  assert.equal(new Set(recorded).size, recorded.length, `SOURCES.md records a file twice: ${recorded.join(', ')}`);
  assert.deepEqual(recorded.filter((f) => f.endsWith('.woff2')).sort(), fs.readdirSync(dir).filter((f) => f.endsWith('.woff2')).sort(), 'the font files on disk are not the ones SOURCES.md records');
  assert.equal(sha(path.join(frontend, 'public', 'IBM-Plex-LICENSE.txt')), sha(path.join(dir, 'LICENSE.txt')), 'the shipped licence is not the committed one');
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8').split('\n')[0], /Reserved Font Name "Plex"/);
});

test('each face names its own file, and the families keep their names and fallbacks', () => {
  const faces = [...css.matchAll(/@font-face \{\n  font-family: '([^']+)';\n  src: url\('\.\/fonts\/([^']+)'\) format\('woff2'\);\n  font-weight: (\d+);\n  font-style: (\w+);/g)]
    .map(([, family, file, weight, style]) => `${family} ${weight} ${style} → ${file}`).sort();
  assert.deepEqual(faces, [
    'IBM Plex Mono 400 normal → IBMPlexMono-Regular.woff2',
    'IBM Plex Mono 500 normal → IBMPlexMono-Medium.woff2',
    'IBM Plex Sans 400 normal → IBMPlexSans-Regular.woff2',
    'IBM Plex Sans 500 normal → IBMPlexSans-Medium.woff2',
    'IBM Plex Sans 600 normal → IBMPlexSans-SemiBold.woff2',
    'IBM Plex Sans 700 normal → IBMPlexSans-Bold.woff2',
    'IBM Plex Serif 400 italic → IBMPlexSerif-Italic.woff2',
    'IBM Plex Serif 400 normal → IBMPlexSerif-Regular.woff2',
    'IBM Plex Serif 600 italic → IBMPlexSerif-SemiBoldItalic.woff2',
    'IBM Plex Serif 600 normal → IBMPlexSerif-SemiBold.woff2',
  ]);
  for (const [family, local, metrics] of [
    ['IBM Plex Sans Fallback', 'Arial', ['101.32%', '27.18%', '101.17%']],
    ['IBM Plex Serif Fallback', 'Times New Roman', ['88.04%', '23.62%', '116.43%']],
    ['IBM Plex Mono Fallback', 'Arial', ['76.16%', '20.43%', '134.59%']],
  ]) {
    const block = css.split('@font-face').find((b) => b.includes(`'${family}'`)) ?? '';
    assert.ok(block.includes(`local("${local}")`), `${family} does not fall back to ${local}`);
    for (const [k, v] of [['ascent-override', metrics[0]], ['descent-override', metrics[1]], ['size-adjust', metrics[2]]]) assert.ok(block.includes(`${k}: ${v};`), `${family}: ${k} is not ${v}`);
  }
  for (const v of ["--font-sans: 'IBM Plex Sans', 'IBM Plex Sans Fallback';", "--font-serif: 'IBM Plex Serif', 'IBM Plex Serif Fallback';", "--font-mono: 'IBM Plex Mono', 'IBM Plex Mono Fallback';"]) assert.ok(css.includes(v), `fonts.css does not declare ${v}`);
  assert.match(fs.readFileSync(path.join(frontend, 'src', 'app', 'globals.css'), 'utf8'), /^@import "\.\/fonts\.css";$/m, 'globals.css does not bring fonts.css');
});

test('git stores the files as they are, so a fresh clone carries IBM\'s bytes', () => {
  const files = [...fs.readdirSync(dir).map((f) => path.join('src', 'app', 'fonts', f)), path.join('public', 'IBM-Plex-LICENSE.txt')];
  const attrs = execFileSync('git', ['check-attr', 'text', '--', ...files], { cwd: frontend, encoding: 'utf8' }).trim().split('\n');
  assert.equal(attrs.length, files.length);
  for (const line of attrs) assert.match(line, /: text: unset$/, `git may rewrite ${line.split(':')[0]}'s line endings`);
  for (const f of files) {
    const blob = execFileSync('git', ['cat-file', '-p', `:frontend/${f.split(path.sep).join('/')}`], { cwd: frontend, maxBuffer: 1 << 24 });
    assert.equal(crypto.createHash('sha256').update(blob).digest('hex'), sha(path.join(frontend, f)), `the blob git stores for ${f} is not the file on disk`);
  }
});

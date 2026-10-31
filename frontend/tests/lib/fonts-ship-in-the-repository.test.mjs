// The typefaces ship in the repository: IBM's own files, each face to its own file. (#264)
//
// Until #264 every build fetched IBM Plex from Google, and a build failed when Google answered in a
// form the loader did not parse. The files are IBM's `complete/woff2`, unmodified: the licence
// reserves the name "Plex", so a subset or a converted copy may not carry it. This holds the ten files
// and the licence to the sha256 recorded in SOURCES.md; holds each of fonts.css's ten faces to its own
// file, so a swap of two weights is caught even where their widths are equal (Mono 400 and 500 are);
// and holds the fallback faces to the metrics Next's Google loader generated. fonts.css is read as CSS
// is: comments out, each @font-face a map of its declarations, quotes either way, and a declaration given
// twice refused, since the later one is the one drawn. No other stylesheet may declare a face or a
// --font-* variable.
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
const uncommented = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');
// `@font-face` as CSS reads it: in any case (#264's gate adversary, round 3), and with any letter
// written as an escape (round 4: the build reads `@font-f\61 ce` and `@\66ont-face` as faces). A hex
// escape is up to six digits and one optional space; f, a, c and e are hex digits, so `\f` is not f.
const AT_FONT_FACE = '@' + [...'font-face'].map((c) => {
  const hex = c.codePointAt(0).toString(16);
  const literal = /[0-9a-f]/i.test(c) ? '' : `|\\\\${c === '-' ? '-' : c}`;
  return `(?:${c === '-' ? '-' : c}|\\\\0{0,4}(?:${hex}|${c.toUpperCase().codePointAt(0).toString(16)})(?:\\r\\n|[ \\t\\n\\r\\f])?${literal})`;
}).join('');
function faces(text) {
  return [...uncommented(text).matchAll(new RegExp(`${AT_FONT_FACE}\\s*\\{([^}]*)\\}`, 'gi'))].map(([, body]) => {
    const decl = {};
    for (const part of body.split(';').map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      const k = part.slice(0, i).trim().toLowerCase();
      assert.ok(!(k in decl), `an @font-face declares ${k} twice, and the later one is drawn:\n${body.trim()}`);
      decl[k] = part.slice(i + 1).trim();
    }
    return decl;
  });
}
const PLEX = /^IBM Plex (Sans|Serif|Mono)$/;
const RANGE = 'U+0000-22FF, U+2400-245F, U+2500-259F, U+27C0-2AFF, U+2C00-2FFF, U+3000-FFFF';
const TAGS = { Sans: '%40ibm%2Fplex-sans%401.1.0', Serif: '%40ibm%2Fplex-serif%402.0.0', Mono: '%40ibm%2Fplex-mono%402.5.0' };

test('the ten files and the licence are IBM\'s, byte for byte, as SOURCES.md records', () => {
  const rows = [...fs.readFileSync(path.join(dir, 'SOURCES.md'), 'utf8').replace(/\r\n/g, '\n').matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \| (https:\/\/raw\.githubusercontent\.com\/IBM\/plex\/\S+) \|$/gm)];
  assert.equal(rows.length, 11, 'SOURCES.md does not record ten files and the licence');
  for (const [, file, bytes, digest, url] of rows) {
    const p = path.join(dir, file);
    assert.ok(fs.existsSync(p), `${file} is recorded and missing`);
    assert.equal(fs.statSync(p).size, Number(bytes), `${file}: size`);
    assert.equal(sha(p), digest, `${file} is not the file SOURCES.md records`);
    assert.ok(url.endsWith(`/${file}`), `${file}: its URL names another file`);
    // Each file from its own family's tag, the one fonts.css and ADR 0035 name.
    const family = file === 'LICENSE.txt' ? 'Mono' : file.match(/^IBMPlex(Sans|Serif|Mono)-/)?.[1];
    assert.ok(family && url.startsWith(`https://raw.githubusercontent.com/IBM/plex/${TAGS[family]}/`), `${file}: its URL is not at ${family}'s tag`);
  }
  // Each row names its own file, and the rows name exactly the files on disk: a row copied over
  // another would otherwise let an unrecorded file through.
  const recorded = rows.map(([, file]) => file);
  assert.equal(new Set(recorded).size, recorded.length, `SOURCES.md records a file twice: ${recorded.join(', ')}`);
  assert.deepEqual(recorded.filter((f) => f.endsWith('.woff2')).sort(), fs.readdirSync(dir).filter((f) => f.endsWith('.woff2')).sort(), 'the font files on disk are not the ones SOURCES.md records');
  assert.equal(sha(path.join(frontend, 'public', 'IBM-Plex-LICENSE.txt')), sha(path.join(dir, 'LICENSE.txt')), 'the shipped licence is not the committed one');
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8').split('\n')[0], /Reserved Font Name "Plex"/);
});

test('each face names its own file once, and the families keep their names and fallbacks', () => {
  const all = faces(css);
  assert.equal(all.length, 13, `fonts.css holds ${all.length} @font-face rules, not ten faces and three fallbacks`);
  const got = all.filter((d) => PLEX.test(unquote(d['font-family'] ?? ''))).map((d) => {
    const file = (d.src ?? '').match(/^url\((['"]?)\.\/fonts\/([^'")]+)\1\) format\((['"])woff2\3\)$/);
    return `${unquote(d['font-family'])} ${d['font-weight']} ${d['font-style']} → ${file ? file[2] : d.src}`;
  }).sort();
  // Each face whole: a property added beside these five (size-adjust, font-feature-settings, another
  // font-display) changes what is drawn and was passed (#264's gate adversary, round 3).
  for (const d of all.filter((x) => PLEX.test(unquote(x['font-family'] ?? '')))) {
    assert.deepEqual(Object.keys(d).sort(), ['font-display', 'font-family', 'font-style', 'font-weight', 'src', 'unicode-range'], `${unquote(d['font-family'])} ${d['font-weight']} ${d['font-style']} declares other properties than a face`);
    assert.equal(d['font-display'], 'swap', `${unquote(d['font-family'])} ${d['font-weight']} ${d['font-style']}: font-display is ${d['font-display']}`);
  }
  assert.deepEqual(got, [
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
    const fb = all.filter((d) => unquote(d['font-family'] ?? '') === family);
    assert.equal(fb.length, 1, `${family} is declared ${fb.length} times`);
    assert.deepEqual(fb[0], { 'font-family': fb[0]['font-family'], src: `local("${local}")`, 'ascent-override': metrics[0], 'descent-override': metrics[1], 'line-gap-override': '0.00%', 'size-adjust': metrics[2] }, `${family} is not the fallback Next generated`);
  }
  // Each variable declared once, in fonts.css, and nowhere else the frontend's styles are read from.
  const vars = { '--font-sans': "'IBM Plex Sans', 'IBM Plex Sans Fallback'", '--font-serif': "'IBM Plex Serif', 'IBM Plex Serif Fallback'", '--font-mono': "'IBM Plex Mono', 'IBM Plex Mono Fallback'" };
  for (const [k, v] of Object.entries(vars)) {
    const found = [...uncommented(css).matchAll(new RegExp(`${k}\\s*:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
    assert.deepEqual(found, [v], `fonts.css declares ${k} as ${JSON.stringify(found)}`);
  }
  const elsewhere = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(css|scss|tsx?|jsx?|mdx|html)$/.test(e.name) && p !== path.join(frontend, 'src', 'app', 'fonts.css')) { const s = uncommented(fs.readFileSync(p, 'utf8')); if (new RegExp(AT_FONT_FACE, 'i').test(s) || /--font-(sans|serif|mono)\s*:/.test(s)) elsewhere.push(path.relative(frontend, p)); } } };
  for (const d of ['src', '.storybook']) walk(path.join(frontend, d));
  assert.deepEqual(elsewhere, [], 'a face or a --font-* variable is declared outside fonts.css');
  assert.match(fs.readFileSync(path.join(frontend, 'src', 'app', 'globals.css'), 'utf8'), /^@import "\.\/fonts\.css";$/m, 'globals.css does not bring fonts.css');
});

// The product owner's choice of 2026-10-28 (#264): IBM's files bring the slashed zero, the arrows,
// the maths and the kerning, and the symbols stay the system's, so a colour emoji keeps its colour.
test('every face leaves the symbol and emoji blocks to the system, and keeps text, arrows and maths', () => {
  const plex = faces(css).filter((d) => PLEX.test(unquote(d['font-family'] ?? '')));
  assert.equal(plex.length, 10);
  // Only U+XXXX and U+XXXX-YYYY: a wildcard (U+27??) or another case parses differently here than in CSS.
  const parse = (r) => r.split(',').map((s) => s.trim()).map((tok) => {
    const m = tok.match(/^U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?$/);
    assert.ok(m, `unicode-range token ${tok} is not U+XXXX or U+XXXX-YYYY`);
    return [parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)];
  });
  for (const d of plex) {
    assert.equal(d['unicode-range'], RANGE, `${unquote(d['font-family'])} ${d['font-weight']} ${d['font-style']}: the range is not the product owner's`);
    const has = (cp) => parse(d['unicode-range']).some(([lo, hi]) => cp >= lo && cp <= hi);
    // Every code point IBM's files carry in the excluded blocks (◊ ✓ ❌ ⬎⬏⬐⬑), and the emoji beside them.
    for (const ch of '◊✓❌⬎⬏⬐⬑✕✅⚠★▶●☀⌛①⭐😀') assert.ok(!has(ch.codePointAt(0)), `${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()}) would be drawn by Plex`);
    for (const ch of '0Øaжё→≈≤½²₂‰—€№') assert.ok(has(ch.codePointAt(0)), `${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()}) is left out of Plex`);
  }
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

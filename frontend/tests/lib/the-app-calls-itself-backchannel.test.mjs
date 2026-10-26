// The app calls itself Backchannel: nothing a person can see says Conversationaly (#228).
//
// The fork kept upstream's name in every string and upstream's identifier, `com.conversationaly.ai`,
// which a live upstream product ships too, so the two shared one data directory and one
// single-instance lock. ADR 0023: an instruction that removes something ships with a test that fails
// while it is present, so this census is red while any line names the old app.
//
// **No per-line excuses.** A match is allowed only on a comment line, or when deleting the kept tokens
// bound to that file leaves no match on the line: a kept key with the old name appended is still red. The set is closed and is the
// issue's "Kept, on purpose" table; a token added here without the issue is visible in the diff and
// in the verdict, which compares the two. A free-text reason beside a line would let the change
// excuse whatever it had not renamed, which is the shape #228's critic refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// What ships, or is written into what ships: the UI, the Rust core, the bundle configuration, the
// static assets and the bundled templates.
const ROOTS = ['src', 'src-tauri/src', 'src-tauri/capabilities', 'src-tauri/templates', 'public'];
const FILES = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/Info.plist', 'src-tauri/entitlements.plist'];
const SKIP_DIRS = new Set(['node_modules', 'target', 'binaries', 'out', '.next', 'icons']);

// The kept tokens, each with the one file it may appear in, and why it stays (#228, "Kept, on purpose").
export const KEPT = [
  // Webview storage keys. They live in the webview's data directory, which moves with the identifier;
  // renaming them would drop the layout, theme and recording recovery of a moved profile.
  { token: 'conversationaly.panes', file: 'src/lib/panes.ts' },
  { token: 'conversationaly.theme', file: 'src/lib/theme.ts' },
  { token: 'ConversationalyRecoveryDB', file: 'src/services/indexedDBService.ts' },
  // The crate and package names. The bundled binary is `backchannel` (`mainBinaryName`), so only a
  // local cargo build carries this one.
  { token: 'name = "conversationaly"', file: 'src-tauri/Cargo.toml' },
  { token: '"name": "conversationaly"', file: 'package.json' },
  // A developer override that scripts may set.
  { token: 'CONVERSATIONALY_LLAMA_HELPER', file: 'src-tauri/src/summary/summary_engine/sidecar.rs' },
  // The credit to the fork's direct upstream, which keeps its name (LICENSE.md:4).
  { token: "name: 'Conversationaly', author: 'Michael Bykovski'", file: 'src/components/About.tsx' },
  { token: 'https://github.com/bykof/conversationaly', file: 'src/components/About.tsx' },
];

// What of each line is code, per file type: comments are not seen, and everything else is. A small
// lexer rather than a prefix rule, because every prefix rule tried let a visible line through: a Rust
// attribute (`#[…]`) or a dereference (`*label = …`) read as a comment, so did the code after a closed
// block comment, and cutting at every `//` dropped JSX text after a URL (#228 rounds 3 and 4).
const C_LIKE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.css', '.json']);
const MARKUP = new Set(['.html', '.xml', '.svg', '.plist', '.md']);
const HASH = new Set(['.toml', '.sh', '.py', '.yml', '.yaml']);

export function codeLines(text, ext) {
  const lines = text.split('\n');
  if (MARKUP.has(ext)) return markupCode(lines);
  if (HASH.has(ext)) return lines.map((l) => cutAt(l, (line, i) => line[i] === '#'));
  if (C_LIKE.has(ext)) return cLikeCode(lines, ext === '.rs');
  return lines;
}

// Outside a string literal, the first index where `starts` holds, and the line cut there.
function cutAt(line, starts, quotes = ['"', "'", '`']) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (quotes.includes(c)) {
      quote = c;
    } else if (starts(line, i)) {
      return line.slice(0, i);
    }
  }
  return line;
}

function cLikeCode(lines, rust) {
  // In Rust a `'` opens a lifetime as often as a char, so only `"` is a string there.
  const quotes = rust ? ['"'] : ['"', "'", '`'];
  let inBlock = false;
  return lines.map((line) => {
    let code = '';
    let rest = line;
    for (;;) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end < 0) return code;
        rest = rest.slice(end + 2);
        inBlock = false;
      }
      // A `//` after a `:` is a URL in text, not a comment; a `/*` opens a block (JSX's `{/*` too).
      let open = -1;
      let lineComment = false;
      cutAt(rest, (l, i) => {
        if (l[i] !== '/') return false;
        if (l[i + 1] === '/' && l[i - 1] !== ':') return (lineComment = true), (open = i), true;
        if (l[i + 1] === '*') return (open = i), true;
        return false;
      }, quotes);
      if (open < 0) return code + rest;
      code += rest.slice(0, open);
      if (lineComment) return code;
      inBlock = true;
      rest = rest.slice(open + 2);
    }
  });
}

function markupCode(lines) {
  let inComment = false;
  return lines.map((line) => {
    let code = '';
    let rest = line;
    for (;;) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) return code;
        rest = rest.slice(end + 3);
        inComment = false;
      }
      const open = rest.indexOf('<!--');
      if (open < 0) return code + rest;
      code += rest.slice(0, open);
      inComment = true;
      rest = rest.slice(open + 4);
    }
  });
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else {
      yield path.join(dir, entry.name);
    }
  }
}

export function files(root = frontend) {
  const found = FILES.map((f) => path.join(root, f));
  for (const r of ROOTS) {
    const dir = path.join(root, r);
    if (fs.existsSync(dir)) found.push(...walk(dir));
  }
  return found;
}

/** Every line that names the old app and is neither a comment nor a kept token in its own file. */
export function offenders(root = frontend) {
  const out = [];
  for (const file of files(root)) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue; // a binary asset
    const rel = path.relative(root, file).split(path.sep).join('/');
    const lines = bytes.toString('utf8').split('\n');
    const code = codeLines(lines.join('\n'), path.extname(file));
    lines.forEach((line, i) => {
      if (!/conversationaly/i.test(code[i])) return;
      const rest = KEPT.filter((k) => k.file === rel).reduce((l, k) => l.split(k.token).join(''), code[i]);
      if (!/conversationaly/i.test(rest)) return;
      out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

test('nothing a person can see names the app Conversationaly', () => {
  const found = offenders();
  assert.deepEqual(found, [], `the old name, outside a comment and the kept tokens (#228):\n  ${found.join('\n  ')}`);
});

test('every kept token is still used where it is kept', () => {
  // A token whose line is gone is a stale excuse: the set would keep allowing it for nothing.
  // On a code line: a token that survives only in a comment excuses nothing.
  const stale = KEPT.filter(
    (k) => !codeLines(fs.readFileSync(path.join(frontend, k.file), 'utf8'), path.extname(k.file)).some((l) => l.includes(k.token))
  );
  assert.deepEqual(stale, [], `kept tokens no longer in their files: ${stale.map((k) => `${k.token} (${k.file})`).join(', ')}`);
});

test('the identifier is Backchannel\'s own, not upstream\'s', () => {
  const config = JSON.parse(fs.readFileSync(path.join(frontend, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(config.identifier, 'tech.madduck.backchannel');
  assert.equal(config.productName, 'Backchannel');
  assert.equal(config.mainBinaryName, 'backchannel', 'the bundled binary is not upstream\'s conversationaly');
  assert.equal(config.bundle?.publisher, 'Backchannel');
  assert.deepEqual(
    config.app.windows.map((w) => w.title),
    ['Backchannel'],
    'the main window is titled Backchannel'
  );
});

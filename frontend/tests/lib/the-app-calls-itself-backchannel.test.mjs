// The app calls itself Backchannel: nothing a person can see says Conversationaly (#228).
//
// The fork kept upstream's name in every string and upstream's identifier, `com.conversationaly.ai`,
// which a live upstream product ships too, so the two shared one data directory and one
// single-instance lock. ADR 0023: an instruction that removes something ships with a test that fails
// while it is present, so this census is red while any line names the old app.
//
// **No per-line excuses.** A match is allowed only on a comment line, or when the line holds one of
// the kept tokens below, and only in the file the token belongs to. The set is closed and is the
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
const FILES = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/build.rs'];
const SKIP_DIRS = new Set(['node_modules', 'target', 'binaries', 'out', '.next', 'icons']);

// The kept tokens, each with the one file it may appear in, and why it stays (#228, "Kept, on purpose").
export const KEPT = [
  // Webview storage keys. They live in the webview's data directory, which moves with the identifier;
  // renaming them would drop the layout, theme and recording recovery of a moved profile.
  { token: 'conversationaly.panes', file: 'src/lib/panes.ts' },
  { token: 'conversationaly.theme', file: 'src/lib/theme.ts' },
  { token: 'ConversationalyRecoveryDB', file: 'src/services/indexedDBService.ts' },
  // The crate and package names, and so the main binary's name, which is #230.
  { token: 'name = "conversationaly"', file: 'src-tauri/Cargo.toml' },
  { token: '"name": "conversationaly"', file: 'package.json' },
  { token: '--process conversationaly', file: 'src-tauri/src/console_utils/console_utils.rs' },
  // A developer override that scripts may set.
  { token: 'CONVERSATIONALY_LLAMA_HELPER', file: 'src-tauri/src/summary/summary_engine/sidecar.rs' },
  // The credit to the fork's direct upstream, which keeps its name (LICENSE.md:4).
  { token: 'FORKED_FROM', file: 'src/components/About.tsx' },
];

const COMMENT = /^\s*(\/\/|\/\*|\*|\{\/\*|#|<!--)/;

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
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue; // a binary asset
    const rel = path.relative(root, file).split(path.sep).join('/');
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/conversationaly/i.test(line) || COMMENT.test(line)) return;
        if (KEPT.some((k) => k.file === rel && line.includes(k.token))) return;
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
  const stale = KEPT.filter((k) => !fs.readFileSync(path.join(frontend, k.file), 'utf8').includes(k.token));
  assert.deepEqual(stale, [], `kept tokens no longer in their files: ${stale.map((k) => `${k.token} (${k.file})`).join(', ')}`);
});

test('the identifier is Backchannel\'s own, not upstream\'s', () => {
  const config = JSON.parse(fs.readFileSync(path.join(frontend, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(config.identifier, 'tech.madduck.backchannel');
  assert.equal(config.productName, 'Backchannel');
  assert.equal(config.bundle?.publisher, 'Backchannel');
  assert.deepEqual(
    config.app.windows.map((w) => w.title),
    ['Backchannel'],
    'the main window is titled Backchannel'
  );
});

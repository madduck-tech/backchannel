// Serves a built Storybook to the story tests. Helper, not a test.
//
// **Freshness is checked, not assumed.** A story test reading a stale bundle is the same class as the
// stale AppImage `stage2-locate-app.sh` exists for: every assertion after it is made against code
// that is not the code under test. So the newest source file is compared against the build's own
// manifest, and a stale build is rebuilt rather than reported.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATIC = join(root, 'storybook-static');
const MANIFEST = join(STATIC, 'index.json');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' };

/** Newest mtime under the directories a story bundle is built from. */
function newestSource() {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of ['src', '.storybook']) walk(join(root, d));
  return newest;
}

const LOCK = join(root, '.storybook-build.lock');
/**
 * Written by us **after** `build-storybook` returns, and the only thing a waiter trusts.
 *
 * The first version waited on Storybook's own `index.json`. Measured on CI: a waiting process saw it,
 * started serving, and `iframe.html` 404'd -- the manifest is written before the bundle is complete.
 * Assuming another tool's write order is exactly the class of mistake this repository keeps finding,
 * so this file is ours and its existence means the whole build finished.
 */
const DONE = join(STATIC, '.build-complete');
const fresh = () =>
  existsSync(DONE) && existsSync(join(STATIC, 'iframe.html')) && statSync(DONE).mtimeMs >= newestSource();

/**
 * Build only when there is nothing to serve or what there is predates the sources.
 *
 * **Serialised, because `node --test` runs test files concurrently.** Measured on 2026-09-08: three
 * story tests each saw a stale build and started `pnpm build-storybook` into the same output
 * directory at once, and `pnpm test` came back with two failures that a second run did not reproduce.
 * A flaky gate is worse than no gate, so the first process to create the lock builds and the others
 * wait for the manifest rather than racing it.
 */
export function ensureBuilt() {
  if (fresh()) return false;

  let held = false;
  try { closeSync(openSync(LOCK, 'wx')); held = true; }
  catch { /* someone else is building */ }

  if (!held) {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      if (fresh() && !existsSync(LOCK)) return false;
      execFileSync('sleep', ['0.5']);
    }
    throw new Error('waited 5 minutes for another process to build Storybook and it never finished');
  }

  try {
    execFileSync('pnpm', ['build-storybook'], { cwd: root, stdio: 'inherit' });
    writeFileSync(DONE, new Date().toISOString());
  } finally { try { unlinkSync(LOCK); } catch { /* already gone */ } }
  return true;
}

/** Serve the built catalogue. Returns { origin, stop }. */
export async function serveStorybook() {
  ensureBuilt();
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = join(STATIC, rel);
    if (!file.startsWith(STATIC) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) };
}

/** The URL of one story, by its id in `index.json`. */
export const storyUrl = (origin, id) => `${origin}/iframe.html?id=${id}&viewMode=story`;

/** Every story id the build knows about. */
export function storyIds() {
  ensureBuilt();
  return Object.keys(JSON.parse(readFileSync(MANIFEST, 'utf8')).entries);
}

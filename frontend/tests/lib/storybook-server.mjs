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
 * Make sure there is a complete build to serve, and that nobody observes one mid-flight.
 *
 * **Every process goes through the lock, not only the one that builds.** The first version checked
 * freshness first and took the lock only when stale, which left a window: A finds it stale, takes the
 * lock and starts building -- `build-storybook` empties `storybook-static` -- while B, a millisecond
 * earlier, found it fresh and began serving the directory A is deleting. Its pages 404 and the story
 * never renders.
 *
 * Measured: `storybook-interaction` failed on 2 of 5 runs, and only on runs where a rebuild happened.
 * Raising the render deadline from 25s to 90s did not fix it -- it made the same failure take 92
 * seconds instead of 27, which is the shape of a wrong diagnosis. The deadline stays generous for
 * loaded machines, but this is what the bug was.
 */
export function ensureBuilt() {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    let held = false;
    try { closeSync(openSync(LOCK, 'wx')); held = true; }
    catch { /* someone else holds it */ }

    if (held) {
      try {
        if (fresh()) return false;
        execFileSync('pnpm', ['build-storybook'], { cwd: root, stdio: 'inherit' });
        writeFileSync(DONE, new Date().toISOString());
        return true;
      } finally { try { unlinkSync(LOCK); } catch { /* already gone */ } }
    }

    // Someone is building. Waiting for the lock to go is what makes the check below safe: a build
    // cannot start again without taking it, so freshness observed here cannot be undone underneath us
    // within this process's next few milliseconds of work.
    execFileSync('sleep', ['0.3']);
  }
  throw new Error('waited 10 minutes for a Storybook build lock; remove .storybook-build.lock if stale');
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

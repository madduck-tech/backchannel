// Serves a built Storybook to the story tests. Helper, not a test.
//
// **Freshness is checked, not assumed.** A story test reading a stale bundle is the same class as the
// stale AppImage `stage2-locate-app.sh` exists for: every assertion after it is made against code
// that is not the code under test. So the newest source file is compared against the build's own
// manifest, and a stale build is rebuilt rather than reported.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
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

/** Build only when there is nothing to serve or what there is predates the sources. */
export function ensureBuilt() {
  const stale = !existsSync(MANIFEST) || statSync(MANIFEST).mtimeMs < newestSource();
  if (!stale) return false;
  execFileSync('pnpm', ['build-storybook'], { cwd: root, stdio: 'inherit' });
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

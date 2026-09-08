// The rendered state of a prototype, as something a diff can show. Helper, not a test.
//
// **Not a pixel diff, and the difference is deliberate.** Node has no PNG decoder, and adding one for
// this would be a new dependency in a repository that refused a second test runner today for less.
// Byte-comparing Chrome's PNG output fails on a different machine's antialiasing, which turns CI red
// for the renderer rather than for the design -- the classic visual-regression tax.
//
// So the baseline is the **computed** state: every element's box, its text, and a fixed set of
// properties. It is deterministic, it survives a different machine, and a diff of it says *what*
// moved rather than only that something did. What it cannot see is named in #132: rasterisation,
// antialiasing, shadows' visual result, and images.
//
// Numbers are rounded to whole pixels. A `ch`-derived width differs in the last decimal between
// Chromium builds -- #124 measured that -- and a baseline that fails on 503.98 vs 503.984 is a
// baseline nobody keeps.
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from './browser.mjs';

export const PROTOTYPES = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'design', 'prototypes'
);

/** The committed prototypes, by name without the extension. */
export const prototypeNames = () =>
  readdirSync(PROTOTYPES).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();

/** Serve `design/prototypes/` so a browser can be pointed at one. */
export async function servePrototypes() {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '');
    const file = join(PROTOTYPES, rel);
    if (!file.startsWith(PROTOTYPES) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found'); return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`,
           stop: () => new Promise((r) => server.close(r)) };
}

/** What is read from each element. Adding one invalidates every baseline, so add deliberately. */
const PROPS = [
  'display', 'position', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'color', 'backgroundColor', 'borderRadius', 'textAlign', 'overflow',
];

/** Elements worth recording: everything with a box, minus the ones that only wrap. */
// `PROPS` lives here and the function below runs in the page, so the list is interpolated rather
// than referenced. The first version referenced it and every capture died with
// `ReferenceError: PROPS is not defined` -- which took a diagnostic fix in browser.mjs to even read,
// because CDP's `exceptionDetails.text` is the bare word "Uncaught".
const CAPTURE = `() => {
  const PROPS = ${JSON.stringify(PROPS)};

  // Stop every animation and transition before measuring, and read the state they start from.
  // \`?frozen\` handles a prototype that simulates progress in JS; this handles the CSS half, which it
  // cannot. Measured without it: 114-meeting-controls drifted by a pixel on four decorative <i>
  // elements between runs — 2x5 against 2x4, 1x1 against 1x2 — because their boxes were mid-keyframe.
  // A baseline that fails on which millisecond it arrived is a baseline nobody keeps.
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;' +
    'animation-play-state:paused!important;caret-color:transparent!important}';
  document.head.appendChild(freeze);
  void document.body.offsetHeight;

  // Every scroll position back to the origin. A prototype that focuses its search field on load makes
  // the browser scroll the field into view, and whether that has happened by the time the capture runs
  // is a race: measured, the catalogue at 432px shifted 39px horizontally between runs and every one of
  // its 539 elements differed. A baseline of a scrolled page is a baseline of an accident.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  window.scrollTo(0, 0);
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollLeft) el.scrollLeft = 0;
    if (el.scrollTop) el.scrollTop = 0;
  }
  void document.body.offsetHeight;
  const round = (n) => Math.round(n);
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .replace(/\\s+/g, ' ')
      .slice(0, 120);
    out.push({
      i: i++,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').trim().slice(0, 60),
      box: [round(r.left), round(r.top), round(r.width), round(r.height)],
      text: own,
      css: PROPS.map((p) => cs[p]).join('\\u0001'),
    });
  }
  // The style strings repeat in their thousands -- an unrounded capture of one prototype was 608 KB,
  // nearly all of it identical objects. Interned, each node carries an index and the table is written
  // once. The diff below still reports per property, because it splits on the same separator.
  const table = [];
  const seen = new Map();
  for (const n of out) {
    if (!seen.has(n.css)) { seen.set(n.css, table.length); table.push(n.css); }
    n.css = seen.get(n.css);
  }
  return { viewport: [window.innerWidth, window.innerHeight], styles: table, nodes: out };
}`;

/**
 * Capture one prototype at the widths its design has to survive.
 *
 * 1096 and 432 are #118's panes; 720 is the application's minimum window. A baseline at one width is
 * a baseline that misses the case #118 was about -- a side that disappears only when the window is
 * small.
 */
export const WIDTHS = [1096, 720, 432];

export async function capture(url, { widths = WIDTHS } = {}) {
  const b = await browser();
  try {
    const shots = {};
    for (const w of widths) {
      // `frozen` asks a prototype that animates to hold its first frame. Without it the capture
      // records whichever millisecond it arrived on -- measured: "318 of 740 MB" against "312 of
      // 740 MB" between two runs of the same file.
      shots[w] = await b.evaluate(`${url}?frozen=1#w${w}`, CAPTURE, {
        readyFn: 'document.body && document.body.children.length > 0',
        viewport: { width: w, height: 900 },
      });
    }
    return shots;
  } finally {
    await b.close();
  }
}

/** Human-readable differences between two captures, or an empty array. */
export function diff(expected, actual) {
  const problems = [];
  for (const w of Object.keys(expected)) {
    const e = expected[w], a = actual[w];
    if (!a) { problems.push(`${w}px: missing from the capture`); continue; }
    if (e.nodes.length !== a.nodes.length) {
      problems.push(`${w}px: ${a.nodes.length} elements, baseline has ${e.nodes.length}`);
      continue;
    }
    for (let i = 0; i < e.nodes.length; i++) {
      const x = e.nodes[i], y = a.nodes[i];
      const where = `${w}px  ${y.tag}${y.cls ? '.' + y.cls.split(' ')[0] : ''}`;
      if (x.box.join() !== y.box.join()) {
        problems.push(`${where}  box [x y w h]: ${x.box.join(' ')} -> ${y.box.join(' ')}`);
      }
      if (x.text !== y.text) {
        problems.push(`${where}  text: ${JSON.stringify(x.text)} -> ${JSON.stringify(y.text)}`);
      }
      const xs = (e.styles[x.css] || '').split('\u0001');
      const ys = (a.styles[y.css] || '').split('\u0001');
      PROPS.forEach((p, k) => {
        if (xs[k] !== ys[k]) problems.push(`${where}  ${p}: ${xs[k]} -> ${ys[k]}`);
      });
    }
  }
  return problems;
}

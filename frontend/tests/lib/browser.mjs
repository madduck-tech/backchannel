// A real browser, driven from `node --test`. Helper, not a test (see ignored-tests-are-run).
//
// **Why this exists rather than `@storybook/test-runner`.** #124 condition 6: `pnpm test` is
// `node --test 'tests/**/*.test.mjs'` and `ignored-tests-are-run.test.mjs` machine-enforces that
// glob. A check outside it is a check this repository cannot prove it runs. The Storybook runner
// lives outside it and brings jest 30, nyc, @swc/core and @babel/core besides. This speaks CDP to a
// headless Chrome over Node 24's built-in WebSocket, so it adds no dependency at all.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.BC_CHROME || 'google-chrome';

/**
 * Every browser this process started, so none outlives it.
 *
 * `close()` alone is not enough: it runs on the happy path, and an assertion that throws skips it.
 * Measured on 2026-09-08 -- one clean `pnpm test` left 2 Chrome processes running and 69 profile
 * directories under /tmp. A test helper that leaks a browser per failure is a helper that fills a
 * developer's machine while they are debugging the failure.
 */
const LIVE = new Set();
process.on('exit', () => {
  for (const { child, profile } of LIVE) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

/**
 * Launch a headless Chrome and return { evaluate, close }.
 *
 * **Chrome picks the port, not us.** The first version derived one from the pid, and on CI three of
 * four story files failed with `never opened a debugging port` while the fourth passed: `node --test`
 * runs files concurrently, pids 500 apart collide, and a ten-second poll is not enough for four
 * browsers starting at once on a loaded runner. Passing 0 makes the kernel assign a free port and
 * Chrome writes it to `DevToolsActivePort` in its profile, which is the only collision-free source.
 */
export async function browser({ startupMs = 60000 } = {}) {
  // Said plainly and early. Without this the failure is a ten-second poll ending in "never opened a
  // debugging port", which reads like a flake rather than a missing dependency.
  try { execFileSync('which', [CHROME], { stdio: 'pipe' }); }
  catch {
    throw new Error(
      `\`${CHROME}\` is not on PATH, so the story tests cannot run.\n` +
      '  These tests drive a real browser because jsdom computes no layout (#124).\n' +
      '  Install Google Chrome, or point BC_CHROME at a Chromium binary.'
    );
  }
  const profile = mkdtempSync(join(tmpdir(), 'bc-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    // CI containers give /dev/shm 64 MB, and Chrome's default shared-memory use exceeds it.
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  const entry = { child, profile };
  LIVE.add(entry);

  // Chrome writes the port it chose here once it is listening. Polling the file is what makes this
  // free of the collisions a guessed port has, and the wait is generous because CI starts several at
  // once.
  const portFile = join(profile, 'DevToolsActivePort');
  let port = null;
  const deadline = Date.now() + startupMs;
  while (Date.now() < deadline) {
    try {
      const first = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (first) {
        await fetch(`http://127.0.0.1:${first}/json/version`);
        port = first;
        break;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) {
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
    throw new Error(
      `${CHROME} never wrote DevToolsActivePort in ${startupMs}ms.\n` +
      '  It started but never began listening; on a container check /dev/shm and the sandbox flags.'
    );
  }

  const close = async () => {
    LIVE.delete(entry);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true });
  };

  /**
   * Open `url`, wait for `readyFn` to return true, then return `readFn`'s value.
   * Both are stringified and run in the page. The wait is a poll in the page, not a sleep here:
   * a fixed sleep is how a measurement of an unrendered page reads as a measurement.
   */
  const evaluate = async (
    url, readFn,
    // The default deadline is generous on purpose, and it is **not** a tolerance being widened to
    // make something pass: the assertions' tolerance is 0.75px and unchanged. This is how long a
    // render may take on a machine that is busy. Measured 2026-09-08: with the 156-second component
    // census running alongside, two story files timed out at 25s waiting for a render that takes
    // under a second idle. A deadline set for an idle machine is a deadline that fails on a loaded
    // one, and that reads as a flake rather than as the contention it is.
    { readyFn = 'true', timeoutMs = 90000, clickFirst = null, settleMs = 400,
      viewport = null, scheme = null, contrast = null } = {}
  ) => {
    // Opened blank on purpose. Emulation has to be in place **before** the page evaluates
    // `prefers-color-scheme`, and a tab created at the URL has already navigated by the time this
    // socket is open: measured, one capture in three came back in the wrong scheme -- 629 colour
    // differences against a baseline taken seconds earlier on the same machine.
    const target = await (await fetch(
      `http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise((res) => {
      const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
    });

    const evalIn = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) {
        // `text` is usually the bare word "Uncaught"; the useful part is the exception's own
        // description, and losing it turns every page-side error into the same unhelpful line.
        const d = r.result.exceptionDetails;
        const why = d.exception?.description || d.exception?.value || d.text;
        throw new Error(`page threw: ${String(why).split('\n')[0]}\n  in: ${expr.slice(0, 100)}`);
      }
      return r.result?.result?.value;
    };

    // A width the design has to survive, set before the page is measured. Without it every capture is
    // taken at the headless default, and a baseline at one width misses the case #118 was about: a
    // side that disappears only when the window is small.
    // Never inherit the operator's desktop. CI measured 1894 differences against a baseline taken
    // here, every one a colour: this machine's Chrome answers dark to prefers-color-scheme and the
    // runner's answers light, and the capture never said which it wanted.
    //
    // `prefers-contrast` rides the same call, and must: `setEmulatedMedia` replaces the feature list
    // rather than adding to it, so two calls would leave only the second feature emulated and the
    // scheme back on the operator's desktop -- the defect the paragraph above was written about.
    if (scheme || contrast) {
      const features = [];
      if (scheme) features.push({ name: 'prefers-color-scheme', value: scheme });
      if (contrast) features.push({ name: 'prefers-contrast', value: contrast });
      await send('Emulation.setEmulatedMedia', { features });
    }
    if (viewport) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height || 900, deviceScaleFactor: 1, mobile: false });
    }

    await send('Page.enable', {});
    await send('Page.navigate', { url });

    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      try { if (await evalIn(`(async()=>{await document.fonts.ready; return Boolean(${readyFn})})()`)) {
        ready = true; break; } } catch { /* page still navigating */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ready) {
      const body = await evalIn('document.body ? document.body.innerText.slice(0,400) : "(no body)"')
        .catch(() => '(unreadable)');
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
      throw new Error(`waited ${timeoutMs}ms for \`${readyFn}\` at ${url}\n  page said: ${body}`);
    }

    // A real pointer, not `el.click()`. Radix's menu trigger listens for `pointerdown`, so a
    // synthetic click returns cleanly and opens nothing -- the "a call that returns success is not
    // evidence it did anything" shape .claude/rules/testing.md is about, and measured here: the menu
    // stayed empty and the click reported no error (#124).
    if (clickFirst) {
      const box = await evalIn(`(() => {
        const el = document.querySelector(${JSON.stringify(clickFirst)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!box) {
        ws.close();
        throw new Error(`nothing matched ${clickFirst} to click at ${url}`);
      }
      const mouse = (type, extra) => send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1, ...extra });
      await mouse('mousePressed');
      await mouse('mouseReleased', { buttons: 0 });
      await new Promise((r) => setTimeout(r, settleMs));
    }

    const value = await evalIn(`(${readFn})()`);
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    return value;
  };

  return { evaluate, close };
}

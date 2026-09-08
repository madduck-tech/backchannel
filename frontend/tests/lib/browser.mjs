// A real browser, driven from `node --test`. Helper, not a test (see ignored-tests-are-run).
//
// **Why this exists rather than `@storybook/test-runner`.** #124 condition 6: `pnpm test` is
// `node --test 'tests/**/*.test.mjs'` and `ignored-tests-are-run.test.mjs` machine-enforces that
// glob. A check outside it is a check this repository cannot prove it runs. The Storybook runner
// lives outside it and brings jest 30, nyc, @swc/core and @babel/core besides. This speaks CDP to a
// headless Chrome over Node 24's built-in WebSocket, so it adds no dependency at all.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

/** Launch a headless Chrome and return { evaluate, close }. */
export async function browser({ port = 9222 + (process.pid % 500) } = {}) {
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
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  const entry = { child, profile };
  LIVE.add(entry);

  // The port is not open the instant the process is: poll rather than sleep a guessed amount.
  let version = null;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!version) { child.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true });
    throw new Error(`${CHROME} never opened a debugging port on ${port}`); }

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
    url, readFn, { readyFn = 'true', timeoutMs = 30000, clickFirst = null, settleMs = 400 } = {}
  ) => {
    const target = await (await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
        throw new Error(`page threw: ${r.result.exceptionDetails.text} — ${expr.slice(0, 120)}`);
      }
      return r.result?.result?.value;
    };

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

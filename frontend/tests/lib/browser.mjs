// A real browser, driven from `node --test`. Helper, not a test (see ignored-tests-are-run).
//
// **Why this exists rather than `@storybook/test-runner`.** #124 condition 6: `pnpm test` is
// `node --test 'tests/**/*.test.mjs'` and `ignored-tests-are-run.test.mjs` machine-enforces that
// glob. A check outside it is a check this repository cannot prove it runs. The Storybook runner
// lives outside it and brings jest 30, nyc, @swc/core and @babel/core besides. This speaks CDP to a
// headless Chrome over Node 24's built-in WebSocket, so it adds no dependency at all.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.BC_CHROME || 'google-chrome';

/** Launch a headless Chrome and return { evaluate, close }. */
export async function browser({ port = 9222 + (process.pid % 500) } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'bc-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });

  // The port is not open the instant the process is: poll rather than sleep a guessed amount.
  let version = null;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!version) { child.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true });
    throw new Error(`${CHROME} never opened a debugging port on ${port}`); }

  const close = async () => {
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };

  /**
   * Open `url`, wait for `readyFn` to return true, then return `readFn`'s value.
   * Both are stringified and run in the page. The wait is a poll in the page, not a sleep here:
   * a fixed sleep is how a measurement of an unrendered page reads as a measurement.
   */
  const evaluate = async (url, readFn, { readyFn = 'true', timeoutMs = 30000 } = {}) => {
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

    const value = await evalIn(`(${readFn})()`);
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    return value;
  };

  return { evaluate, close };
}

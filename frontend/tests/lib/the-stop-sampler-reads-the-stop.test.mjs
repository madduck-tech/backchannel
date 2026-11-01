// `scripts/lib/stop-sampler.py`, the core pass's oracle for the stop as the window shows it (#328 item 6), run against
// a fake WebDriver that answers a scripted sequence of samples.
//
// The oracle can come back each way: it passes on stage messages and no Start before the navigation; it fails on a
// Start drawn before the navigation, or on a spinner that shows no stage message; and it says it cannot tell when no
// sample showed the spinner (the positive sentinel) or the page never navigated.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLER = path.join(repo, 'scripts', 'lib', 'stop-sampler.py');
const STAGES = ['Stopping audio capture...', 'Processing transcripts...', 'Recording stopped successfully'];

const at = (p, s, t) => ({ p, s, t });
async function run(seq, limit = 3) {
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const ok = req.method === 'POST' && req.url === '/session/x/execute/sync' && JSON.parse(body).script.includes('location.pathname');
      const v = ok ? seq[Math.min(i++, seq.length - 1)] : null;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ value: v ? JSON.stringify(v) : null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/session/x`;
  const child = spawn('python3', ['-I', SAMPLER, base, String(limit), ...STAGES]);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const code = await new Promise((r) => child.on('close', r));
  server.close();
  return { code, report: JSON.parse(out.trim() || 'null') };
}

const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

{
  const r = await run([at('/', false, 'Stopping audio capture...'), at('/', false, 'Processing transcripts... (2s elapsed)'), at('/', false, null), at('/meeting-details', true, null)]);
  check('1 stage messages and no Start before the navigation pass', r.code === 0 && r.report.stage_messages_seen.length === 2 && r.report.navigation_at_sample === 3, JSON.stringify(r));
}
{
  const r = await run([at('/', false, 'Stopping audio capture...'), at('/', true, null), at('/meeting-details', true, null)]);
  check('2 a Start drawn before the navigation fails', r.code === 1 && r.report.start_drawn_at_samples.join() === '1', JSON.stringify(r));
}
{
  const r = await run([at('/', false, 'Processing recording…'), at('/meeting-details', false, null)]);
  check('3 a spinner with no stage message fails', r.code === 1 && r.report.stage_messages_seen.length === 0, JSON.stringify(r));
}
{
  const r = await run([at('/', false, null), at('/meeting-details', false, null)]);
  check('4 no spinner in any sample cannot tell', r.code === 2, JSON.stringify(r));
}
{
  const r = await run([at('/', false, 'Stopping audio capture...')], 1);
  check('5 no navigation within the limit cannot tell', r.code === 2 && r.report.navigation_at_sample === null, JSON.stringify(r));
}

assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log('ok - the stop sampler passes the stop it should, fails a Start or a silent spinner, and cannot tell without its sentinel');

// The disk floor stands in front of every build a Claude Code session runs, not only the gate's. (#259)
//
// scripts/disk-floor-hook.sh is a PreToolUse hook on Bash (.claude/settings.json). It reads the command,
// asks scripts/lib/disk-floor-match.py whether it compiles, and if so measures the floor; below it, it
// sweeps once (keeping the session's worktree, on this repository only), measures again, and blocks
// with exit 2 only if the disk is still below. Exit 2 has that one source: it refuses the command even
// under --dangerously-skip-permissions.
//
// Every cell runs in a fixture checkout with a bare origin, under a fixture HOME and XDG_STATE_HOME, and
// starts the hook with its working directory outside every fixture worktree: #257's process check
// keeps any worktree a process works in, and Claude Code starts a hook in the session's cwd, so a hook
// started inside the worktree would keep it whatever its own code did. `cwd` reaches it only on stdin.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-floor-hook-'));
const procs = [];
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); fs.rmSync(base, { recursive: true, force: true }); });
const table = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/lib/disk-floor-hook-table.json'), 'utf8'));
const realWorktrees = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).sort();
const realLog = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'backchannel/disk-sweep.log');
const realLogBefore = fs.existsSync(realLog) ? fs.readFileSync(realLog, 'utf8') : null;
const tmpBefore = new Set(fs.readdirSync('/tmp').filter((n) => n.startsWith('backchannel-')));

const many = (commands) => JSON.parse(execFileSync('python3', ['-I', path.join(repo, 'scripts/lib/disk-floor-match.py'), '--many'], { input: JSON.stringify(commands), encoding: 'utf8' }));

// ---- the matcher, over the committed table, both ways ------------------------------------------------

test('the matcher triggers on every must-trigger cell, every gopnik.json entry that runs cargo or tauri, and the decided heredocs', () => {
  const { stage1, stage2 } = JSON.parse(fs.readFileSync(path.join(repo, 'gopnik.json'), 'utf8')).verification;
  const gate = [...stage1, ...stage2].filter((c) => c.includes('cargo ') || c.includes('tauri '));
  assert.ok(gate.length >= 12, `only ${gate.length} gopnik.json entries run cargo or tauri`);
  const heredocsOn = Object.entries(table.heredoc).filter(([, v]) => v).map(([c]) => c);
  const cells = [...table.must_trigger, ...gate, ...heredocsOn];
  const missed = cells.filter((c, i) => !many(cells)[i]);
  assert.deepEqual(missed, [], 'commands that compile and pass unguarded');
});

test('the matcher leaves alone every must-not-trigger cell, every package.json script that does not run tauri, and a heredoc that is data', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'frontend/package.json'), 'utf8')).scripts;
  const plain = Object.entries(scripts).filter(([k, v]) => !k.startsWith('_comment') && !v.includes('tauri')).map(([k]) => `pnpm ${k}`);
  assert.ok(plain.length >= 5, `only ${plain.length} package.json scripts without tauri`);
  const heredocsOff = Object.entries(table.heredoc).filter(([, v]) => !v).map(([c]) => c);
  const cells = [...table.must_not_trigger, ...plain, ...heredocsOff];
  const answers = many(cells);
  assert.deepEqual(cells.filter((c, i) => answers[i]), [], 'commands that do not compile and were caught');
});

test('census: the table\'s scripts are exactly the package.json scripts that run tauri', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'frontend/package.json'), 'utf8')).scripts;
  const tauri = Object.entries(scripts).filter(([k, v]) => !k.startsWith('_comment') && /\btauri\b|tauri-auto\.js/.test(v)).map(([k]) => k).sort();
  assert.equal(tauri.length, 13);
  assert.deepEqual([...table.package_scripts].sort(), tauri);
});

test('census: the table\'s shell scripts are exactly the frontend/*.sh and scripts/*.sh that build', () => {
  const files = [...fs.readdirSync(path.join(repo, 'frontend')).filter((f) => f.endsWith('.sh')).map((f) => `frontend/${f}`),
    ...fs.readdirSync(path.join(repo, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`)];
  const answers = many(files.map((f) => fs.readFileSync(path.join(repo, f), 'utf8')));
  const build = files.filter((f, i) => answers[i]).sort();
  assert.deepEqual([...table.shell_scripts].sort(), build, 'the scripts the matcher finds building are not the table\'s');
});

// ---- the hook, on fixtures --------------------------------------------------------------------------

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...ID, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const DAY = 24 * 3600 * 1000;
function age(dir) {
  const t = new Date(Date.now() - 2 * DAY);
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); fs.lutimesSync(p, t, t); } };
  walk(dir);
}
const SCRIPTS = ['scripts/disk-floor.sh', 'scripts/disk-sweep.sh', 'scripts/disk-floor-hook.sh', 'scripts/lib/disk-floor-default.sh',
  'scripts/lib/target-cap-default.sh', 'scripts/lib/disk-floor-match.py', 'scripts/lib/disk-floor-hook-table.json'];

// A repository with a bare origin, the hook's scripts, and `n` worktrees that are done.
function fixture(name, { n = 1, omit = [] } = {}) {
  const root = path.join(base, name);
  const origin = path.join(root, 'origin.git'); const main = path.join(root, 'main');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  for (const f of execFileSync('git', ['-C', repo, 'ls-files', '.gitignore', '*/.gitignore'], { encoding: 'utf8' }).trim().split('\n')) write(path.join(main, f), fs.readFileSync(path.join(repo, f)));
  for (const f of SCRIPTS.filter((s) => !omit.includes(s))) { write(path.join(main, f), fs.readFileSync(path.join(repo, f))); fs.chmodSync(path.join(main, f), fs.statSync(path.join(repo, f)).mode); }
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'fixture');
  git(main, 'remote', 'add', 'origin', origin); git(main, 'push', '-q', 'origin', 'main'); git(main, 'fetch', '-q', 'origin');
  const done = [];
  for (let i = 0; i < n; i++) { const p = path.join(root, `done-${i}`); git(main, 'worktree', 'add', '-q', '-b', `done-${i}`, p, 'origin/main'); done.push(p); }
  for (const p of [main, ...done]) age(p);
  const home = path.join(root, 'home'); const state = path.join(root, 'state');
  fs.mkdirSync(home, { recursive: true });
  return { root, main, done, home, state, log: path.join(state, 'backchannel/disk-sweep.log') };
}

const bin = path.join(base, 'bin');
// `df`: SHIM_DF bytes free for every path, or nothing at all with SHIM_DF=none; while SHIM_LOW_WHILE
// names a directory that exists, every path has 1000 bytes. SHIM_DF_CALLS logs each call.
write(path.join(bin, 'df'), `#!/usr/bin/env bash
[ -n "\${SHIM_DF_CALLS:-}" ] && echo "df $*" >> "$SHIM_DF_CALLS"
[ "\${SHIM_DF:-}" = none ] && exit 0
printf 'Avail\\n'
if [ -n "\${SHIM_LOW_WHILE:-}" ] && [ -d "$SHIM_LOW_WHILE" ]; then echo 1000; else echo "\${SHIM_DF:-999000000000}"; fi
`);
write(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n');
fs.chmodSync(path.join(bin, 'df'), 0o755); fs.chmodSync(path.join(bin, 'uname'), 0o755);
const shims = (names) => { const d = fs.mkdtempSync(path.join(base, 'path-')); for (const n of names) fs.symlinkSync(path.join(bin, n), path.join(d, n)); return d; };

function hookEnv(fx, env = {}) {
  const e = { ...process.env, HOME: fx.home, XDG_STATE_HOME: fx.state, XDG_DATA_HOME: path.join(fx.home, '.local/share'), XDG_CONFIG_HOME: path.join(fx.home, '.config'),
    CLAUDE_PROJECT_DIR: fx.main, BC_DISK_FLOOR_GB: '0', BC_DISK_FLOOR_LIST: fx.home, ...env };
  return e;
}
const stdin = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
function hook(fx, { command = 'cargo build', cwd = fx.main, env = {}, input } = {}) {
  const r = spawnSync('bash', [path.join(fx.main, 'scripts/disk-floor-hook.sh')], { cwd: fx.root, input: input ?? stdin(command, cwd), encoding: 'utf8', env: hookEnv(fx, env) });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* none */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, message: json?.systemMessage ?? null };
}
const RAISED = { BC_DISK_FLOOR_GB: '1000000' };
const exists = (p) => fs.existsSync(p);

test('a raised floor blocks with exit 2 and names the floor', () => {
  const fx = fixture('raised', { n: 0 });
  const r = hook(fx, { env: RAISED });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /below the 1000000 GB floor/);
  assert.match(r.stderr, /scripts\/disk-floor\.sh/);
});

test('the floor at 0 lets the command run, silently', () => {
  const fx = fixture('zero', { n: 0 });
  const r = hook(fx);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('above the floor nothing is swept', () => {
  const fx = fixture('above');
  const r = hook(fx);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(fx.done[0]), 'a removable worktree was swept above the floor');
});

test('below the floor until a worktree goes: it is swept, named in a systemMessage and logged, and the command runs', () => {
  const fx = fixture('sweeps');
  const r = hook(fx, { env: { BC_DISK_FLOOR_GB: '1', PATH: `${shims(['df'])}:${process.env.PATH}`, SHIM_LOW_WHILE: fx.done[0] } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!exists(fx.done[0]), 'the removable worktree survived a sweep below the floor');
  assert.ok(r.message?.includes(fx.done[0]), `the systemMessage does not name what was removed: ${r.stdout}`);
  assert.match(fs.readFileSync(fx.log, 'utf8'), new RegExp(`removed ${fx.done[0]} \\(`));
});

test('a free space that cannot be read: no sweep, and the fixed sentence', () => {
  const fx = fixture('blind');
  const r = hook(fx, { env: { ...RAISED, PATH: `${shims(['df'])}:${process.env.PATH}`, SHIM_DF: 'none' } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.message, 'The disk floor could not read the free space, so this command runs without the floor\'s guard.');
  assert.ok(exists(fx.done[0]), 'it swept on an unreadable floor');
});

test('a floor that breaks is not a floor that is low: BC_DISK_FLOOR_GB=20.5 passes, unswept, with a message', () => {
  const fx = fixture('broken');
  const r = hook(fx, { env: { BC_DISK_FLOOR_GB: '20.5' } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.message ?? '', /disk floor failed/);
  assert.ok(exists(fx.done[0]), 'it swept on a broken floor');
});

test('not on Linux it does nothing, and never calls df', () => {
  const fx = fixture('darwin');
  const calls = path.join(fx.root, 'df-calls');
  const r = hook(fx, { env: { ...RAISED, PATH: `${shims(['df', 'uname'])}:${process.env.PATH}`, SHIM_DF_CALLS: calls } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(!exists(calls), 'df was called on a platform the floor does not support');
});

test('a cwd in another repository: that repository\'s worktrees are not swept', () => {
  const fx = fixture('mine', { n: 0 });
  const other = fixture('other');
  const r = hook(fx, { cwd: other.main, env: RAISED });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.ok(exists(other.done[0]), 'the hook swept a repository other than its own');
});

test('a cwd inside a removable worktree keeps it', () => {
  const fx = fixture('own');
  const r = hook(fx, { cwd: fx.done[0], env: RAISED });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.ok(exists(fx.done[0]), 'the hook swept the worktree the session works in');
});

// The lock lives in disk-sweep.sh, so the gate's sweep and a hook's in another session never run at once.
async function holdLock(fx) {
  const lockFile = path.join(fx.state, 'backchannel/disk-sweep.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const h = spawn('flock', [lockFile, 'sleep', '60'], { stdio: 'ignore', detached: true }); h.unref(); procs.push(h);
  for (let i = 0; i < 100 && spawnSync('flock', ['-n', lockFile, 'true']).status === 0; i++) await new Promise((res) => setTimeout(res, 50));
  return () => { try { process.kill(-h.pid, 'SIGKILL'); } catch { h.kill('SIGKILL'); } };
}
function background(fx, file, args, input, env) {
  const p = spawn('bash', [path.join(fx.main, file), ...args], { cwd: fx.root, env: hookEnv(fx, env), stdio: ['pipe', 'pipe', 'pipe'] });
  procs.push(p); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  if (input !== null) { p.stdin.write(input); } p.stdin.end();
  const done = new Promise((res) => p.on('exit', (code) => res({ code, at: Date.now(), out })));
  return { p, done };
}

test('a hook that finds the lock held waits, then measures again without sweeping, and blocks after the release', async () => {
  const fx = fixture('held');
  const release = await holdLock(fx);
  const { done } = background(fx, 'scripts/disk-floor-hook.sh', [], stdin('cargo build', fx.main), RAISED);
  const early = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 2000))]);
  assert.equal(early, null, `the hook exited while another sweep held the lock: ${early?.out}`);
  assert.ok(exists(fx.done[0]), 'the worktree went while another sweep held the lock');
  const released = Date.now(); release();
  const r = await done;
  assert.equal(r.code, 2, r.out);
  assert.ok(r.at >= released, 'the hook exited before the release');
  assert.ok(exists(fx.done[0]), 'a hook that waited for another sweep swept after it');
});

test('the full floor finds the lock held, and waits too', async () => {
  const fx = fixture('held-full');
  const release = await holdLock(fx);
  const { done } = background(fx, 'scripts/disk-floor.sh', [], null, { ...RAISED, BC_SWEEP_REPO: fx.main });
  const early = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 2000))]);
  release();
  assert.equal(early, null, `the full floor ran its sweep while another held the lock: ${early?.out}`);
  assert.ok(exists(fx.done[0]), 'the worktree went while another sweep held the lock');
  await done;
});

test('25 removals: the systemMessage stays within 20 lines and 4000 characters, names the count and the log, and the log has all 25', () => {
  const fx = fixture('many', { n: 25 });
  const r = hook(fx, { env: { BC_DISK_FLOOR_GB: '1', PATH: `${shims(['df'])}:${process.env.PATH}`, SHIM_LOW_WHILE: fx.done[24] } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.message, r.stdout);
  assert.ok(r.message.split('\n').length <= 20 && r.message.length <= 4000, `${r.message.split('\n').length} lines, ${r.message.length} characters`);
  assert.match(r.message, /removed 25 item\(s\)/);
  assert.ok(r.message.includes(fx.log), 'the message does not give the log');
  assert.equal(fs.readFileSync(fx.log, 'utf8').trim().split('\n').length, 25);
});

test('input that is not JSON, and a checkout with no disk-floor.sh, both let the command run', () => {
  const fx = fixture('junk', { n: 0 });
  const junk = hook(fx, { input: 'not json', env: RAISED });
  assert.notEqual(junk.status, 2, junk.stderr);
  assert.match(junk.message ?? '', /could not read its input/);
  const bare = fixture('no-floor', { n: 0, omit: ['scripts/disk-floor.sh'] });
  const r = hook(bare, { env: RAISED });
  assert.notEqual(r.status, 2, r.stderr);
  assert.match(r.message ?? '', /no scripts\/disk-floor\.sh/);
});

test('settings.json runs the hook on Bash from the project directory, with a timeout', () => {
  const s = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'));
  const entries = s.hooks.PreToolUse.filter((e) => e.matcher === 'Bash').flatMap((e) => e.hooks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, '"$CLAUDE_PROJECT_DIR"/scripts/disk-floor-hook.sh');
  assert.ok(Number.isInteger(entries[0].timeout) && entries[0].timeout >= 5, `timeout ${entries[0].timeout}`);
  const code = fs.readFileSync(path.join(repo, 'scripts/disk-floor-hook.sh'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.equal((code.match(/\bexit 2\b/g) ?? []).length, 1, 'the hook exits 2 somewhere other than the block');
});

test('the real repository\'s worktrees, its sweep log and /tmp are untouched by these tests', () => {
  assert.deepEqual(execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).sort(), realWorktrees);
  assert.equal(fs.existsSync(realLog) ? fs.readFileSync(realLog, 'utf8') : null, realLogBefore);
  const created = fs.readdirSync('/tmp').filter((n) => n.startsWith('backchannel-') && !tmpBefore.has(n));
  assert.deepEqual(created, []);
});

// Every line the gate reads out of the application's log is a line the application writes. (#160)
//
// `stage2-two-channel-check.sh` carried this branch, and reached it whenever the device picker was
// merely slow:
//
//     if grep -q "Reactor error: Client disconnected" "$L" && ! grep -q "Audio devices listed\|device_list" "$L"; then
//       die "... this is the enumeration hang, not a missing control"
//
// The application logged **neither** sentinel — `list_audio_devices` returned in silence — so the
// condition reduced to "the PulseAudio reactor logged an error", which every healthy run does,
// including the three runs on 2026-09-10 that went on to pass. A slow picker was one timeout away
// from being reported as a product defect.
//
// That is the same shape as every other defect in #160: an oracle that cannot fail to accuse the
// application. `.claude/rules/testing.md` already requires a positive sentinel for an absence; this
// makes the sentinel's **existence** machine-checked, because a string nothing writes is an absence
// that can never end.
//
// The census is over the scripts, not over a hand-kept list: a new `grep … "$LOG"` has to name a
// string the Rust actually logs, or this goes red the first time it is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SCRIPTS = path.join(repo, 'scripts');
const RUST = path.join(repo, 'frontend', 'src-tauri', 'src');

/** Every .rs file under src-tauri/src, concatenated: this asks "is it written anywhere", not where. */
function rustSource(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return [rustSource(p)];
      return e.name.endsWith('.rs') ? [fs.readFileSync(p, 'utf8')] : [];
    })
    .join('\n');
}
const rust = rustSource(RUST);
assert.ok(rust.length > 100_000, `only ${rust.length} bytes of Rust read; this census has gone stale`);

/**
 * The literal part of a grep pattern: everything before the first shell interpolation or regex
 * metacharacter. `Using preferred system audio: '$PICK'` is checked as `Using preferred system audio: '`
 * — the application's format string continues with `{}` there, so anything past the interpolation is
 * not a literal either side has.
 */
function literalPrefix(pattern) {
  const cut = pattern.search(/[$\\[\]().*+?^|{}]/);
  return (cut === -1 ? pattern : pattern.slice(0, cut)).trim();
}

// A line that greps the application's log. `$LOG` and `$L` are what the passes call it; a new name
// would leave this census blind, which is why the file it points at is asserted below too.
const READS_LOG = /grep\b[^|;]*"\$(LOG|L)"/;
// The pattern is `grep`'s own first quoted argument, not any quoted string on the line: these lines
// are often `say "the app opened: $(grep -o "…" "$LOG")"`, and the outer string is a sentence.
const GREP_PATTERN = /grep\s+(?:-\w+\s+)*(["'])((?:(?!\1).)*)\1/g;

const scripts = fs
  .readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('stage2-') && f.endsWith('.sh'))
  .map((f) => ({ name: f, src: fs.readFileSync(path.join(SCRIPTS, f), 'utf8') }));

const oracles = [];
for (const { name, src } of scripts) {
  src.split('\n').forEach((line, i) => {
    if (!READS_LOG.test(line) || /^\s*#/.test(line)) return;
    for (const m of line.matchAll(GREP_PATTERN)) {
      const raw = m[2];
      // `"$LOG"` itself is the file, not a pattern.
      if (!raw || raw.startsWith('$') || raw.length < 8) continue;
      const literal = literalPrefix(raw);
      if (literal.length >= 8) oracles.push({ where: `${name}:${i + 1}`, pattern: raw, literal });
    }
  });
}

assert.ok(
  oracles.length >= 6,
  `only ${oracles.length} log-reading oracles found across ${scripts.length} passes; ` +
    `six were there on 2026-09-10, so either a pass stopped reading the log or this census has gone blind`
);

const unwritten = oracles.filter((o) => !rust.includes(o.literal));
assert.deepEqual(
  unwritten.map((o) => `${o.where} greps '${o.pattern}'`),
  [],
  `these oracles read lines the application never writes, so their verdict about it cannot be earned:\n  ` +
    unwritten.map((o) => `${o.where}  '${o.literal}'`).join('\n  ')
);

console.log(
  `ok - ${oracles.length} oracles read the application's log across ${scripts.length} Stage 2 passes, ` +
    `and every string they look for is one the Rust writes`
);

// The live transcription worker emitted `transcript-partial` for the whole
// streaming path and nothing in the frontend listened. Nothing threw — the
// uncommitted text was just dropped, so a streaming model looked exactly like a
// batch one. Same shape as download-event-names.test.mjs, other direction:
// every event the transcription sink (adapters/tauri_sink.rs) emits must have a
// frontend listener. stream_worker.rs was split into ports + adapters in 3a4ac3a.
//
// #328 extends the denominator to the recording commands and the tray, which it edits (ADR 0022): the stop's
// progress went unrendered for the same reason. An event that has no listener yet is excused here with the issue
// that owns it, and the excuse fails as stale once a listener exists or the event is no longer emitted.
//
// And `recording-stop-complete` exists nowhere: the tray emitted it after its own Stop, and the window saved a second
// time on it (#328 item 3). The event-name census could not hold its removal, since it checks only that what is
// emitted is listened to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readAll(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return readAll(full, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [fs.readFileSync(full, 'utf8')] : [];
  });
}

const rust = (...p) => fs.readFileSync(path.join(root, 'src-tauri', 'src', ...p), 'utf8');
const EMITTERS = {
  'audio/transcription/adapters/tauri_sink.rs': rust('audio', 'transcription', 'adapters', 'tauri_sink.rs'),
  'audio/recording_commands.rs': rust('audio', 'recording_commands.rs'),
  'tray.rs': rust('tray.rs'),
};
const ts = readAll(path.join(root, 'src'), ['.ts', '.tsx']).join('\n');

// Emitted, with no listener yet, and the issue that owns each.
const UNLISTENED = {
  'recording-warning': '#225: the missing-device notice, variant A′',
  'recording-error': '#330: a capture error during a recording',
};

const failures = [];
const emitted = new Set();
for (const [file, src] of Object.entries(EMITTERS)) {
  // `\s*` because the payload often pushes the name onto its own line.
  const names = [...src.matchAll(/\.emit(?:_to)?\(\s*(?:"[a-z]+",\s*)?"([a-z0-9-]+)"/g)].map((m) => m[1]);
  if (names.length === 0 && file !== 'tray.rs') failures.push(`${file} emits nothing the census can read`);
  for (const name of names) emitted.add(name);
}
const listened = (name) => new RegExp(`listen(<[^>]*>)?\\(\\s*['"\`]${name}['"\`]`).test(ts);
for (const name of emitted) {
  if (!listened(name) && !UNLISTENED[name]) failures.push(`"${name}" is emitted but no frontend code listens for it`);
}
for (const [name, owner] of Object.entries(UNLISTENED)) {
  if (!emitted.has(name)) failures.push(`the excuse for "${name}" (${owner}) is stale: nothing emits it`);
  else if (listened(name)) failures.push(`the excuse for "${name}" (${owner}) is stale: a listener exists`);
}
const everything = readAll(path.join(root, 'src-tauri', 'src'), ['.rs']).join('\n') + ts;
if (everything.includes('recording-stop-complete')) failures.push('"recording-stop-complete" still occurs in src-tauri/src or src');

assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
console.log(`ok - ${emitted.size} events wired or excused:`, [...emitted].sort().join(', '));

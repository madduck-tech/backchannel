// A transcript row's capture channel crosses four languages between where it is
// known and where it is read: a Rust enum, a JSON event field, a TypeScript
// type, and a SQLite column. Each hop is a plain string, and nothing but this
// file makes the four agree.
//
// The hop that has already failed once in this repository is the last one. ADR
// 0004's mic/sys loudness heuristic wrote its verdict into `transcripts.speaker`
// — the same column `audio/diarization.rs` rewrites for *every* row of a
// meeting, binding NULL where nothing overlapped. Anything channel-shaped stored
// there is erased by the next diarization pass, silently. So this test also
// holds the separation: `channel` is its own column, and the diarization UPDATE
// must not touch it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const ports = read('src-tauri', 'src', 'audio', 'transcription', 'ports.rs');
const sink = read('src-tauri', 'src', 'audio', 'transcription', 'adapters', 'tauri_sink.rs');
const types = read('src', 'types', 'index.ts');
const repo = read('src-tauri', 'src', 'database', 'repositories', 'transcript.rs');
const diarization = read('src-tauri', 'src', 'audio', 'diarization.rs');

// ---------------------------------------------------------------- the values

// The strings themselves, taken from `Channel::label` rather than restated.
const labels = [...ports.matchAll(/Channel::(You|Others)\s*=>\s*"([a-z]+)"/g)].map((m) => m[2]);
assert.deepEqual(
  labels.sort(),
  ['others', 'you'],
  'ports.rs Channel::label no longer produces exactly "you" and "others". Those two strings are ' +
    'the wire format: they go out on transcript-update, into the TypeScript union below, and into ' +
    'the transcripts.channel column. Change all four together or none.'
);

// ------------------------------------------------------- Rust event -> TS type

assert.match(
  sink,
  /pub struct TranscriptUpdate\b[\s\S]*?pub channel: Option<String>/,
  'TranscriptUpdate no longer carries `channel`, so the channel a decoder knows never leaves Rust'
);
assert.match(
  sink,
  /channel: chunk\.channel\.map\(\|c\| c\.label\(\)\.to_string\(\)\)/,
  'tauri_sink no longer fills TranscriptUpdate.channel from the chunk, so the field would ship as ' +
    'a permanent null'
);

// Both TypeScript shapes: the event as received, and the row as stored and sent
// back to `api_save_transcript`. Missing it on `Transcript` is the quiet
// failure — the event arrives with a channel and the row saved from it has none.
for (const iface of ['Transcript', 'TranscriptUpdate']) {
  const body = types.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(body, `types/index.ts no longer declares ${iface}`);
  assert.match(
    body[1],
    /channel\?: 'you' \| 'others';/,
    `${iface} does not declare \`channel?: 'you' | 'others'\`, so the value is dropped on this hop`
  );
}

// ------------------------------------------------------------ TS -> the column

const insert = repo.match(/INSERT INTO transcripts \(([^)]*)\)\s*\n?\s*VALUES \(([^)]*)\)/);
assert.ok(insert, 'transcript.rs no longer has a recognisable INSERT INTO transcripts');
const columns = insert[1].split(',').map((c) => c.trim());
const placeholders = insert[2].split(',').map((c) => c.trim());
assert.ok(columns.includes('channel'), 'the transcripts INSERT does not write the channel column');
assert.equal(
  columns.length,
  placeholders.length,
  `the transcripts INSERT binds ${placeholders.length} values for ${columns.length} columns`
);
assert.match(
  repo,
  /\.bind\(&segment\.channel\)/,
  'the transcripts INSERT names the channel column but binds nothing to it'
);

// The column has to exist before anything can be written to it.
const migrations = fs
  .readdirSync(path.join(root, 'src-tauri', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(root, 'src-tauri', 'migrations', f), 'utf8'))
  .join('\n');
assert.match(
  migrations,
  /ALTER TABLE transcripts ADD COLUMN channel TEXT/,
  'no migration adds transcripts.channel, so the INSERT above fails at runtime on every install'
);

// ------------------------------------------- diarization must not erase it

const update = diarization.match(/UPDATE transcripts SET ([^"]*) WHERE/);
assert.ok(update, 'diarization.rs no longer has a recognisable UPDATE transcripts');
assert.equal(
  update[1].trim(),
  'speaker = ?',
  'the diarization pass now writes more than `speaker`. It runs over every row of a meeting and ' +
    'binds NULL where nothing overlapped, so anything else it touches is erased for rows the ' +
    'diarizer did not hear. The channel is a fact of capture and must survive it.'
);
assert.match(
  diarization,
  /channel: row\.channel\.clone\(\)/,
  'diarization.rs rewrites the meeting transcript files without carrying the channel across, so a ' +
    'diarization pass would blank it in transcripts.json and transcript.md'
);

console.log(
  'ok - transcript channel: Channel::label, transcript-update, both TS interfaces, the ' +
    'transcripts.channel column and its migration agree, and diarization leaves it alone'
);

// "Damaged download — {on disk} MB on disk of {size_mb} MB" compares one unit with itself. (#175)
//
// `size_mb` is decimal MB of the file's bytes since #175, and the engine's floor reads it so
// (`TranscribeEngine::available_floor_bytes`). The on-disk figure used to divide by 1024², so the
// August multitalker Q8, 734 123 712 bytes, read "700 MB on disk of 873 MB". It is the file
// whose row #175 holds; any truncated file shows the same skew.
import assert from 'node:assert/strict';
import { setupDom } from './dom-harness.mjs';

await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');
const { corruptedSizeMb } = loadTsx('src/lib/transcribe.ts', {
  '@tauri-apps/api/core': { invoke: async () => null },
  '@tauri-apps/api/event': { listen: async () => () => {} },
});

const corrupted = (file_size) => ({ Corrupted: { file_size, expected_min_size: 786_099_110 } });

assert.equal(corruptedSizeMb(corrupted(734_123_712)), 734, 'the August multitalker Q8 on disk, in decimal MB');
assert.equal(corruptedSizeMb(corrupted(52_000_000)), 52, 'a truncated canary-180m-flash, in decimal MB');
// Not damaged: no figure at all.
assert.equal(corruptedSizeMb('Available'), null);
assert.equal(corruptedSizeMb({ Downloading: { progress: 50 } }), null);

console.log('ok - the damaged-download figure is decimal MB, the unit size_mb and the floor read');

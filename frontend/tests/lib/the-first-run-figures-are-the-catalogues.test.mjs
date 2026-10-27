// First run states the size, the WER and the language count of four models from its own constants
// (`onboarding-transcribe-models.ts`). Each must equal the model's row in the generated catalogue,
// or one file has two sizes on one screen: first run's card against the catalogue's row (#146, and
// again after #175 regenerated the catalogue in decimal MB while these four kept the MiB figures).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom } from './dom-harness.mjs';

await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');
const { RECOMMENDED_TRANSCRIBE_MODELS } = loadTsx('src/lib/onboarding-transcribe-models.ts');

const config = readFileSync(new URL('../../src-tauri/src/config.rs', import.meta.url), 'utf8');
const region = config.slice(config.indexOf('// BEGIN GENERATED'), config.indexOf('// END GENERATED'));
function row(name) {
  const block = region.split(`name: "${name}"`)[1]?.split('    },')[0];
  assert.ok(block, `${name} is not a catalogue row`);
  const wer = block.match(/wer: Some\(([\d.]+)\)/);
  return {
    size_mb: Number(block.match(/size_mb: (\d+),/)[1]),
    wer: wer ? Number(wer[1]) : null,
    languages: [...block.match(/languages: &\[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  };
}

const models = Array.from(RECOMMENDED_TRANSCRIBE_MODELS);
assert.equal(models.length, 4, 'precondition: first run offers four models');
const wrong = [];
for (const m of models) {
  const r = row(m.id);
  if (m.mb !== r.size_mb) wrong.push(`${m.id}: first run says ${m.mb} MB, the catalogue ${r.size_mb} MB`);
  if (m.wer !== r.wer) wrong.push(`${m.id}: first run says ${m.wer}% WER, the catalogue ${r.wer}%`);
  const count = m.languages.match(/^(\d+) /);
  if (m.languages === 'English only' ? r.languages.join() !== 'en' : !count || Number(count[1]) !== r.languages.length) {
    wrong.push(`${m.id}: first run says "${m.languages}", the catalogue lists ${r.languages.length} languages`);
  }
}
assert.deepEqual(wrong, [], `first run's figures are not the catalogue's:\n  ${wrong.join('\n  ')}`);
console.log("ok - first run's four models state the catalogue's size, WER and language count");

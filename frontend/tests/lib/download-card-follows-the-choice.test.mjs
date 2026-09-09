// The download screen reports the model that is actually being fetched. (#146)
//
// The product owner photographed this screen showing `0.0 of 716.0 MB` at 0% for the transcription
// card while the toast beside it read `18.6 / 33.8 MB … 55%`. Two separate faults meet there:
//
//   1. the card's listeners match `DEFAULT_TRANSCRIBE_MODEL`, so an event for any other model
//      matches nothing and the bar never moves;
//   2. the size is a literal, and it is not even the default's — the first screen advertises
//      parakeet at 740 MB and the card says 716, which is *nemotron's* size.
//
// The second is what this file measures, because it is wrong with no download in flight and with the
// default model chosen: the two screens of one flow disagree about how big the same file is.
//
// `stage2-onboarding-check.sh` cannot see either. Its oracle is the file on disk -- deliberately,
// "a progress bar is a claim by the same code under test; a file is not" -- so the download was
// correct and the report of it was not, and the pass was green throughout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SHARED = 'src/lib/onboarding-transcribe-models.ts';
const STEP = 'src/components/onboarding/steps/TranscriptionModelStep.tsx';
const CARD = 'src/components/onboarding/steps/DownloadProgressStep.tsx';

const DEFAULT = /DEFAULT_TRANSCRIBE_MODEL = '([^']+)'/.exec(read('src/constants/modelDefaults.ts'))?.[1];
assert.ok(DEFAULT, 'modelDefaults.ts no longer declares DEFAULT_TRANSCRIBE_MODEL; this check is stale');

// --- one place holds a size, and both screens read it from there ------------------------------------
//
// Deliberately *not* "the two files state the same number": that check would pass on two copies that
// happen to agree today, which is the state this defect was born in. It asserts the shape instead —
// one source, no literals anywhere else — so a second copy cannot be introduced at all.
const shared = read(SHARED);
const sizes = [...shared.matchAll(/\bmb:\s*(\d+)/g)].map((m) => Number(m[1]));
assert.ok(sizes.length >= 4, `${SHARED} declares ${sizes.length} sizes; this check is stale`);
assert.ok(
  new RegExp(`id:\\s*'${DEFAULT}'`).test(shared),
  `${SHARED} does not carry the default model ${DEFAULT}; this check is stale`
);

for (const [file, what] of [[STEP, 'the screen that offers the models'], [CARD, 'the screen that fetches them']]) {
  const src = read(file);
  // Comments stripped: a control for a check of this shape was once satisfied from inside a `//`.
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.match(
    code, /from '@\/lib\/onboarding-transcribe-models'/,
    `${what} (${file}) does not read the shared model list. A second copy of a file's size is how\n` +
      '  one screen came to advertise 740 MB while the other stated 716 — which is a third model\n' +
      '  entirely — for the same download.'
  );
  const literals = [...code.matchAll(/(?:totalMb:\s*|~)(\d{2,5})\s*MB?\b/g)].map((m) => m[1]);
  assert.deepEqual(
    literals, [],
    `${what} (${file}) states a size as a literal: ${literals.join(', ')}. Sizes live in ${SHARED}.`
  );
}

// --- and the fetching screen follows the choice, not a constant -------------------------------------
const cardCode = read(CARD).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
const pinned = [...cardCode.matchAll(/modelName\s*===\s*DEFAULT_TRANSCRIBE_MODEL/g)].length;
assert.equal(
  pinned, 0,
  `${pinned} listener(s) in ${CARD} compare an event's modelName against DEFAULT_TRANSCRIBE_MODEL.\n` +
    '  Choose any other model and none of them match: the bar sits at 0% for the whole download,\n' +
    '  which is what was photographed. `OnboardingContext` already tracks the choice; the screen has\n' +
    '  its own duplicate listeners, and they were not part of ceb57a1.'
);

console.log(
  `ok - ${sizes.length} model sizes live in one file, both first-run screens read them from there, ` +
    'and no listener is pinned to a constant'
);

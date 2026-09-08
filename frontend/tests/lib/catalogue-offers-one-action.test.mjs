// The catalogue carries what the product owner asked for, and nothing they asked to be removed. (#138)
//
// Four removals and one behavioural change, all given on 2026-09-08 and recorded on the issue before
// they were asserted, per ADR 0022 decision 4:
//
//   "installed only, sort by — remove them"       -> the switch, the select, and the empty-state copy
//   "the subtitle is nonsense — it explained WER" -> the paragraph about quality tiers
//   "why does the download start right here?"     -> a row click selects; it does not fetch
//
// **Rendered through `gallery.mjs`'s capped child process, not in this one.** A first version mounted
// the component here with hand-rolled stubs and never terminated: measured, it ran 60s under a 2 GB
// cap without finishing, and uncapped it reached 27 GB of anonymous RSS and was OOM-killed — taking
// the editor with it three times. `gallery.mjs`'s header names this exact hazard ("a component mounted
// inside ten real providers is exactly the shape that loops") and its child runs under
// `MemoryMax=1280M` with swap off for that reason. This test uses that path instead of rebuilding it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCards, KIND } from './gallery.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = (p) => fs.readFileSync(path.join(here, '..', '..', p), 'utf8');

const MANAGER = 'src/components/TranscriptionModelManager.tsx';
const STEP = 'src/components/onboarding/steps/TranscriptionModelStep.tsx';
const SETTINGS = 'src/components/TranscriptSettings.tsx';

// --- what the catalogue renders -------------------------------------------------------------------
const [card] = buildCards([MANAGER]);
assert.equal(
  card.kind, KIND.drawn,
  `the catalogue did not render (${card.kind}): ${card.reason ?? ''}`
);
const html = card.html.replace(/\s+/g, ' ');

assert.ok(!/Sort models by|>Sort by</.test(html), 'the sort control is still on the catalogue');
assert.ok(!/Installed only/.test(html), 'the installed-only filter is still on the catalogue');
assert.ok(
  !/Quality is a tier|word error rate/i.test(html),
  'the catalogue still explains word error rate on a first-run screen'
);
assert.ok(
  /Search transcription models/.test(html),
  'the search field is gone — it is the one control that was asked to stay'
);

// --- and the copy that referred to a control that is now absent ------------------------------------
assert.ok(
  !/Turn off .Installed only./.test(src(MANAGER)),
  'the empty state still tells the person to turn off a control that no longer exists'
);

// --- the row count, which lives on the step rather than the catalogue -------------------------------
assert.ok(
  !/\b86\b/.test(src(STEP).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
  'the first-run screen still renders the number of rows in the catalogue'
);

// --- a row click in onboarding does not fetch, and Settings still can -------------------------------
//
// Declaration checks, in the shape `transcript-matches-the-prototype.test.mjs` uses, because
// `renderOne` mounts with no props and the mode is a prop. The pair is what matters: the second
// assertion is the one a naive fix fails, since `TranscriptSettings.tsx` mounts the same component and
// has no Continue -- deleting the button outright would leave it unable to download a model at all.
const manager = src(MANAGER);
assert.match(
  manager, /canDownload/,
  'the catalogue offers the same actions everywhere; onboarding needs a mode that hides Download'
);
assert.match(
  src(STEP), /canDownload=\{false\}/,
  'the first-run screen does not turn the per-row Download off'
);
assert.ok(
  !/canDownload=\{false\}/.test(src(SETTINGS)),
  'Settings turned its own Download off. It has no Continue, so a person there could no longer\n' +
    '  download a model at all — and the assertion above passes on exactly that regression.'
);

console.log('ok - the catalogue offers search and one action per row, and Settings keeps Download');

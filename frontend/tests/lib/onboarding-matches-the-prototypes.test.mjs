// The three first-run screens encode what their approved prototypes decided. (#138 condition 5)
//
// **A declaration check, in the shape `transcript-matches-the-prototype.test.mjs` set**, and named as
// one: it reads values out of the committed prototype and asserts the implementation carries the same
// decision. It cannot lay anything out. The geometry half lives in the story tests beside it.
//
// It is deliberately *not* the baseline mechanism from #132. That compares a prototype to a capture of
// itself, node by node by array index, and bails on a count mismatch — the React screens have neither
// the node count nor the DOM order nor the text. The issue's first version proposed "adding the
// implementations to the same comparison"; it is not a comparison they can enter, and the failure mode
// would have been an implementer capturing a baseline *of the React screen* and committing it as the
// target, which pins a guess and calls it the approved design.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const proto = (n) => fs.readFileSync(path.join(root, 'design', 'prototypes', `${n}.html`), 'utf8');
const impl = (p) => fs.readFileSync(path.join(root, 'frontend', p), 'utf8');

const checks = [];
const holds = (what, cond, why) => {
  checks.push(what);
  assert.ok(cond, `${what}\n  ${why}\n  The prototype in design/prototypes/ is the source of truth —\n` +
    '  change it first, with the product owner, then follow it here.');
};

// --- the catalogue: one field above the list, and nothing else --------------------------------------
{
  const p = proto('onboarding-catalogue');
  const inputs = (p.match(/<input/g) || []).length;
  assert.equal(inputs, 1, `the approved catalogue has ${inputs} inputs; this check assumes exactly one`);

  const manager = impl('src/components/TranscriptionModelManager.tsx');
  holds(
    'the catalogue offers one text input, as the prototype does',
    (manager.match(/<input/g) || []).length === 1,
    'The approved design has a single search field. A second control above the list is one more thing\n' +
      '  to read before the rows start, which is what the product owner rejected.'
  );
  holds(
    'and no control that sorts or filters the rows',
    !/Sort models by|Show only installed/.test(manager),
    'Removed on instruction; the prototype has neither.'
  );
}

// --- the download screen: Continue waits for the files ----------------------------------------------
//
// The screen's other decision -- a file already on disk is stated in words rather than drawn as a bar
// over a zero counter -- is **not** asserted here. It cannot be: a source regex for that wording also
// matches `parakeetDownloaded` (13 occurrences) and two `console.log` lines, which is how a control
// for it came back green against a component that renders nothing of the sort. It is asserted on the
// rendered page instead, in `storybook-download-states.test.mjs`.
{
  const p = proto('onboarding-download');
  holds(
    'the approved download screen keeps Continue off until every file has arrived',
    /data-next\b[^>]*\bdisabled\b/.test(p) && /\[data-next\]'\)\.disabled = !finished\(\)/.test(p),
    'It ships disabled and is enabled by `finished()`; both halves are read out of the prototype.'
  );

  const step = impl('src/components/onboarding/steps/DownloadProgressStep.tsx');

  // A completion that arrives from the wire marks the row fetched; a completion that is a *discovery*
  // of a file already on disk must not. Both end at `status: 'completed'`, and the screen renders
  // them differently, so this is the seam that decides which sentence a person reads.
  //
  // `model-download-complete` reached `status: 'completed'` without the flag when this was written:
  // a download whose progress events were missed would have ended on "Already here from an earlier
  // install". The rendered check cannot see this path -- stories stub `invoke`, not `listen`.
  // Comments are stripped first. A control for the earlier version of this check put its string in a
  // `//` comment, the check stayed green, and the page rendered nothing of the sort.
  const code = step.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const handler = (name) => {
    const at = code.indexOf(`'${name}'`);
    assert.notEqual(at, -1, `DownloadProgressStep.tsx no longer handles ${name}; this check is stale`);
    return code.slice(at, at + 400);
  };
  holds(
    'a completion that came from the wire marks the row as fetched',
    /status: 'completed'[^}]*fetched: true/.test(handler('model-download-complete')),
    'A row that finished because bytes arrived must not then tell the person the file was already\n' +
      '  here from an earlier install, about a download they watched run.'
  );
  holds(
    'and discovering a file already on disk does not',
    !/fetched: true/.test(handler('[DownloadProgressStep] Model available but state not updated')),
    'The two paths that only *notice* a present model would otherwise claim its whole size was\n' +
      '  fetched this run — the reverse of the same lie.'
  );

  // **This assertion changed with #154, and what it said before is stated because it guarded
  // behaviour the same change rewrote** (ADR 0022: a check may not be pointed at the change by the
  // change). It used to read:
  //
  //     /disabled=\{!parakeetDownloaded \|\| waitingForSummary/.test(step)
  //
  // — the gate #111 cycle B built, which also waits for the summary model. The prototype's own gate
  // is `finished = () => T.done >= T.mb` over the **transcription** file, and its footer reads
  // "Continue is available when it has arrived". The old assertion encoded a decision the approved
  // design does not make, and on screen it produced the contradiction the product owner
  // photographed: "You can continue while this finishes" above a button disabled for the summary.
  holds(
    'the download screen gates Continue on the transcription model, as the prototype does',
    /disabled=\{!finished \|\| isCompleting\}/.test(step) &&
      /const finished = parakeetDownloaded \|\|/.test(step) &&
      !/waitingForSummary/.test(step),
    'A person who continues without the transcription model reaches a recorder that cannot\n' +
      '  transcribe, so the gate stays — on that file. Waiting for the summariser as well is what\n' +
      '  the approved design removed, and the third clause is what stops it coming back.'
  );
}

// --- the summariser: the chosen option is scrolled to the top, not the field into minimum view -------
{
  const p = proto('onboarding-summariser');
  holds(
    'the approved summariser scrolls the chosen option to the top',
    /scrollTop\s*=\s*Math\.max\(0,\s*o\.offsetTop/.test(p),
    'This is the decision it makes about the reveal, and it is what this check follows.'
  );

  const step = impl('src/components/onboarding/steps/SummariserStep.tsx');
  holds(
    'the summariser scrolls the chosen option, not the field',
    // The identifier changed with #154 (`option` -> `opt`, matching the prototype's own `o`); the
    // decision did not, and it is the decision this pins: the chosen row goes to the top of the
    // scrolling region, by `offsetTop`, not by a minimum-distance scroll.
    /scrollTop\s*=\s*Math\.max\(0,\s*\w+\.offsetTop/.test(step),
    '`scrollIntoView` on the field scrolls the minimum distance, which on a 520px window leaves the\n' +
      '  option itself out of view — the person cannot see what they chose.'
  );
}

console.log(`ok - ${checks.length} decisions the three approved prototypes make are encoded in the screens`);

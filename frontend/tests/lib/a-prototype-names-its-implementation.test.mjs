// Every approved prototype says what it is the design for. (ADR 0024 decision 1, #157 measure D)
//
// **A committed prototype that nothing implements is invisible.** ADR 0022 decision 5 says a screen
// without a committed prototype is not implemented; the inverse had no rule. So
// `onboarding-download.html` and `onboarding-summariser.html` sat in `main` from 2026-09-08 with
// baselines beside them while the screens they describe stayed as they came from the fork, and
// `prototypes-match-their-baseline.test.mjs` was green throughout — correctly, because it compares a
// prototype to a capture of *itself*. The product owner found it by walking first run and asking
// where the design had gone.
//
// So each prototype names one of two things, in its own file: the component it is the design for, or
// the issue that owes that component. Naming neither is red, and naming a component that does not
// exist is red — which is what makes this more than a comment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROTOTYPES = path.join(root, 'design', 'prototypes');

const files = fs.readdirSync(PROTOTYPES).filter((f) => f.endsWith('.html'));
assert.ok(files.length >= 5, `only ${files.length} prototypes found; this check has gone stale`);

/**
 * The line each prototype carries, in a comment near its top:
 *
 *     Implemented by: frontend/src/components/onboarding/steps/SummariserStep.tsx
 *     Implemented by: nothing yet — #154
 *
 * A path is checked to exist. An issue is checked to look like one; whether it is open is GitHub's
 * to know and this file does not reach the network.
 */
const CLAIM = /Implemented by:\s*(.+)/;

const problems = [];
for (const f of files) {
  const head = fs.readFileSync(path.join(PROTOTYPES, f), 'utf8').slice(0, 4000);
  const m = CLAIM.exec(head);
  if (!m) {
    problems.push(
      `${f} — no "Implemented by:" line in its first 4000 characters. A prototype is a claim that a ` +
        'screen exists; say which, or say which issue owes it.'
    );
    continue;
  }
  const claim = m[1].trim().replace(/\s*(-->|\*\/).*$/, '').trim();
  if (/^nothing yet\b/i.test(claim)) {
    if (!/#\d+/.test(claim)) {
      problems.push(`${f} — says "nothing yet" and names no issue: ${claim}`);
    }
    continue;
  }
  for (const p of claim.split(/\s*,\s*/)) {
    if (!fs.existsSync(path.join(root, p))) {
      problems.push(`${f} — names ${p}, which does not exist`);
    }
  }
}

assert.deepEqual(
  problems, [],
  'a prototype does not say what it is the design for:\n  ' + problems.join('\n  ') + '\n\n' +
    '  ADR 0024 decision 1. Two prototypes were approved on 2026-09-08 and built on 2026-09-10,\n' +
    '  and nothing in between could tell.'
);

console.log(`ok - ${files.length} approved prototypes, each naming the implementation it describes`);

// A click the driver refused must not report success.
//
// `.claude/rules/testing.md`: *"A call that returns success is not evidence it did anything."* This is
// that rule one level down -- `stage2-record-check.sh`'s `click_labelled` discarded the click's exit
// status entirely (`>/dev/null 2>&1`) and then printed `clicked '<label>'`, so a refused click and a
// delivered one were the same event to every caller. Measured on 2026-09-08 (#130).
//
// **This executes the function, it does not read it.** The repository's other script checks assert
// over source text, which is right where the script cannot be run. This one can be: the function is
// extracted, given a fake driver, and called. A regex saying `if !` appears somewhere would pass
// against a script that still swallowed the status.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const script = fs.readFileSync(path.join(repo, 'scripts/stage2-record-check.sh'), 'utf8');

/** Lift one shell function out by brace depth. Loud if the anchor moved. */
function shellFunction(name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name}() is no longer in stage2-record-check.sh under that name`);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  assert.fail(`${name}() has no closing brace`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-click-'));
fs.writeFileSync(path.join(tmp, 'pid'), '1\n');

/**
 * Run `click_labelled` against a fake driver.
 * `clickExit` is what the driver returns for `computer click`; `label` is what its tree offers.
 */
function clickLabelled({ want, clickExit = 0, label = 'Start recording', timeout = 2 }) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'orca-ide'),
    `#!/usr/bin/env bash\n` +
      `case "$2" in\n` +
      `  get-app-state) printf '{"result":{"snapshot":{"treeText":"    7 push button ${label}\\\\n"}}}\\n' ;;\n` +
      `  click) exit ${clickExit} ;;\n` +
      `esac\n`,
    { mode: 0o755 }
  );
  const harness =
    `set -uo pipefail\n` +
    `PIDFILE="${path.join(tmp, 'pid')}"\n` +
    `say() { printf 'say: %s\\n' "$*"; }\n` +
    `die() { printf 'die: %s\\n' "$*" >&2; exit 1; }\n` +
    `${shellFunction('tree')}\n${shellFunction('click_labelled')}\n` +
    `click_labelled ${JSON.stringify(want)} ${timeout}; echo "STATUS=$?"\n`;
  const out = execFileSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { status: Number(/STATUS=(\d+)/.exec(out)[1]), out };
}

// --- a delivered click succeeds -------------------------------------------------------------------
{
  const { status } = clickLabelled({ want: 'Start recording', clickExit: 0 });
  assert.equal(status, 0, 'a label that is present and a click that lands must succeed');
}

// --- a refused click is a failure -----------------------------------------------------------------
{
  const { status, out } = clickLabelled({ want: 'Start recording', clickExit: 1 });
  assert.notEqual(
    status, 0,
    'the driver refused the click and click_labelled reported success. Output was:\n' + out
  );
  assert.doesNotMatch(
    out, /^say: clicked/m,
    'it printed "clicked" for a click that never landed'
  );
}

// --- a label that is not there is a failure, and a distinguishable one -----------------------------
{
  const { status } = clickLabelled({ want: 'Get Started', label: 'Start recording' });
  assert.equal(status, 1, 'a missing label must be its own status, not the same one as a refused click');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok - a refused click and a missing label are both failures, and are different ones');

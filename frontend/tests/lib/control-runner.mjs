// Runs a control and refuses to believe it worked.
//
// A control is the only thing separating a test from scaffolding, and until now nothing in this
// repository ran one: they were bash typed by hand into a pull request body. On 2026-09-06 that
// produced nine failures in one session, eight of them caught by ad-hoc printing that happened to be
// there. #94 has the table.
//
// The job here is narrow on purpose. This does **not** find unprotected code — a control table is an
// input, and what a change *should* have controlled is a different question that belongs to a
// mutation tool. What this does is check the four things that are properties of the control
// *procedure* rather than of coverage, which no mutation tool can observe because it cannot fail to
// write a file:
//
//   * did the mutation actually land,
//   * was the line still what the table said before it was touched,
//   * did the check actually go red,
//   * was the file restored, byte for byte.
//
// Every verdict below is a distinct failure mode with its own name, because "the control did not
// work" is not actionable and the four causes want different fixes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** What a control can come back as. `ok` is the only one that is not a defect. */
export const VERDICT = {
  ok: 'ok',
  /** The line no longer contains what the table says it does. Line numbers drift; anchors do not. */
  anchorDrift: 'anchor-drift',
  /** The file on disk is unchanged after the mutation was applied. The 2026-09-06 row-1 defect. */
  mutationDidNotLand: 'mutation-did-not-land',
  /** The check passed with the code mutated. The control proves nothing. */
  checkStayedGreen: 'check-stayed-green',
  /** The check died without asserting — out of memory, or killed by the timeout. Red, but not
   *  readable, and three components already have a mutation that does exactly this. */
  diedWithoutAsserting: 'died-without-asserting',
  /** The file is not byte-identical to what it was. A mutation left in the tree cost six OOM kills
   *  of the IDE on 2026-09-06 before anyone noticed it was still there. */
  notRestored: 'not-restored',
};

const DEFAULTS = {
  /** Per-check wall clock. A control that hangs is not a control. */
  timeoutMs: 90_000,
  /** Heap cap for node checks. Portable in a way `systemd-run` is not: CI runs macOS and Windows. */
  heapMb: 1024,
};

/**
 * @param {object} control
 * @param {string} control.id          what to call it when it fails
 * @param {string} control.file        source to mutate, relative to `cwd`
 * @param {number} control.line        1-based
 * @param {string} control.anchor      text the line MUST contain before it is touched
 * @param {string} control.replace     the whole replacement line
 * @param {string[]} control.check     argv of the check that must go red
 * @param {string} cwd
 * @param {object} [options]
 */
export function runControl(control, cwd, options = {}) {
  const { timeoutMs, heapMb } = { ...DEFAULTS, ...options };
  const target = path.join(cwd, control.file);
  const before = fs.readFileSync(target);
  const lines = before.toString().split('\n');
  const index = control.line - 1;

  const found = lines[index];
  if (found === undefined || !found.includes(control.anchor)) {
    // Checked BEFORE anything is written: mutating a line that moved produces a confident red for a
    // change nobody meant, which is worse than a control that does nothing.
    return {
      id: control.id,
      verdict: VERDICT.anchorDrift,
      detail:
        `${control.file}:${control.line} does not contain the anchor.\n` +
        `      anchor: ${JSON.stringify(control.anchor)}\n` +
        `      line:   ${JSON.stringify(found ?? '(past end of file)')}`,
    };
  }

  const restore = () => fs.writeFileSync(target, before);
  try {
    lines[index] = control.replace;
    fs.writeFileSync(target, lines.join('\n'));

    const after = fs.readFileSync(target);
    if (after.equals(before)) {
      return {
        id: control.id,
        verdict: VERDICT.mutationDidNotLand,
        detail: `${control.file} is byte-identical after the mutation was written`,
      };
    }

    const argv = withHeapCap(control.check, heapMb);
    const run = spawnSync(argv[0], argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    if (run.status === 0) {
      return {
        id: control.id,
        verdict: VERDICT.checkStayedGreen,
        detail:
          `the check passed with ${control.file}:${control.line} mutated, so it does not hold that ` +
          `line.\n      Either the assertion is scaffolding, or something else guarantees the same ` +
          `behaviour and both need mutating.`,
      };
    }
    if (run.signal || run.status === null || run.status === 137) {
      return {
        id: control.id,
        verdict: VERDICT.diedWithoutAsserting,
        detail:
          `the check died (${run.signal ?? 'no exit code'}) rather than failing an assertion — out ` +
          `of memory or past the ${timeoutMs} ms timeout. That is red, but it proves nothing about ` +
          `the assertion.`,
      };
    }
    return { id: control.id, verdict: VERDICT.ok, detail: firstAssertion(run.stderr || run.stdout) };
  } finally {
    restore();
  }
}

/** Runs every control, then checks that the tree came back exactly as it was. */
export function runControls(controls, cwd, options = {}) {
  const snapshots = new Map();
  for (const c of controls) {
    const p = path.join(cwd, c.file);
    if (!snapshots.has(p)) snapshots.set(p, fs.readFileSync(p));
  }

  const results = controls.map((c) => runControl(c, cwd, options));

  // Restoration is asserted once, over every file any control touched, rather than trusted per
  // control: an unrestored mutation is silent until something else trips over it, and on
  // 2026-09-06 that took six OOM kills to notice.
  for (const [p, original] of snapshots) {
    if (!fs.readFileSync(p).equals(original)) {
      results.push({
        id: path.relative(cwd, p),
        verdict: VERDICT.notRestored,
        detail: 'this file is not byte-identical to what it was before the controls ran',
      });
    }
  }
  return results;
}

/** `--max-old-space-size` for a node check; other commands are run as given. */
function withHeapCap(argv, heapMb) {
  const [cmd, ...rest] = argv;
  return path.basename(cmd).startsWith('node') ? [cmd, `--max-old-space-size=${heapMb}`, ...rest] : argv;
}

/** The first assertion line, so a passing control says what it proved. */
function firstAssertion(output = '') {
  const line = output.split('\n').find((l) => /AssertionError|Error:/.test(l));
  return line ? line.trim().slice(0, 120) : 'the check failed';
}

// The implementation carries the approved prototype's numbers, not merely its idea.
//
// #118. The product owner's condition, in their words: *"Главное, чтобы было 1-в-1 с макетами"* —
// the implementation must match the mockup, not resemble it. This is that condition, machine-checked.
//
// It exists because on 2026-09-07 a prototype's own captions disagreed with its own rendering by
// **12%** — it said a 60ch cap was 481px while rendering it at 540px — and the adversary caught it,
// not the author. Both numbers were taken with the webfont absent, where `ch` resolves against the
// fallback at 8.0078px instead of 8.3998px. Nothing in the repository would have noticed.
//
// **What this holds and what it cannot.** It reads the committed prototype's CSS and asserts that the
// component's classes encode the same rule and the same numbers. It is a *declaration* check: it
// cannot lay anything out, because jsdom performs no layout and the suite has no browser. So it
// catches the drift that matters in practice — someone changing `pb-1.5` to `pb-3` and the prototype
// staying put — and it does not catch a rule that is written identically in both and wrong in both.
// The pixel numbers in the pull request come from headless Chrome against the built stylesheet with
// `document.fonts.load(...)` awaited; that measurement is not automated and is stated as such.
//
// The prototype is the source of truth here. If the design changes, the prototype changes first and
// this test goes red until the implementation follows — which is the direction the product owner
// asked for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const proto = fs.readFileSync(
  path.join(root, 'design', 'prototypes', '118-transcript-width.html'),
  'utf8'
);
const view = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'components', 'VirtualizedTranscriptView.tsx'),
  'utf8'
);
const panel = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'app', '_components', 'TranscriptPanel.tsx'),
  'utf8'
);

// Comments are stripped first. Without that the selector capture swallows the comment that
// precedes a rule — `/* … */\n.turn` — and an exact-token match on `.turn` finds nothing. Measured:
// 168 rules parsed, 0 matches for `.turn`, while the rule is plainly there.
const css = proto.replace(/\/\*[\s\S]*?\*\//g, '');

/** One declaration out of the prototype's stylesheet, by selector and property. */
function declared(selector, property) {
  // Selectors appear as `.turn { … }` / `.turn.you { … }`; take the first rule whose selector list
  // contains this exact selector as a whole token.
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  for (const [, sel, body] of rules) {
    const selectors = sel.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const m = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (m) return m[1].trim();
  }
  return null;
}

const px = (v) => {
  // A bare `0` is a length too, and CSS writes it without a unit. Without this the check for
  // `padding: 0` on the channel-less row compared null against 0 and failed for the wrong reason.
  if (/^\s*0\s*$/.test(String(v))) return 0;
  const m = String(v).match(/(-?[\d.]+)px/);
  return m ? Number(m[1]) : null;
};

/** Tailwind's spacing scale is 0.25rem = 4px per unit. */
const spacing = (units) => units * 4;

const checks = [];
const check = (what, protoValue, implValue, why) => {
  checks.push(what);
  assert.equal(
    implValue,
    protoValue,
    `${what}: the prototype declares ${JSON.stringify(protoValue)} and the implementation has ` +
      `${JSON.stringify(implValue)}.\n  ${why}\n  design/prototypes/118-transcript-width.html is the ` +
      `source of truth — change it first, then follow it here.`
  );
};

// --- 1: the width cap, the whole point of #118 --------------------------------------------------
{
  const p = declared('.turn', 'max-width');
  assert.ok(p, 'the prototype must declare `.turn { max-width }` — it is what #118 changes');
  const normalised = p.replace(/\s+/g, '');
  assert.equal(
    normalised,
    'min(60ch,78%)',
    `the prototype's cap is ${JSON.stringify(p)}; this test hard-codes the shape it knows how to ` +
      'compare. A different shape means the design moved and this test must be revisited, not edited ' +
      'to agree.'
  );
  const m = view.match(/max-w-\[([^\]]+)\]/);
  assert.ok(m, 'the turn must carry an arbitrary max-width; a bare per-cent cap is what #118 removes');
  check(
    'the width cap',
    normalised,
    m[1].replace(/\s+/g, ''),
    'A bare 60ch cap is 503.98px against the 400px content box at the 720px minimum window, so it ' +
      'stops capping and both sides render the same box — the side is the only label this design has.'
  );
}

// --- 2: the vertical rhythm, three numbers -------------------------------------------------------
{
  const gap = px(declared('.thread', 'gap'));
  const pb = view.match(/'flex max-w-\[[^\]]+\] flex-col pb-([\d.]+)'/);
  assert.ok(pb, 'the turn must set its own bottom spacing');
  check('the gap between turns', gap, spacing(Number(pb[1])), 'The prototype spaces turns with `gap`; the turn carries it as padding here.');

  const pad = declared('.body', 'padding');
  const [vert, horiz] = pad.split(/\s+/).map(px);
  const bub = view.match(/'min-w-0 rounded-lg px-(\d+) py-([\d.]+) \[&>p\+p\]:mt-(\d+)'/);
  assert.ok(bub, "the bubble's padding classes must be readable — the shape changed, so re-read them");
  check("the bubble's vertical padding", vert, spacing(Number(bub[2])), '6px was 8px before #118.');
  check("the bubble's horizontal padding", horiz, spacing(Number(bub[1])), 'Unchanged by #118, held so it cannot drift.');

  const between = px(declared('.turn p + p', 'margin-top'));
  check('the space between paragraphs in one turn', between, spacing(Number(bub[3])), '4px was 8px before #118.');
}

// --- 3: the timestamp rides the last line --------------------------------------------------------
{
  const ts = declared('.ts.in', 'margin');
  assert.ok(ts, 'the prototype must declare the inline timestamp — it is half of what #118 buys');
  const leading = px(ts.split(/\s+/)[3] ?? ts);
  const ms = view.match(/float-end ms-(\d+) mt-\[(\d+)px\]/);
  assert.ok(ms, 'the timestamp must float to the trailing edge with a logical margin');
  check("the timestamp's leading margin", leading, spacing(Number(ms[1])), 'It separates the time from the words it follows.');
  check("the timestamp's optical nudge", px(declared('.ts.in', 'top')), Number(ms[2]), 'Aligns the mono readout to the text baseline.');

  // Order, not only numbers. The prototype emits `<p>{speaker}{text}{timestamp}</p>` — the float
  // comes last. Placed first it is put at the top of the block and rides the paragraph's FIRST
  // line, which is what shipped in the first draft of this change and what a numbers-only check
  // cannot see.
  const line = view.match(/const TranscriptLine = memo\([\s\S]*?\n\}\);/);
  assert.ok(line, 'TranscriptLine must be findable to check the order of its children');
  const textPos = line[0].indexOf("{isSilence ? 'Silence' : text}");
  const trailingPos = line[0].lastIndexOf('{trailing}');
  assert.ok(textPos > 0 && trailingPos > 0, 'both the text and the trailing slot must be present');
  assert.ok(
    trailingPos > textPos,
    'the timestamp must come AFTER the text in source order, as the prototype emits it. A float ' +
      'placed before the inline content is positioned at the top of the block and lands on the ' +
      "paragraph's first line instead of its last."
  );
  checks.push('the timestamp comes after the text');

  assert.ok(
    !/float-\[/.test(view),
    '`float-[inline-end]` does not compile — the built stylesheet contained no `float:inline-end` ' +
      'and the timestamp would not have floated at all. Use `float-end`, which resolves to the ' +
      'logical property and is therefore also correct for a right-to-left transcript.'
  );
}

// --- 3b: a long token cannot push the transcript sideways ---------------------------------------
{
  // The prototype's own rule, and the reason it is there: measured on the geometry #118 replaces, a
  // single 141-character token gave `scrollWidth` 1062 against `clientWidth` 359 — the transcript
  // already scrolled sideways before this change. jsdom lays nothing out, so this holds the
  // declaration rather than the pixel; the pixel is in the pull request.
  const wrap = declared('.turn p', 'overflow-wrap');
  assert.equal(
    wrap,
    'anywhere',
    'the prototype must declare `overflow-wrap: anywhere` on a turn paragraph'
  );
  assert.match(
    view,
    /'min-w-0 break-words text-md leading-relaxed'/,
    'the transcript line must carry `break-words` (`overflow-wrap: break-word`), or a single long ' +
      'token overflows the pane. Measured before #118: scrollWidth 1062 against clientWidth 359.'
  );
  checks.push('the long-token guard');
}

// --- 4: the prose measure is off the transcript, and only the transcript -------------------------
{
  // Counted over code, not comments: the removal is explained *in* a comment that names the class,
  // and counting the raw text found two where there is one.
  const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const wrappers = [...panelCode.matchAll(/max-w-measure/g)].length;
  assert.equal(
    wrappers,
    1,
    `the panel must keep exactly one \`max-w-measure\` — the permission warning, which is prose. ` +
      `Found ${wrappers}. The transcript's wrapper loses it (#118); \`--measure\` is a prose measure ` +
      `and a bubble already caps its own line length, so the pane was being spent twice.`
  );
  assert.match(
    panel,
    /No `max-w-measure` here, deliberately/,
    'the removal must be explained where it was removed, or the next person restores it'
  );
}

// --- 5: the single-column states keep the gutter and gain no bubble ------------------------------
{
  const gut = declared('.turn.none', 'grid-template-columns');
  assert.ok(gut && gut.includes('3.25rem'), 'the prototype keeps a 3.25rem gutter for a channel-less turn');
  assert.match(
    view,
    /w-\[3\.25rem\]/,
    "the single-column row must keep its 3.25rem timestamp gutter. The prototype's own bubble rules " +
      'cascade onto its `.none` turns, so a literal port turns a channel-less transcript into ' +
      'bubbles — and `transcript-sides.test.mjs` asserts there are no bubbles there, which stays ' +
      'true either way, so nothing else catches this.'
  );
  assert.equal(
    px(declared('.turn.none .body', 'padding')),
    0,
    'and it must have no bubble padding in the prototype either — if that changed, so did the design'
  );
}

console.log(
  `ok - the transcript matches its prototype on ${checks.length} numbers: ` +
    `${checks.join(', ')} — read from design/prototypes/118-transcript-width.html`
);

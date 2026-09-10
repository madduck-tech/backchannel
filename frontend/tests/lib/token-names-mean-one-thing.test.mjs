// No custom-property name means two different things in the design system and the application. (#121)
//
// The two files are synchronised by hand (ADR 0011 decision 2) and use different vocabularies on
// purpose -- `--surface-warm` is the app's `--panel`. `design-system-is-canonical.test.mjs` (#115)
// therefore holds the *mapping* and says in its own comment that it does not assert token equality.
// That carve-out is right, and it leaves a gap this file fills: the same spelling with opposite
// roles, which no mapping ever looks at. `--muted` was mid-ink text in one file and a background in
// the other; `--accent` was the brand in one and a pale tint in the other. A prototype ported
// literally painted text in a background colour, and the product owner found it by noticing the
// prototypes and the application look different.
//
// **The whole cascade, not the first declaration.** `globals.css` has three cascade blocks --
// `:root`, `.dark`, and a `@media (prefers-contrast: more)` the design system has no counterpart for.
// A check that reads the first declaration of each name finds the two role collisions and misses two
// more names entirely, which is how the issue's own control ("add a third colliding name") was
// already satisfied by something in the tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const TOKENS = 'design/backchannel/tokens.css';
const APP = 'frontend/src/app/globals.css';

/**
 * Divergences that are accepted, each with a **kind**, because two different defects hide under one
 * word otherwise.
 *
 *   `role-collision` — one spelling, two meanings. The target is zero and this check enforces zero:
 *                      the list may not contain one.
 *   `tier-gap`       — the roles agree; one side has a cascade state the other lacks. Listed with a
 *                      reason and an issue, because closing it is a design decision, not a rename.
 *
 * **A `tier-gap` states its premise and the premise is checked.** "The application has a
 * `prefers-contrast: more` tier and the design system has none" is a fact about two files, and until
 * now it was prose: the day the design system gained one, the exemption would have gone on excusing a
 * divergence that had become a real disagreement, silently. So the kind carries a predicate, and an
 * exemption whose premise stops holding is as red as one whose divergence has gone. This file already
 * says why -- an excuse that outlives its reason is how a list of two becomes a list of twenty -- and
 * a premise nobody checks is the same thing one level up.
 */
const EXEMPT = [
  {
    name: '--border',
    kind: 'tier-gap',
    why: 'Both are the border colour. The application has a `prefers-contrast: more` tier ' +
      '(globals.css:182-196) and the design system has none, so the two agree in every state that ' +
      'exists on both sides. Giving the design system a high-contrast tier is a design decision: #140.',
  },
  {
    name: '--border-strong',
    kind: 'tier-gap',
    why: 'Same tier gap as --border; declared four times in the application against twice in the ' +
      'design system. #140',
  },
];

// --- reading a stylesheet as four cascade states ----------------------------------------------------
//
// Both `:root` and `.dark` are specificity (0,1,0), and a media block adds none, so within a state the
// last matching declaration in source order wins. That is the whole cascade rule this needs.
function declarations(css) {
  const out = [];
  let i = 0, ctx = [];
  const atRule = /@media[^{]*/y;
  while (i < css.length) {
    const ch = css[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '}') { ctx.pop(); i++; continue; }
    if (ch === '{') { i++; continue; }
    if (ch === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i); i = e === -1 ? css.length : e + 2; continue; }
    if (ch === '@') {
      atRule.lastIndex = i;
      const m = atRule.exec(css);
      if (m) { ctx.push({ media: m[0] }); i = m.index + m[0].length; continue; }
    }
    const decl = /(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+);/y;
    decl.lastIndex = i;
    const d = decl.exec(css);
    if (d && d.index === i) {
      out.push({
        name: d[1],
        value: d[2].trim(),
        dark: ctx.some((c) => c.sel && /\.dark\b/.test(c.sel)),
        contrast: ctx.some((c) => c.media && /prefers-contrast:\s*more/.test(c.media)),
      });
      i = decl.lastIndex;
      continue;
    }
    // Anything else up to the next brace is a selector.
    const brace = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (brace === -1) break;
    if (semi !== -1 && semi < brace) { i = semi + 1; continue; }
    ctx.push({ sel: css.slice(i, brace).trim() });
    i = brace + 1;
  }
  return out;
}

/** The application stores bare oklch components (`0.72 0.15 72`); the design system wraps them. */
const norm = (v) => {
  if (v == null) return null;
  const t = v.trim();
  return /^[\d.]+ [\d.-]+ [\d.-]+( \/ [\d.%]+)?$/.test(t) ? `oklch(${t})` : t.replace(/\s+/g, ' ');
};

function state(decls, { dark, contrast }) {
  const by = new Map();
  for (const d of decls) {
    if (d.dark && !dark) continue;
    if (d.contrast && !contrast) continue;
    by.set(d.name, d.value); // source order: last wins
  }
  const resolve = (name, depth = 0) => {
    if (depth > 8 || !by.has(name)) return null;
    const v = by.get(name);
    const m = /^var\((--[A-Za-z0-9-]+)\)$/.exec(v);
    return m ? resolve(m[1], depth + 1) : v;
  };
  const out = new Map();
  for (const name of by.keys()) out.set(name, norm(resolve(name)));
  return out;
}

const STATES = [
  { dark: false, contrast: false }, { dark: false, contrast: true },
  { dark: true, contrast: false }, { dark: true, contrast: true },
];
const label = (s) => `${s.dark ? 'dark' : 'light'}${s.contrast ? ' + prefers-contrast:more' : ''}`;

/** Every name declared by both, in any state, whose resolved values disagree there. */
function divergences(aCss, bCss) {
  const a = declarations(aCss), b = declarations(bCss);
  const found = new Map();
  for (const s of STATES) {
    const av = state(a, s), bv = state(b, s);
    for (const [name, v] of av) {
      if (!bv.has(name)) continue;
      if (bv.get(name) === v) continue;
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(`${label(s)}: design=${v} app=${bv.get(name)}`);
    }
  }
  return found;
}

// --- 1. the two files ------------------------------------------------------------------------------
const tokens = read(TOKENS), app = read(APP);
const shared = new Set(
  [...state(declarations(tokens), STATES[0]).keys()]
    .filter((n) => state(declarations(app), STATES[0]).has(n))
);
assert.ok(shared.size >= 10, `only ${shared.size} names are declared in both files; this check has gone stale`);

const found = divergences(tokens, app);
const exemptBy = new Map(EXEMPT.map((e) => [e.name, e]));

// No exemption may be a role collision: that is the thing this issue drove to zero.
const roles = EXEMPT.filter((e) => e.kind === 'role-collision');
assert.deepEqual(
  roles.map((e) => e.name), [],
  'a role collision may not be exempted — one spelling with two meanings is what makes a prototype\n' +
    '  unportable, and the count this check enforces is zero, not "documented".'
);

// Every divergence is either listed with a reason, or it is a failure.
const unlisted = [...found].filter(([n]) => !exemptBy.has(n));
assert.deepEqual(
  unlisted.map(([n, where]) => `${n}\n      ${where.join('\n      ')}`), [],
  `a name is declared in both ${TOKENS} and ${APP} with different values, and nothing says why.\n` +
    '  If the two mean the same thing, make the values agree. If they mean different things, one side\n' +
    '  renames — and it cannot be the design system for a name OpenDesign\'s TOKEN_SCHEMA requires.\n' +
    '  If the divergence is a missing cascade tier rather than a collision, add it to EXEMPT with\n' +
    '  kind: \'tier-gap\' and the issue that closes it.'
);

// A tier-gap's premise, checked rather than trusted: the application declares the name inside a
// `prefers-contrast: more` block (directly, or through the `var()` it resolves to) and the design
// system has no such block at all. Either half changing makes this a different question, and it is
// the design system gaining a tier that #140 exists to decide.
const HC = /@media\s*\(\s*prefers-contrast:\s*more\s*\)([\s\S]*?)\n\s{2}\}/.exec(app);
const inHighContrast = new Set(HC ? [...HC[1].matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]) : []);
const target = (name) => {
  const m = new RegExp(`${name}\\s*:\\s*var\\((--[A-Za-z0-9-]+)\\)`).exec(app);
  return m ? m[1] : name;
};

for (const e of EXEMPT.filter((x) => x.kind === 'tier-gap')) {
  assert.ok(
    inHighContrast.has(e.name) || inHighContrast.has(target(e.name)),
    `${e.name} is exempted as a tier-gap, but ${APP} does not raise it under\n` +
      '  `prefers-contrast: more`. The exemption says the application has a tier the design system\n' +
      '  lacks; it no longer does, so the divergence is something else and needs a new reason.'
  );
}
assert.ok(
  !/prefers-contrast/.test(tokens),
  `${TOKENS} now has a prefers-contrast block, so every tier-gap exemption's premise — "the design\n` +
    '  system has none" — is false. Either the two sides now agree in that state and the exemptions\n' +
    '  go, or they disagree and it is no longer a missing tier. #140 is where that is decided.'
);

// And an exemption may not outlive the divergence it excuses.
const stale = EXEMPT.filter((e) => !found.has(e.name));
assert.deepEqual(
  stale.map((e) => e.name), [],
  'these names no longer diverge, so their exemption is a stale excuse. Delete it — an excuse that\n' +
    '  outlives its reason is how a list of two becomes a list of twenty.'
);

// --- 2. every theme entry points at a property that exists -----------------------------------------
//
// The landmine under the resolution above. `tailwind.config.js` names a property inside a value:
// `c('--accent')` emits `oklch(var(--accent) / <alpha-value>)`. Delete the property and leave the key
// and the utility still generates -- rendering a transparent background and black text, with no build
// error, no lint error and no failing test. That is strictly worse than the collision it replaced, so
// the two files are held in step here.
const theme = read('frontend/tailwind.config.js');
const referenced = [...theme.matchAll(/c\('(--[A-Za-z0-9-]+)'\)/g)].map((m) => m[1]);
assert.ok(referenced.length >= 20, `only ${referenced.length} c('--…') references in tailwind.config.js; stale`);

const declaredAnywhere = new Set();
for (const s of STATES) for (const n of state(declarations(app), s).keys()) declaredAnywhere.add(n);
const dangling = [...new Set(referenced)].filter((n) => !declaredAnywhere.has(n));
assert.deepEqual(
  dangling, [],
  `tailwind.config.js builds a utility from a property ${APP} does not declare. The utility still\n` +
    '  generates: `oklch(var(--gone) / 1)` is a transparent background and black text, and nothing\n' +
    '  else reports it. Delete the theme key with the property, or declare the property.'
);

// --- 2. and the prototypes, which inline the whole :root -------------------------------------------
const protoDir = path.join(root, 'design', 'prototypes');
const protos = fs.readdirSync(protoDir).filter((f) => f.endsWith('.html'));
assert.ok(protos.length >= 5, `only ${protos.length} prototypes found; this check has gone stale`);

const bad = [];
for (const f of protos) {
  const d = divergences(fs.readFileSync(path.join(protoDir, f), 'utf8'), app);
  for (const [name, where] of d) {
    if (exemptBy.has(name)) continue;
    bad.push(`${f}: ${name}\n      ${where.join('\n      ')}`);
  }
}
assert.deepEqual(
  bad, [],
  'a prototype declares a name the application declares with a different meaning. Every prototype\n' +
    '  inlines the design system\'s :root, so this is the same defect reaching the file an\n' +
    '  implementer copies from.'
);

// --- 4. the trap is written where a prototype author looks, and the writing is measured ------------
//
// The two names no longer collide, so nothing here can go red on the collision. What can still hurt
// someone is that they do not exist on the other side at all: a prototype says `var(--muted)`, the
// application has never heard of it, and the port is silent. `USAGE.md` says so — and this asserts
// the mapping it prints is still true, so the table goes red rather than stale.
const usage = read('design/backchannel/USAGE.md');
const MAPPING = [['--muted', '--ink-muted'], ['--accent', '--brand']];

for (const [there, here] of MAPPING) {
  assert.ok(
    new RegExp(`\\\`${there}\\\`[^\\n]*\\\`${here}\\\``).test(usage),
    `USAGE.md does not tell a prototype author that ${there} becomes ${here} in the application.\n` +
      '  It is the file OpenDesign points agents at, and the only place this rename is discoverable.'
  );
  for (const s of [STATES[0], STATES[2]]) {
    const d = state(declarations(tokens), s).get(there);
    const a = state(declarations(app), s).get(here);
    assert.equal(
      d, a,
      `USAGE.md prints ${there} -> ${here}, but in ${label(s)} they are ${d} and ${a}.\n` +
        '  A mapping table nobody measures is how the third naming system starts.'
    );
  }
}

console.log(
  `ok - ${shared.size} names declared in both the design system and the application, across ` +
    `${STATES.length} cascade states; 0 role collisions, ${EXEMPT.length} tier gaps listed with a ` +
    `reason, and ${protos.length} prototypes carry none`
);

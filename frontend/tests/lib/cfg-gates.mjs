// Which Rust items a shipped build leaves out, read from `cfg` gates in source. (#167)
//
// `registeredCommandNames` strips every `#[cfg(...)]` and keeps the command, which is right for
// `target_os`: a platform-gated command ships on that platform, and source text cannot say which
// platform a build is for. It is wrong for `debug_assertions` and `test`, which are false in every
// artifact a person runs. #167 is that difference: `bfa8d3a` inserted the first-run audio check's
// module and its handler entry between an existing `#[cfg(debug_assertions)]` and the item it gated,
// so a release build answered `Command check_capture_device not found` and a census that had thrown
// the attribute away stayed green.
//
// **An evaluation, not a pattern.** A predicate is parsed into `all`/`any`/`not` over atoms;
// `debug_assertions` and `test` are fixed false and every other atom is free. A set of gates leaves
// an item out of every shipped build when their conjunction is false under every assignment of the
// free atoms, enumerated exhaustively. A substring rule -- "mentions debug_assertions and is not
// under `not`" -- passes most fixtures and is wrong about `all(target_os = "linux",
// not(debug_assertions))`, which ships on Linux.
//
// **Not exact, and the direction is stated.** Atoms are independent here, so the evaluator does not
// know that two `target_os` values exclude each other or that `unix` follows from the target. It
// therefore considers assignments no real target has, which can only make "false everywhere" harder
// to reach: its errors go towards *ships*. For a stray `debug_assertions` or `test` gate that is the
// safe side, because fixing those atoms false is enough to falsify a conjunction they sit in.

/**
 * Fixed atoms: `debug_assertions` and `test` are false in every artifact a person runs, and `true` /
 * `false` are literals rustc accepts (`#[cfg(false)]` removes the item). Left free, `false` read as
 * "ships somewhere", and a product command under `#[cfg(false)]` passed the census.
 */
const FIXED = new Map([
  ['debug_assertions', false],
  ['test', false],
  ['true', true],
  ['false', false],
]);

/**
 * Parse the inside of `cfg(...)` into a tree.
 *
 * `{op:'all'|'any'|'not', args:[...]}` or `{atom:'name'}` / `{atom:'name="value"'}`. Throws on
 * anything else, because a gate this cannot read is a gate it would otherwise silently ignore.
 */
export function parseCfg(text) {
  let i = 0;
  const s = text;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const ident = () => {
    ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) throw new Error(`cfg: expected an identifier at ${i} in ${JSON.stringify(text)}`);
    i += m[0].length;
    return m[0];
  };
  const pred = () => {
    const name = ident();
    ws();
    if (name === 'all' || name === 'any' || name === 'not') {
      if (s[i] !== '(') throw new Error(`cfg: ${name} without arguments in ${JSON.stringify(text)}`);
      i++;
      const args = [];
      ws();
      while (s[i] !== ')') {
        args.push(pred());
        ws();
        if (s[i] === ',') { i++; ws(); }
        else if (s[i] !== ')') throw new Error(`cfg: expected , or ) at ${i} in ${JSON.stringify(text)}`);
      }
      i++;
      if (name === 'not' && args.length !== 1) throw new Error(`cfg: not() takes one argument in ${JSON.stringify(text)}`);
      return { op: name, args };
    }
    if (s[i] === '=') {
      i++;
      ws();
      const m = /^"([^"]*)"/.exec(s.slice(i));
      if (!m) throw new Error(`cfg: expected a string after ${name} = in ${JSON.stringify(text)}`);
      i += m[0].length;
      return { atom: `${name}="${m[1]}"` };
    }
    return { atom: name };
  };
  const tree = pred();
  ws();
  if (i !== s.length) throw new Error(`cfg: trailing text at ${i} in ${JSON.stringify(text)}`);
  return tree;
}

function atomsOf(tree, out = new Set()) {
  if (tree.atom) {
    if (!FIXED.has(tree.atom)) out.add(tree.atom);
  } else tree.args.forEach((a) => atomsOf(a, out));
  return out;
}

function evaluate(tree, assignment) {
  if (tree.atom) return FIXED.has(tree.atom) ? FIXED.get(tree.atom) : assignment.get(tree.atom);
  if (tree.op === 'not') return !evaluate(tree.args[0], assignment);
  if (tree.op === 'all') return tree.args.every((a) => evaluate(a, assignment));
  return tree.args.some((a) => evaluate(a, assignment));
}

/**
 * Whether gates written as the insides of `cfg(...)`, all applying to one item, leave it out of
 * every shipped build: their conjunction is false under every assignment of the free atoms.
 */
export function absentFromEveryShippedBuild(predicates) {
  const trees = predicates.map(parseCfg);
  const free = [...new Set(trees.flatMap((t) => [...atomsOf(t)]))];
  if (free.length > 16) throw new Error(`cfg: ${free.length} free atoms on one item; enumerate fewer`);
  for (let bits = 0; bits < 1 << free.length; bits++) {
    const assignment = new Map(free.map((a, k) => [a, Boolean(bits & (1 << k))]));
    if (trees.every((t) => evaluate(t, assignment))) return false;
  }
  return true;
}

/** Skip a `[...]` starting at `s[i] === '['`, balanced; returns the index after the `]`. */
function skipBracket(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '"') { k++; while (k < s.length && s[k] !== '"') { if (s[k] === '\\') k++; k++; } continue; }
    if (s[k] === '[') depth++;
    else if (s[k] === ']' && --depth === 0) return k + 1;
  }
  throw new Error(`unbalanced attribute starting ${JSON.stringify(s.slice(i, i + 60))}`);
}

/** The predicate inside an attribute's text, if it is a `cfg`: `#[cfg(X)]` or `#![cfg(X)]` -> `X`. */
function cfgOf(attr) {
  const m = /^#!?\[\s*cfg\s*\(([\s\S]*)\)\s*\]$/.exec(attr);
  return m ? m[1].trim() : null;
}

/**
 * The inner `#![cfg(...)]` gates at the top of a module file, before its first item. Comments and
 * other inner attributes are skipped; the scan stops at the first token that is neither.
 */
export function innerCfgs(source) {
  const out = [];
  let i = 0;
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source.startsWith('/*', i)) { i = source.indexOf('*/', i) + 2; continue; }
    if (source.startsWith('#![', i)) {
      const end = skipBracket(source, i + 2);
      const p = cfgOf(source.slice(i, end));
      if (p) out.push(p);
      i = end;
      continue;
    }
    break;
  }
  return out;
}

/**
 * Every `mod name;` declared in a file, with the outer `cfg` gates directly above it.
 *
 * Attributes are read only where a line starts with `#[`, so `#[` inside a string or an expression
 * cannot open one; an attribute may run over several lines (`sidecar.rs:141`). Anything between an
 * attribute and the item other than comments and further attributes resets the pending list.
 */
export function moduleDeclarations(source) {
  const decls = new Map();
  let pending = [];
  let i = 0;
  while (i < source.length) {
    const lineEnd = source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i);
    const line = source.slice(i, lineEnd);
    const t = line.trim();
    const lead = line.length - line.trimStart().length;
    if (t === '' || t.startsWith('//')) { i = lineEnd + 1; continue; }
    // A block comment, doc or plain, sits between an attribute and its item without breaking the
    // pairing. Read as an item, it reset the pending gates and the module read as ungated.
    if (t.startsWith('/*')) {
      const close = source.indexOf('*/', i + lead);
      if (close < 0) throw new Error('unterminated block comment');
      i = close + 2;
      continue;
    }
    if (t.startsWith('#[')) {
      const end = skipBracket(source, i + lead + 1);
      const p = cfgOf(source.slice(i + lead, end));
      if (p) pending.push(p);
      i = end;
      continue;
    }
    const m = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/.exec(t);
    if (m) decls.set(m[1], pending);
    pending = [];
    i = lineEnd + 1;
  }
  return decls;
}

/**
 * The entries of a `generate_handler![...]` body, each as `{ path, cfgs }`.
 *
 * Split at top-level commas only, after attributes and comments are lifted out, so a gate such as
 * `#[cfg(any(target_os = "macos", windows))]` is one attribute and not three entries.
 */
export function handlerEntries(body) {
  const entries = [];
  let pending = [];
  let tok = '';
  let i = 0;
  const flush = () => {
    const p = tok.trim();
    if (p) entries.push({ path: p, cfgs: pending });
    else if (pending.length) throw new Error(`an attribute in generate_handler! gates nothing: ${pending}`);
    pending = [];
    tok = '';
  };
  while (i < body.length) {
    if (body.startsWith('//', i)) { const e = body.indexOf('\n', i); i = e < 0 ? body.length : e; continue; }
    if (body.startsWith('/*', i)) { i = body.indexOf('*/', i) + 2; continue; }
    if (body.startsWith('#[', i)) {
      const end = skipBracket(body, i + 1);
      const p = cfgOf(body.slice(i, end));
      if (p) pending.push(p);
      i = end;
      continue;
    }
    if (body[i] === ',') { flush(); i++; continue; }
    tok += body[i];
    i++;
  }
  flush();
  return entries;
}

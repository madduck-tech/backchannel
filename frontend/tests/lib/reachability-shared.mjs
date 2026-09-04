// Shared machinery for the reachability checks (#17). Kept in one place because all three
// need the same two things: the source tree as text, and an import graph.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const srcDir = path.join(root, 'src');

/** Every .ts/.tsx file under src, as absolute paths. */
export function sourceFiles(dir = srcDir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

export const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

/**
 * Command names passed to `invoke`, as *string literals*.
 *
 * Deliberately not a bare-identifier match. An identifier match can be satisfied by any
 * mention — a comment naming a command counts it as used — and under set equality that is
 * worse than useless, because the mention forces the allowlist entry to be removed and the
 * record disappears. Nothing polices such a mention: there is no `lint` script and no
 * workflow step running eslint.
 *
 * `invoke` is imported under two names only: itself, and `invokeTauri` in six files under
 * src/hooks/meeting-details/. Every call site passes a literal — there are none with a
 * computed first argument — so a literal match is exact rather than approximate.
 */
export function invokedCommandNames(files = sourceFiles()) {
  const names = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\binvoke(?:Tauri)?\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      names.add(m[2]);
    }
  }
  return names;
}

/** The same, but keeping where each name was invoked from. */
export function invokeSites(files = sourceFiles()) {
  const sites = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\binvoke(?:Tauri)?\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      if (!sites.has(m[2])) sites.set(m[2], []);
      sites.get(m[2]).push(rel(f));
    }
  }
  return sites;
}

/**
 * Names registered in `tauri::generate_handler![...]`.
 *
 * The block is located by pattern and bracket-balanced rather than by line numbers: a
 * hardcoded range silently returns a wrong count the moment lib.rs shifts, and a wrong
 * count published as a measurement is the defect #17 exists to stop.
 */
export function registeredCommandNames() {
  const lib = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const marker = lib.indexOf('generate_handler!');
  if (marker < 0) throw new Error('generate_handler! not found in lib.rs');
  const start = lib.indexOf('[', marker);
  let depth = 0, end = -1;
  for (let i = start; i < lib.length; i++) {
    if (lib[i] === '[') depth++;
    else if (lib[i] === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error('unbalanced generate_handler! block');
  return new Set(
    lib.slice(start + 1, end)
      .split(',')
      // Strip comments and any leading #[cfg(...)] attributes rather than dropping the
      // whole comma-separated chunk: a platform-gated entry is written as the attribute on
      // its own line followed by the command, so the two arrive as one chunk. Dropping it
      // loses a real command -- that is exactly how an earlier count of this list came out
      // as 160 instead of 161.
      .map((e) => e.replace(/\/\/.*/g, '').replace(/#\[[^\]]*\]/g, '').trim())
      .filter(Boolean)
      .map((e) => e.split('::').pop().trim())
      .filter((e) => /^[a-z][A-Za-z0-9_]*$/.test(e))
  );
}

/** Resolve one import specifier to a file under src, or null. */
function resolveSpec(spec, from) {
  let base;
  if (spec.startsWith('@/')) base = path.join(srcDir, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** file -> set of files it imports. Static and dynamic specifiers both. */
export function importGraph(files = sourceFiles()) {
  const edges = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const targets = new Set();
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const t = resolveSpec(m[1], f);
      if (t) targets.add(t);
    }
    edges.set(f, targets);
  }
  return edges;
}

/** Next entry files: any page/layout/template/error/not-found under src/app. */
export function entryFiles(files = sourceFiles()) {
  return files.filter((f) =>
    /^src\/app\/(?:.*\/)?(page|layout|template|error|not-found|global-error)\.tsx?$/.test(rel(f))
  );
}

/** Everything reachable by import from the entry files, transitively. */
export function reachableFromEntries(files = sourceFiles()) {
  const edges = importGraph(files);
  const seen = new Set();
  const stack = [...entryFiles(files)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of edges.get(f) ?? []) if (!seen.has(t)) stack.push(t);
  }
  return seen;
}

/** Assert two sets are equal, reporting both directions separately. */
export function assertSetEquals(actual, allowed, what, hint) {
  const missing = [...actual].filter((x) => !allowed.has(x)).sort();
  const stale = [...allowed].filter((x) => !actual.has(x)).sort();
  const problems = [];
  if (missing.length) problems.push(`NEW — in that set, and not in the allowlist:\n    ${missing.join('\n    ')}`);
  if (stale.length) problems.push(`STALE — allowlisted, but no longer in that set:\n    ${stale.join('\n    ')}`);
  if (problems.length) {
    throw new Error(`${what} — the allowlist is no longer exact.\n  ${problems.join('\n  ')}\n\n  ${hint}`);
  }
}

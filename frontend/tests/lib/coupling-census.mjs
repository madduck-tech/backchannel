// What each component needs before it can be constructed. Helper, not a test.
//
// #102. `gallery.mjs` already renders every component in its own child process under a kernel memory
// cap and returns `{file, kind, reason, name}`; this is the assertion-shaped view of that data, so
// there is one census rather than two that drift.
import { buildCards, KIND } from './gallery.mjs';
import { componentFiles } from './reachability-shared.mjs';

/** Kinds that mean "this component could not be constructed", as opposed to "it drew nothing". */
export const BLOCKED_KINDS = new Set([
  KIND.failedOnMount, KIND.failedAsync, KIND.noComponentExport, KIND.noCard,
]);

/**
 * One row per component that cannot be constructed: its file, why, and which export was chosen.
 *
 * The export name travels because a component renamed so a different symbol is picked produces the
 * same file and the same error, and the change would be invisible in a diff (#102 condition 2).
 */
export function census(files = componentFiles()) {
  return buildCards(files);
}

/** The blocked rows of a census already taken. */
export const blocked = (cards) =>
  cards
    .filter((c) => BLOCKED_KINDS.has(c.kind))
    .map(({ file, kind, reason, name }) => ({ file, kind, reason: reason ?? null, name: name ?? null }))
    .sort((a, b) => a.file.localeCompare(b.file));

/** The rows that produced markup. */
export const drawn = (cards) => new Set(cards.filter((c) => c.kind === KIND.drawn).map((c) => c.file));

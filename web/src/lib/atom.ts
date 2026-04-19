/**
 * Web-side re-export of the shared Atom formatters.
 *
 * Canonical implementation lives in src/lib/atom.ts (project root) so the
 * CLI, workers, and web produce identical feeds.
 */
export { sourceToAtom, orgReleasesToAtom, ATOM_DEFAULT_MAX_ENTRIES } from "@shared/atom";

export type { AtomFeedOptions } from "@shared/atom";

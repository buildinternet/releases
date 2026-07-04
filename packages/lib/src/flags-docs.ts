/**
 * Renders the feature-flag reference table in `docs/architecture/feature-flags.md`
 * directly from the {@link FLAGS} registry, so the docs can't drift from code.
 *
 * `scripts/gen-flag-docs.ts` writes the output between the GENERATED markers in
 * that file; `flags-docs.test.ts` asserts the committed doc still matches. Pure
 * (no fs) so it stays worker-safe and unit-testable — the script owns the I/O.
 */

import { FLAGS, type FlagDef, type FlagKind } from "./flags.js";

/** Markers in feature-flags.md that bound the generated region (exclusive). */
export const FLAGS_DOC_BEGIN = "<!-- BEGIN GENERATED FLAG TABLE (bun run flags:docs) -->";
export const FLAGS_DOC_END = "<!-- END GENERATED FLAG TABLE -->";

const escapeCell = (s: string): string => s.replace(/\|/g, "\\|");

function renderTable(entries: FlagDef[]): string {
  if (entries.length === 0) return "_none_";
  const header = "| Flag key | Default | Reads | What it controls |\n| --- | --- | --- | --- |";
  const rows = entries
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(
      (d) =>
        `| \`${d.key}\` | \`${d.default}\` | ${d.reads.join(", ")} | ${escapeCell(d.description)} |`,
    );
  return [header, ...rows].join("\n");
}

/**
 * Render the flag reference as two kind-grouped tables. `Default` is the
 * hardcoded last-resort fallback (Flagship / the wrangler var override it at
 * runtime — check the dashboard for the live value); `Reads` is the worker(s)
 * that evaluate the flag.
 */
export function renderFlagsDocTable(
  flags: Record<string, FlagDef> = FLAGS as Record<string, FlagDef>,
): string {
  const all = Object.values(flags);
  const ofKind = (kind: FlagKind): FlagDef[] => all.filter((d) => d.kind === kind);
  return [
    "#### Kill switches — permanent operational levers",
    "",
    renderTable(ofKind("kill-switch")),
    "",
    "#### Rollout gates — retire once fully rolled out",
    "",
    renderTable(ofKind("rollout")),
  ].join("\n");
}

/**
 * Splice a freshly-rendered table between the markers in a feature-flags.md
 * body. Throws if a marker is missing so the generator/test fail loudly rather
 * than silently no-op. Shared by the script (writes) and the test (compares).
 */
export function spliceFlagsDoc(markdown: string, rendered: string): string {
  const begin = markdown.indexOf(FLAGS_DOC_BEGIN);
  const end = markdown.indexOf(FLAGS_DOC_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `feature-flags.md is missing the GENERATED FLAG TABLE markers (${FLAGS_DOC_BEGIN} … ${FLAGS_DOC_END})`,
    );
  }
  const before = markdown.slice(0, begin + FLAGS_DOC_BEGIN.length);
  const after = markdown.slice(end);
  return `${before}\n\n${rendered}\n\n${after}`;
}

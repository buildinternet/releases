import chalk from "chalk";
import { suggestOrgs, suggestSources } from "../api/orgs.js";
import { type AmbiguousSourceError } from "../api/sources.js";

export async function orgNotFound(identifier: string): Promise<never> {
  console.error(chalk.red(`Organization not found: ${identifier}`));
  const suggestions = await suggestOrgs(identifier, 5);
  if (suggestions.length > 0) {
    console.error(chalk.dim("\nDid you mean?"));
    for (const s of suggestions) {
      console.error(`  ${chalk.cyan(s.slug)}  ${chalk.dim(s.name)}`);
    }
  }
  process.exit(1);
}

export async function sourceNotFound(identifier: string): Promise<never> {
  console.error(chalk.red(`Source not found: ${identifier}`));
  const suggestions = await suggestSources(identifier, 5);
  if (suggestions.length > 0) {
    console.error(chalk.dim("\nDid you mean?"));
    for (const s of suggestions) {
      console.error(`  ${chalk.cyan(s.slug)}  ${chalk.dim(s.name)}`);
    }
  }
  process.exit(1);
}

export function productNotFound(identifier: string): never {
  console.error(chalk.red(`Product not found: ${identifier}`));
  console.error(chalk.dim('Use an "org/slug" coordinate, a prod_… id, or a product slug.'));
  process.exit(1);
}

/**
 * Renders the candidate list for an ambiguous bare source slug (#264): a header
 * naming the slug + match count, then one `org/slug  src_…` line per candidate,
 * and a hint pointing at the two unambiguous escape hatches. Pure (no I/O) so
 * it can be unit-tested; the top-level handler in `index.ts` prints it.
 */
export function formatAmbiguousSourceError(err: AmbiguousSourceError): string {
  const coords = err.candidates.map((c) => `${c.orgSlug ?? "—"}/${c.slug}`);
  const width = Math.max(0, ...coords.map((c) => c.length));
  const lines = err.candidates.map(
    (c, i) => `  ${chalk.cyan(coords[i]!.padEnd(width))}  ${chalk.dim(c.id)}`,
  );
  return [
    chalk.red(
      `Source slug "${err.slug}" is ambiguous — it matches ${err.candidates.length} sources across orgs.`,
    ),
    chalk.dim("Re-run with an org/slug coordinate or a src_… id:"),
    ...lines,
  ].join("\n");
}

/**
 * Plain-text (no ANSI) sibling of {@link formatAmbiguousSourceError} for
 * surfaces that aren't a color terminal — chiefly the local MCP server's
 * `get_source` / `get_catalog_entry` tools, where the string is returned as
 * tool content for an agent to read and self-correct against (#264).
 */
export function describeAmbiguousSource(err: AmbiguousSourceError): string {
  const lines = err.candidates.map((c) => `  ${c.orgSlug ?? "—"}/${c.slug}  (${c.id})`);
  return (
    `Source "${err.slug}" is ambiguous — it matches ${err.candidates.length} sources across orgs. ` +
    `Retry with an org/slug coordinate or a src_… id:\n${lines.join("\n")}`
  );
}

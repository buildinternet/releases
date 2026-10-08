import { Command } from "commander";
import chalk from "chalk";
import { findSource } from "../../api/sources.js";
import { sourceNotFound } from "../suggest.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { writeJson } from "../../lib/output.js";
import { getFetchMethod } from "../../lib/source-display.js";
import { parseMetadataObject } from "@buildinternet/releases-core/cli-contracts";

/**
 * Well-known metadata keys surfaced (in this order) under "Fetch config" with
 * friendly labels. Anything left over is dumped generically afterwards so the
 * view never silently hides a key an operator set.
 */
const KNOWN_META_LABELS: Array<[key: string, label: string]> = [
  ["renderRequired", "Render required"],
  ["crawlEnabled", "Crawl enabled"],
  ["crawlIncludePathPrefix", "Crawl path prefix"],
  ["firecrawl", "Firecrawl"],
  ["feedUrl", "Feed URL"],
  ["feedType", "Feed type"],
  ["provider", "Provider"],
  ["evaluatedMethod", "Evaluated method"],
  ["githubUrl", "GitHub URL"],
  ["markdownUrl", "Markdown URL"],
  ["changelogPaths", "Changelog paths"],
  ["categoryAllow", "Category allow"],
  ["extractStrategy", "Extract strategy"],
];

/** Render one aligned `Label   value` row; dims a missing/empty value. */
function row(label: string, value: string | null | undefined): string {
  return `  ${chalk.bold(label.padEnd(18))} ${value && value.length > 0 ? value : chalk.dim("—")}`;
}

/** Stringify a metadata value compactly for a single-line row. */
function fmtMetaValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type ShowSourceOpts = { json?: boolean };

export async function showSourceAction(identifier: string, opts: ShowSourceOpts): Promise<void> {
  const source = await findSource(identifier);
  if (!source) return sourceNotFound(identifier);

  const meta = parseMetadataObject(source.metadata);
  const method = getFetchMethod(source.type, meta);

  if (opts.json) {
    // Return the parsed metadata object (not the raw JSON-in-JSON string) so
    // agents reading `--json` get structured fetch config without a second
    // JSON.parse, plus the derived `method`. Matches `list <source> --json`.
    await writeJson({ ...source, method, metadata: meta });
    return;
  }

  // Loose-read the enriched fields the API layers onto the source row (orgSlug,
  // consecutiveErrors, …) that aren't on the narrow published Source type.
  const s = source as typeof source & {
    orgSlug?: string | null;
    productId?: string | null;
    consecutiveErrors?: number | null;
    isHidden?: boolean | null;
    isPrimary?: boolean | null;
    kind?: string | null;
    fetchPriority?: string | null;
    lastFetchedAt?: string | null;
  };

  console.log(chalk.bold(`\n${stripAnsi(source.name)}`));
  console.log(row("ID", source.id));
  console.log(row("Slug", source.slug));
  console.log(row("Org", s.orgSlug ?? s.orgId ?? null));
  if (s.productId) console.log(row("Product", s.productId));
  console.log(row("Type", source.type));
  if (s.kind) console.log(row("Kind", s.kind));
  console.log(row("URL", source.url));
  console.log(row("Method", method === "-" ? null : method));
  console.log(row("Status", s.isHidden ? chalk.red("disabled") : chalk.green("active")));
  if (s.isPrimary) console.log(row("Primary", "yes"));
  const priority = s.fetchPriority ?? "normal";
  console.log(row("Fetch priority", priority === "paused" ? chalk.yellow("paused") : priority));
  if (s.consecutiveErrors && s.consecutiveErrors > 0) {
    console.log(row("Errors", chalk.yellow(`${s.consecutiveErrors} consecutive`)));
  }
  console.log(row("Last fetched", s.lastFetchedAt ?? null));

  // Fetch config — well-known metadata keys first (friendly labels), then any
  // remaining keys generically. parseInstructions is handled separately below
  // because it can be long.
  if (meta) {
    const shown = new Set<string>(["parseInstructions"]);
    const configRows: string[] = [];
    for (const [key, label] of KNOWN_META_LABELS) {
      if (meta[key] === undefined) continue;
      shown.add(key);
      configRows.push(row(label, fmtMetaValue(meta[key])));
    }
    for (const [key, value] of Object.entries(meta)) {
      if (shown.has(key) || value === undefined) continue;
      configRows.push(row(key, fmtMetaValue(value)));
    }
    if (configRows.length > 0) {
      console.log(`\n${chalk.dim("Fetch config")}`);
      for (const r of configRows) console.log(r);
    }

    const parse = meta.parseInstructions;
    if (typeof parse === "string" && parse.length > 0) {
      console.log(`\n${chalk.dim(`Parse instructions (${parse.length} chars)`)}`);
      const preview = parse.length > 280 ? `${parse.slice(0, 280)}…` : parse;
      console.log(stripAnsi(preview));
    }
  }

  console.log("");
}

export function registerShowSourceCommand(program: Command) {
  program
    .command("show")
    // `get` is the verb operators reach for first (#295); keep it as an alias.
    .alias("get")
    .description("Inspect a single source's config (src_… id, org/slug coordinate, or slug)")
    .argument("<identifier>", "Source ID (src_…), org/slug coordinate, or slug")
    .option("--json", "Output the full source with parsed metadata as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source show src_abc123
  releases admin source show vercel/next-js
  releases admin source show src_abc123 --json

A typed src_… id resolves unambiguously; a bare slug that collides across orgs
(e.g. release-notes) errors with the org/slug + src_… disambiguators.`,
    )
    .action(showSourceAction);
}

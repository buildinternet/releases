import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { listSourcesWithOrg, findSource } from "../../db/queries.js";
import { sourceNotFound } from "../suggest.js";
import { stripAnsi } from "../../lib/sanitize.js";

/**
 * Determine the fetch method for a source based on its type and metadata.
 * Returns "feed", "ai", "github", or "-" (unknown).
 */
function getFetchMethod(type: string, metadata: string | null): string {
  if (type === "github") return "github";
  if (type === "feed") return "feed";

  // For "scrape" and "agent" types, inspect metadata for feed discovery state
  if (metadata) {
    try {
      const meta = JSON.parse(metadata);
      if (meta.feedUrl) return "feed";
      if (meta.noFeedFound) return "ai";
    } catch {
      // Malformed metadata — treat as unknown
    }
  }

  return "-";
}

export function registerListCommand(program: Command) {
  program
    .command("list")
    .description("List all configured changelog sources, or show details for a single source")
    .argument("[slug]", "Show details for a specific source by slug")
    .option("--json", "Output as JSON")
    .option("--org <org>", "Filter by organization slug")
    .option("--product <product>", "Filter by product slug")
    .option("--has-feed", "Only show sources that have a discovered feed URL")
    .option("--query <text>", "Filter by name, slug, or URL (case-insensitive substring match)")
    .option("--category <category>", "Filter by organization or product category")
    .option("--include-disabled", "Include disabled sources in the list")
    .option("--compact", "Return lightweight fields only (id, slug, name, type, org, latestVersion, lastFetchedAt)")
    .option("--limit <n>", "Limit the number of results (applies to --json output)")
    .option("--page <n>", "Page number for paginated results (applies with --limit)")
    .addHelpText("after", `
Examples:
  releases list                       List all sources
  releases list claude-code           Show details for a single source
  releases list --json                List all sources as JSON
  releases list --json --compact       Lightweight JSON (id, slug, name, type, org, version, date)
  releases list --json --limit 20     First 20 sources as JSON
  releases list --json --limit 20 --page 2  Page 2 of 20-per-page results
  releases list --has-feed            Sources with a discovered feed URL
  releases list --query shadcn        Filter sources by name, slug, or URL
  releases list --include-disabled        Include disabled sources
  releases list --has-feed --org sentry   Combine filters`)
    .action(async (slug: string | undefined, opts: { json?: boolean; org?: string; product?: string; category?: string; hasFeed?: boolean; query?: string; includeDisabled?: boolean; compact?: boolean; limit?: string; page?: string }) => {
      // ── Single-source detail view ──
      if (slug) {
        const source = await findSource(slug);
        if (!source) {
          return sourceNotFound(slug);
        }
        if (opts.json) {
          const method = getFetchMethod(source.type, source.metadata ?? null);
          const parsed = { ...source, method };
          if (typeof parsed.metadata === "string") {
            try { parsed.metadata = JSON.parse(parsed.metadata); } catch {}
          }
          console.log(JSON.stringify(parsed, null, 2));
          return;
        }
        const label = (key: string, val: string | null | undefined) =>
          `  ${chalk.bold(key.padEnd(16))} ${val ?? chalk.dim("—")}`;
        const method = getFetchMethod(source.type, source.metadata ?? null);
        console.log(chalk.bold(`\n${stripAnsi(source.name)}\n`));
        console.log(label("Slug", source.slug));
        console.log(label("Type", source.type));
        console.log(label("Method", method === "-" ? null : method));
        console.log(label("URL", source.url));
        console.log(label("Org", source.orgId ?? null));
        console.log(label("Last Fetched", source.lastFetchedAt));
        console.log(label("Primary", source.isPrimary ? "yes" : null));
        console.log(label("Status", source.isHidden ? "disabled" : "active"));
        console.log(label("Fetch Priority", source.fetchPriority));
        console.log("");
        console.log(chalk.dim(`  More: "releases tail ${source.slug}" for recent releases · "releases admin source fetch-log ${source.slug}" for fetch history`));
        console.log("");
        return;
      }

      // ── Full list view ──
      const limitOpt = opts.limit ? parseInt(opts.limit, 10) : undefined;
      const pageOpt = opts.page ? parseInt(opts.page, 10) : 1;
      const offsetOpt = limitOpt && limitOpt > 0 ? (pageOpt - 1) * limitOpt : undefined;

      const allSources = await listSourcesWithOrg({
        orgSlug: opts.org,
        productSlug: opts.product,
        category: opts.category,
        hasFeed: opts.hasFeed,
        query: opts.query,
        includeHidden: opts.includeDisabled,
        limit: limitOpt && limitOpt > 0 ? limitOpt : undefined,
        offset: offsetOpt,
      });

      if (allSources.length === 0) {
        if (opts.json) {
          if (limitOpt && limitOpt > 0) {
            console.log(JSON.stringify({ items: [], pagination: { page: pageOpt, pageSize: limitOpt } }, null, 2));
          } else {
            console.log(JSON.stringify([], null, 2));
          }
        } else {
          console.log("No sources configured.");
        }
        return;
      }

      if (opts.json) {
        let items: Record<string, unknown>[];
        if (opts.compact) {
          items = allSources.map((row) => ({
            id: row.id,
            slug: row.slug,
            name: row.name,
            type: row.type,
            method: getFetchMethod(row.type, row.metadata),
            orgName: row.orgName ?? null,
            productName: row.productName ?? null,
            releaseCount: row.releaseCount,
            latestDate: row.latestDate ?? null,
            lastFetchedAt: row.lastFetchedAt ?? null,
          }));
        } else {
          items = allSources.map((row) => ({
            ...row,
            method: getFetchMethod(row.type, row.metadata),
          }));
        }
        if (limitOpt && limitOpt > 0) {
          console.log(JSON.stringify({
            items,
            pagination: { page: pageOpt, pageSize: limitOpt },
          }, null, 2));
        } else {
          console.log(JSON.stringify(items, null, 2));
        }
        return;
      }

      const table = new Table({
        head: ["Name", "Slug", "Type", "Method", "URL", "Org", "Product", "Last Fetched"],
      });

      for (const row of allSources) {
        const method = getFetchMethod(row.type, row.metadata);
        const name = stripAnsi(row.name);
        table.push([
          row.isPrimary ? `${name} ${chalk.yellow("\u2605")}` : name,
          row.slug,
          row.type,
          method,
          row.url,
          row.orgName ? stripAnsi(row.orgName) : chalk.dim("\u2014"),
          row.productName ?? chalk.dim("\u2014"),
          row.lastFetchedAt ?? chalk.dim("never"),
        ]);
      }

      console.log(table.toString());
      console.log(chalk.dim(`\n  More: "releases show <slug>" for source details · "releases tail <slug>" for recent releases`));
    });
}

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { listSourcesWithOrg, findSourceBySlug } from "../../db/queries.js";

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
    .addHelpText("after", `
Examples:
  released list                   List all sources
  released list claude-code       Show details for a single source
  released list --json            List all sources as JSON`)
    .action(async (slug: string | undefined, opts: { json?: boolean }) => {
      // ── Single-source detail view ──
      if (slug) {
        const source = await findSourceBySlug(slug);
        if (!source) {
          console.error(chalk.red(`Source not found: ${slug}`));
          process.exit(1);
        }
        if (opts.json) {
          const method = getFetchMethod(source.type, source.metadata ?? null);
          console.log(JSON.stringify({ ...source, method }, null, 2));
          return;
        }
        const label = (key: string, val: string | null | undefined) =>
          `  ${chalk.bold(key.padEnd(16))} ${val ?? chalk.dim("—")}`;
        const method = getFetchMethod(source.type, source.metadata ?? null);
        console.log(chalk.bold(`\n${source.name}\n`));
        console.log(label("Slug", source.slug));
        console.log(label("Type", source.type));
        console.log(label("Method", method === "-" ? null : method));
        console.log(label("URL", source.url));
        console.log(label("Org", source.orgId ?? null));
        console.log(label("Last Fetched", source.lastFetchedAt));
        console.log(label("Primary", source.isPrimary ? "yes" : null));
        console.log(label("Fetch Priority", source.fetchPriority));
        console.log("");
        return;
      }

      // ── Full list view ──
      const allSources = await listSourcesWithOrg();

      if (allSources.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log("No sources configured.");
        }
        return;
      }

      if (opts.json) {
        const enriched = allSources.map((row) => ({
          ...row,
          method: getFetchMethod(row.type, row.metadata),
        }));
        console.log(JSON.stringify(enriched, null, 2));
        return;
      }

      const table = new Table({
        head: ["Name", "Slug", "Type", "Method", "URL", "Org", "Last Fetched"],
      });

      for (const row of allSources) {
        const method = getFetchMethod(row.type, row.metadata);
        table.push([
          row.name,
          row.slug,
          row.type,
          method,
          row.url,
          row.orgName ?? chalk.dim("\u2014"),
          row.lastFetchedAt ?? chalk.dim("never"),
        ]);
      }

      console.log(table.toString());
    });
}

import { Command } from "commander";
import chalk from "chalk";
import { inArray } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases } from "../../db/schema.js";
import { searchReleases } from "../../db/fts.js";

export function registerSearchCommand(program: Command) {
  program
    .command("search")
    .description("Full-text search across all indexed releases")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results to return", "20")
    .option("--json", "Output as JSON")
    .action(async (query: string, opts: { limit: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10);
      const results = searchReleases(query, limit);

      if (results.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("No results found."));
        }
        return;
      }

      const db = getDb();

      // Batch fetch release metadata and source names
      const releaseIds = results.map((r) => r.id);
      const releaseRows = await db
        .select({ id: releases.id, sourceId: releases.sourceId, publishedAt: releases.publishedAt })
        .from(releases)
        .where(inArray(releases.id, releaseIds));

      const sourceIds = [...new Set(releaseRows.map((r) => r.sourceId))];
      const sourceRows = await db
        .select({ id: sources.id, name: sources.name })
        .from(sources)
        .where(inArray(sources.id, sourceIds));

      const releaseMap = new Map(releaseRows.map((r) => [r.id, r]));
      const sourceMap = new Map(sourceRows.map((s) => [s.id, s.name]));

      if (opts.json) {
        const jsonResults = results.map((result) => {
          const release = releaseMap.get(result.id);
          const sourceName = release ? sourceMap.get(release.sourceId) ?? "Unknown" : "Unknown";
          const preview = result.content.replace(/\n/g, " ").slice(0, 150);
          return {
            id: result.id,
            title: result.title,
            content: preview,
            sourceName,
            publishedAt: release?.publishedAt ?? null,
          };
        });
        console.log(JSON.stringify(jsonResults, null, 2));
        return;
      }

      for (const result of results) {
        const release = releaseMap.get(result.id);
        const sourceName = release ? sourceMap.get(release.sourceId) ?? "Unknown" : "Unknown";
        const date = release?.publishedAt ?? "No date";
        const preview = result.content.replace(/\n/g, " ").slice(0, 150);

        console.log(chalk.cyan.bold(result.title));
        console.log(chalk.dim(`  Source: ${sourceName}  |  Published: ${date}`));
        console.log(`  ${preview}${result.content.length > 150 ? "..." : ""}`);
        console.log();
      }

      console.log(chalk.dim(`${results.length} result(s) found.`));
    });
}

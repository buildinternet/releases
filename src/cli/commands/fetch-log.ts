import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, fetchLog } from "../../db/schema.js";
import { findSourceBySlug } from "../../db/queries.js";
import { timeAgo } from "../../lib/dates.js";

export function registerFetchLogCommand(program: Command) {
  program
    .command("fetch-log [slug]")
    .description("Show fetch history for sources")
    .option("--limit <n>", "Number of log entries", "20")
    .option("--json", "Output as JSON")
    .action(async (slug: string | undefined, opts: { limit?: string; json?: boolean }) => {
      const db = getDb();
      const limit = parseInt(opts.limit ?? "20", 10);

      let query = db
        .select({
          id: fetchLog.id,
          sourceName: sources.name,
          sourceSlug: sources.slug,
          status: fetchLog.status,
          releasesFound: fetchLog.releasesFound,
          releasesInserted: fetchLog.releasesInserted,
          durationMs: fetchLog.durationMs,
          error: fetchLog.error,
          createdAt: fetchLog.createdAt,
        })
        .from(fetchLog)
        .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
        .orderBy(desc(fetchLog.createdAt))
        .limit(limit);

      if (slug) {
        const source = await findSourceBySlug(slug);
        if (!source) {
          console.error(`Source not found: ${slug}`);
          process.exit(1);
        }
        query = query.where(eq(fetchLog.sourceId, source.id)) as typeof query;
      }

      const logs = await query;

      if (logs.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log("No fetch logs found.");
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(logs, null, 2));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Source"),
          chalk.cyan("Status"),
          chalk.cyan("Found"),
          chalk.cyan("Inserted"),
          chalk.cyan("Duration"),
          chalk.cyan("Error"),
          chalk.cyan("When"),
        ],
      });

      for (const log of logs) {
        const statusLabel = log.status === "success"
          ? chalk.green("success")
          : log.status === "error"
            ? chalk.red("error")
            : chalk.dim("no change");

        const errorText = log.error
          ? chalk.red(log.error.length > 40 ? log.error.slice(0, 40) + "..." : log.error)
          : chalk.dim("—");

        table.push([
          log.sourceName,
          statusLabel,
          String(log.releasesFound),
          log.releasesInserted > 0 ? chalk.green(String(log.releasesInserted)) : chalk.dim("0"),
          log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : chalk.dim("—"),
          errorText,
          timeAgo(log.createdAt) ?? "—",
        ]);
      }

      console.log(table.toString());
    });
}

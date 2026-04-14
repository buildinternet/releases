import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { getFetchLogs } from "../../db/queries.js";
import { timeAgo } from "../../lib/dates.js";
import { stripAnsi } from "../../lib/sanitize.js";

export function registerFetchLogCommand(program: Command) {
  program
    .command("fetch-log [slug]")
    .description("Show fetch history for sources")
    .option("--limit <n>", "Number of log entries", "20")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin source fetch-log                 Show recent fetch history
  releases admin source fetch-log my-source       Show history for one source
  releases admin source fetch-log --limit 50
  releases admin source fetch-log --json`)
    .action(async (slug: string | undefined, opts: { limit?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit ?? "20", 10);
      const logs = await getFetchLogs({ sourceSlug: slug, limit });

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
        const statusLabel = log.status === "dry_run"
          ? chalk.magenta("dry run")
          : log.status === "success"
            ? chalk.green("success")
            : log.status === "error"
              ? chalk.red("error")
              : chalk.dim("no change");

        const errorText = log.error
          ? chalk.red(stripAnsi(log.error.length > 40 ? log.error.slice(0, 40) + "..." : log.error))
          : chalk.dim("—");

        table.push([
          log.sourceName || log.sourceSlug || chalk.dim("—"),
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

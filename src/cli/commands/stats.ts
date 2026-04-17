import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { timeAgo } from "@buildinternet/releases-core/dates";
import { stripAnsi } from "../../lib/sanitize.js";
import { getStatsSummary } from "../../db/queries.js";

export function registerStatsCommand(program: Command) {
  program
    .command("stats")
    .description("Show index statistics and recent fetch activity")
    .option("--json", "Output as JSON")
    .option("--days <n>", "Period for recent activity (default: 30)", "30")
    .addHelpText("after", `
Examples:
  releases stats
  releases stats --days 7
  releases stats --json`)
    .action(async (opts: { json?: boolean; days?: string }) => {
      const days = parseInt(opts.days ?? "30", 10);
      const data = await getStatsSummary(days);

      // ── JSON output ──────────────────────────────────────────
      if (opts.json) {
        console.log(JSON.stringify({
          period: data.period,
          totals: data.totals,
          sourceHealth: data.sourceHealth,
          sourceActivity: data.sourceActivity.map((s) => ({
            name: s.sourceName,
            slug: s.sourceSlug,
            type: s.sourceType,
            org: s.orgName,
            lastFetched: s.lastFetchedAt,
            totalReleases: s.totalReleases,
            recentReleases: s.recentReleases,
          })),
          recentActivity: data.recentActivity,
        }, null, 2));
        return;
      }

      // ── Human output ─────────────────────────────────────────
      console.log(chalk.bold("Overview\n"));
      console.log(`  Organizations:  ${data.totals.organizations}`);
      console.log(`  Sources:        ${data.totals.sources}`);
      console.log(`  Releases:       ${data.totals.releases}`);
      console.log(`  Last ${days} days:   ${data.totals.releasesInPeriod} releases\n`);

      console.log(chalk.bold("Source Health\n"));
      console.log(`  ${chalk.green(`${data.sourceHealth.upToDate} up to date`)} (fetched in last ${days} days)`);
      if (data.sourceHealth.stale > 0) {
        console.log(`  ${chalk.yellow(`${data.sourceHealth.stale} stale`)} (fetched, but not recently)`);
      }
      if (data.sourceHealth.neverFetched > 0) {
        console.log(`  ${chalk.red(`${data.sourceHealth.neverFetched} never fetched`)}`);
      }

      // Top sources table
      const activeSources = data.sourceActivity.filter((s) => s.totalReleases > 0 || s.recentReleases > 0);
      if (activeSources.length > 0) {
        console.log(chalk.bold("\nSources by Activity\n"));
        const sourceTable = new Table({
          head: [
            chalk.cyan("Source"),
            chalk.cyan("Org"),
            chalk.cyan("Type"),
            chalk.cyan("Total"),
            chalk.cyan(`Last ${days}d`),
            chalk.cyan("Last Fetched"),
          ],
        });
        for (const s of activeSources) {
          sourceTable.push([
            stripAnsi(s.sourceName),
            s.orgName ? stripAnsi(s.orgName) : chalk.dim("—"),
            s.sourceType,
            String(s.totalReleases),
            s.recentReleases > 0 ? chalk.green(String(s.recentReleases)) : chalk.dim("0"),
            timeAgo(s.lastFetchedAt) ?? chalk.dim("never"),
          ]);
        }
        console.log(sourceTable.toString());
      }

      // Recent fetch activity
      if (data.recentActivity.length > 0) {
        console.log(chalk.bold("\nRecent Fetch Activity\n"));
        const activityTable = new Table({
          head: [
            chalk.cyan("Source"),
            chalk.cyan("Org"),
            chalk.cyan("Status"),
            chalk.cyan("Found"),
            chalk.cyan("New"),
            chalk.cyan("Total"),
            chalk.cyan("Duration"),
            chalk.cyan("When"),
          ],
        });
        for (const f of data.recentActivity) {
          const statusLabel = f.status === "dry_run"
            ? chalk.magenta("dry run")
            : f.status === "success"
              ? chalk.green("success")
              : f.status === "error"
                ? chalk.red("error")
                : chalk.dim("no change");
          activityTable.push([
            stripAnsi(f.sourceName),
            f.orgName ? stripAnsi(f.orgName) : chalk.dim("—"),
            statusLabel,
            String(f.releasesFound),
            f.releasesInserted > 0 ? chalk.green(String(f.releasesInserted)) : chalk.dim("0"),
            String(f.totalReleases),
            f.durationMs ? `${(f.durationMs / 1000).toFixed(1)}s` : chalk.dim("—"),
            timeAgo(f.createdAt) ?? "",
          ]);
        }
        console.log(activityTable.toString());
      } else {
        console.log(chalk.dim("\nNo fetch activity recorded yet. Run `releases admin source fetch` to start."));
      }
    });
}

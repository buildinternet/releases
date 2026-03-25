import { Command } from "commander";
import chalk from "chalk";
import { findSourceBySlug, getRecentReleases } from "../../db/queries.js";
import { summarizeReleases, toReleaseInput } from "../../ai/query.js";
import { daysAgoIso } from "../../lib/dates.js";

export function registerSummaryCommand(program: Command) {
  program
    .command("summary")
    .description("AI-generated summary of recent releases for a source")
    .argument("<slug>", "Source slug")
    .option("-d, --days <n>", "Number of days to look back", "30")
    .action(async (slug: string, opts: { days: string }) => {
      const days = parseInt(opts.days, 10);
      const source = await findSourceBySlug(slug);

      if (!source) {
        console.error(chalk.red(`Source not found: ${slug}`));
        process.exit(1);
      }

      const recentReleases = await getRecentReleases(source.id, daysAgoIso(days));

      if (recentReleases.length === 0) {
        console.log(
          chalk.yellow(`No releases found for ${source.name} in the last ${days} days.`),
        );
        return;
      }

      console.log(
        chalk.dim(`Summarizing ${recentReleases.length} release(s) from ${source.name}...\n`),
      );

      const summary = await summarizeReleases(recentReleases.map(toReleaseInput));
      console.log(summary);
    });
}

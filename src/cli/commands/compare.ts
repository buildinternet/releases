import { Command } from "commander";
import chalk from "chalk";
import { findSourceBySlug, getRecentReleases } from "../../db/queries.js";
import { compareProducts, toReleaseInput } from "../../ai/query.js";
import { daysAgoIso } from "../../lib/dates.js";

export function registerCompareCommand(program: Command) {
  program
    .command("compare")
    .description("AI-generated comparison of recent releases between two sources")
    .argument("<slugA>", "First source slug")
    .argument("<slugB>", "Second source slug")
    .option("-d, --days <n>", "Number of days to look back", "30")
    .action(async (slugA: string, slugB: string, opts: { days: string }) => {
      const days = parseInt(opts.days, 10);
      const cutoff = daysAgoIso(days);

      const [sourceA, sourceB] = await Promise.all([
        findSourceBySlug(slugA),
        findSourceBySlug(slugB),
      ]);

      if (!sourceA) {
        console.error(chalk.red(`Source not found: ${slugA}`));
        process.exit(1);
      }
      if (!sourceB) {
        console.error(chalk.red(`Source not found: ${slugB}`));
        process.exit(1);
      }

      const [releasesA, releasesB] = await Promise.all([
        getRecentReleases(sourceA.id, cutoff),
        getRecentReleases(sourceB.id, cutoff),
      ]);

      if (releasesA.length === 0 && releasesB.length === 0) {
        console.log(
          chalk.yellow(`No releases found for either source in the last ${days} days.`),
        );
        return;
      }

      console.log(
        chalk.dim(
          `Comparing ${releasesA.length} release(s) from ${sourceA.name} with ${releasesB.length} release(s) from ${sourceB.name}...\n`,
        ),
      );

      const comparison = await compareProducts(
        { name: sourceA.name, releases: releasesA.map(toReleaseInput) },
        { name: sourceB.name, releases: releasesB.map(toReleaseInput) },
      );

      console.log(comparison);
    });
}

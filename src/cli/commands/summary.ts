import { Command } from "commander";
import chalk from "chalk";
import { findSourceBySlug, getRecentReleases, findOrg, getRecentReleasesByOrg } from "../../db/queries.js";
import { summarizeReleases, toReleaseInput } from "../../ai/query.js";
import { daysAgoIso, elapsedSec } from "../../lib/dates.js";

export function registerSummaryCommand(program: Command) {
  program
    .command("summary")
    .description("AI-generated summary of recent releases for a source or organization")
    .argument("[slug]", "Source slug")
    .option("-d, --days <n>", "Number of days to look back", "30")
    .option("--org <identifier>", "Summarize across all sources in an organization")
    .option("--instructions <text>", "Additional guidance for the summarizer (e.g. what to focus on, audience, format)")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released summary my-source
  released summary --org acme --days 7
  released summary my-source --instructions "focus on breaking changes"
  released summary my-source --json`)
    .action(async (slug: string | undefined, opts: { days: string; org?: string; instructions?: string; json?: boolean }) => {
      const days = parseInt(opts.days, 10);

      if (!slug && !opts.org) {
        console.error("Error: provide a source slug or --org\n");
        console.error("  released summary my-source");
        console.error("  released summary --org acme");
        process.exit(1);
      }

      let releaseInputs: Parameters<typeof summarizeReleases>[0];
      let label: string;

      if (opts.org && !slug) {
        const org = await findOrg(opts.org);
        if (!org) {
          console.error(chalk.red(`Organization not found: ${opts.org}`));
          process.exit(1);
        }
        const orgReleases = await getRecentReleasesByOrg(org.id, daysAgoIso(days));
        if (orgReleases.length === 0) {
          console.log(
            chalk.yellow(`No releases found for org ${org.name} in the last ${days} days.`),
          );
          return;
        }
        label = org.name;
        releaseInputs = orgReleases.map((r) =>
          toReleaseInput({ ...r, title: `[${r.sourceName}] ${r.title}` }),
        );
      } else {
        const source = await findSourceBySlug(slug!);
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
        label = source.name;
        releaseInputs = recentReleases.map(toReleaseInput);
      }

      if (!opts.json) {
        console.log(
          chalk.dim(`Summarizing ${releaseInputs.length} release(s) from ${label}...\n`),
        );
      }

      const startTime = performance.now();
      const summary = await summarizeReleases(releaseInputs, {
        instructions: opts.instructions,
      });

      if (opts.json) {
        console.log(JSON.stringify({ summary }, null, 2));
      } else {
        console.log(summary);
        console.log(chalk.dim(`\n(${elapsedSec(startTime)}s)`));
      }
    });
}

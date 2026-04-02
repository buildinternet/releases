import type { Command } from "commander";
import chalk from "chalk";
import { findSourceBySlug, getRecentReleases, upsertSummary, getOrgById } from "../../db/queries.js";
import { generateSummary, DEFAULT_WINDOW_DAYS } from "../../ai/summarize.js";
import { isSummarizationEnabled } from "../../ai/summarize-check.js";
import { daysAgoIso } from "../../lib/dates.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "../../lib/logger.js";

export function registerSummarizeCommand(program: Command) {
  program
    .command("summarize")
    .argument("<slug>", "Source slug")
    .option("--monthly", "Generate monthly summary for last month")
    .option("--window <days>", "Rolling window in days", String(DEFAULT_WINDOW_DAYS))
    .option("--json", "Output as JSON")
    .option("--force", "Generate even if summarization is disabled")
    .description("Generate AI summary for a source")
    .action(async (slug: string, opts: { monthly?: boolean; window?: string; json?: boolean; force?: boolean }) => {
      const source = await findSourceBySlug(slug);
      if (!source) {
        console.error(chalk.red(`Source not found: ${slug}`));
        process.exit(1);
      }

      if (!opts.force) {
        const enabled = await isSummarizationEnabled(source);
        if (!enabled) {
          console.error(chalk.yellow(`Summarization is disabled for ${slug}. Use --force to override.`));
          process.exit(1);
        }
      }

      const windowDays = parseInt(opts.window ?? String(DEFAULT_WINDOW_DAYS));
      const org = source.orgId ? await getOrgById(source.orgId) : null;
      const orgDescription = org?.description || undefined;

      if (opts.monthly) {
        const now = new Date();
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const year = lastMonth.getFullYear();
        const month = lastMonth.getMonth() + 1;
        const monthStart = lastMonth.toISOString();
        const monthEnd = new Date(year, month, 1).toISOString();

        const cutoff = daysAgoIso(windowDays);
        const allRecent = await getRecentReleases(source.id, cutoff, source.slug);
        const monthlyReleases = allRecent.filter(
          (r) => r.publishedAt && r.publishedAt >= monthStart && r.publishedAt < monthEnd,
        );

        if (monthlyReleases.length === 0) {
          console.error(chalk.yellow(`No releases found for ${lastMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`));
          process.exit(0);
        }

        const monthName = lastMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
        logger.info(`Generating monthly summary for ${source.name} (${monthName}, ${monthlyReleases.length} releases)...`);

        const result = await generateSummary({
          sourceName: source.name,
          sourceSlug: source.slug,
          releases: monthlyReleases,
          type: "monthly",
          period: monthName,
          orgDescription,
        });

        if (!result) {
          console.error(chalk.red("Summary generation failed"));
          process.exit(1);
        }

        await upsertSummary({
          sourceId: source.id,
          orgId: source.orgId,
          type: "monthly",
          year,
          month,
          summary: result.summary,
          releaseCount: result.releaseCount,
          windowDays: null,
        });

        if (opts.json) {
          console.log(JSON.stringify({ type: "monthly", year, month, summary: result.summary, releaseCount: result.releaseCount }));
        } else {
          console.log(chalk.green(`Monthly summary for ${monthName}:`));
          console.log(stripAnsi(result.summary));
        }
      } else {
        const cutoff = daysAgoIso(windowDays);
        const recentReleases = await getRecentReleases(source.id, cutoff, source.slug);

        if (recentReleases.length === 0) {
          console.error(chalk.yellow(`No releases in the last ${windowDays} days`));
          process.exit(0);
        }

        logger.info(`Generating rolling summary for ${source.name} (${recentReleases.length} releases, ${windowDays}-day window)...`);

        const result = await generateSummary({
          sourceName: source.name,
          sourceSlug: source.slug,
          releases: recentReleases,
          windowDays,
          type: "rolling",
          orgDescription,
        });

        if (!result) {
          console.error(chalk.red("Summary generation failed"));
          process.exit(1);
        }

        await upsertSummary({
          sourceId: source.id,
          orgId: source.orgId,
          type: "rolling",
          windowDays,
          summary: result.summary,
          releaseCount: result.releaseCount,
          year: null,
          month: null,
        });

        if (opts.json) {
          console.log(JSON.stringify({ type: "rolling", windowDays, summary: result.summary, releaseCount: result.releaseCount }));
        } else {
          console.log(chalk.green(`Rolling summary (${windowDays} days):`));
          console.log(stripAnsi(result.summary));
        }
      }
    });
}

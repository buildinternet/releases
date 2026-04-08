import type { Command } from "commander";
import chalk from "chalk";
import {
  findOrg, getSourcesByOrg, getRecentReleases,
  getKnowledgePageForOrg, upsertKnowledgePage,
} from "../../db/queries.js";
import { generateKnowledgePage } from "../../ai/knowledge.js";
import { DEFAULT_WINDOW_DAYS } from "../../ai/summarize.js";
import { daysAgoIso } from "../../lib/dates.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "../../lib/logger.js";

export function registerKnowledgeCommand(program: Command) {
  const cmd = program
    .command("knowledge")
    .description("Generate or update knowledge pages for organizations");

  cmd
    .command("generate")
    .argument("<org>", "Organization slug")
    .option("--json", "Output as JSON")
    .option("--force", "Regenerate from scratch (ignore existing page)")
    .option("--window <days>", "Release window in days", String(DEFAULT_WINDOW_DAYS))
    .description("Generate or update the knowledge page for an organization")
    .action(async (orgSlug: string, opts: { json?: boolean; force?: boolean; window?: string }) => {
      const org = await findOrg(orgSlug);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${orgSlug}`));
        process.exit(1);
      }

      const windowDays = parseInt(opts.window ?? String(DEFAULT_WINDOW_DAYS));
      const cutoff = daysAgoIso(windowDays);
      const orgSources = await getSourcesByOrg(org.id);

      if (orgSources.length === 0) {
        console.error(chalk.yellow(`No sources found for ${org.name}`));
        process.exit(0);
      }

      // Gather recent releases across all org sources
      const allReleases = [];
      for (const source of orgSources) {
        const releases = await getRecentReleases(source.id, cutoff, source.slug);
        allReleases.push(...releases);
      }

      allReleases.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

      if (allReleases.length === 0) {
        console.error(chalk.yellow(`No releases in the last ${windowDays} days for ${org.name}`));
        process.exit(0);
      }

      const existingPage = opts.force ? null : await getKnowledgePageForOrg(org.id, org.slug);

      logger.info(
        `${existingPage ? "Updating" : "Creating"} knowledge page for ${org.name} (${allReleases.length} releases across ${orgSources.length} sources)...`,
      );

      const result = await generateKnowledgePage({
        name: org.name,
        slug: org.slug,
        description: org.description || undefined,
        existingContent: existingPage?.content,
        newReleases: allReleases.slice(0, 50),
        totalReleaseCount: allReleases.length,
        sourceNames: orgSources.map((s) => s.name),
      });

      if (!result) {
        console.error(chalk.red("Knowledge page generation failed"));
        process.exit(1);
      }

      const latestDate = allReleases[0]?.publishedAt ?? null;
      await upsertKnowledgePage({
        scope: "org",
        orgId: org.id,
        content: result.content,
        releaseCount: result.releaseCount,
        lastContributingReleaseAt: latestDate,
      });

      if (opts.json) {
        console.log(JSON.stringify({
          org: org.slug,
          releaseCount: result.releaseCount,
          content: result.content,
          updated: existingPage ? true : false,
        }));
      } else {
        console.log(chalk.green(`${existingPage ? "Updated" : "Created"} knowledge page for ${org.name}`));
        console.log(chalk.dim(`${result.releaseCount} releases across ${orgSources.length} sources\n`));
        console.log(stripAnsi(result.content));
      }
    });

  cmd
    .command("show")
    .argument("<org>", "Organization slug")
    .option("--json", "Output as JSON")
    .description("Display the current knowledge page for an organization")
    .action(async (orgSlug: string, opts: { json?: boolean }) => {
      const org = await findOrg(orgSlug);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${orgSlug}`));
        process.exit(1);
      }

      const page = await getKnowledgePageForOrg(org.id, org.slug);

      if (!page) {
        console.error(chalk.yellow(`No knowledge page exists for ${org.name}. Run: releases knowledge generate ${orgSlug}`));
        process.exit(0);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          org: org.slug,
          content: page.content,
          releaseCount: page.releaseCount,
          generatedAt: page.generatedAt,
          updatedAt: page.updatedAt,
        }));
      } else {
        console.log(chalk.bold(org.name));
        console.log(chalk.dim(`${page.releaseCount} releases · updated ${new Date(page.updatedAt).toLocaleDateString()}\n`));
        console.log(page.content);
      }
    });
}

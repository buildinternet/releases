import type { Command } from "commander";
import chalk from "chalk";
import {
  findOrg, getSourcesByOrg, getProductsByOrg, getRecentReleases,
  getKnowledgePageForOrg, getSourceGuideForOrg, upsertKnowledgePage,
  updateSourceGuideNotes,
} from "../../db/queries.js";
import { generateKnowledgePage } from "../../ai/knowledge.js";
import { generateSourceGuideHeader, assembleSourceGuide, extractNotesFromLegacyGuide } from "../../ai/source-guide.js";
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
      const releaseArrays = await Promise.all(
        orgSources.map((source) => getRecentReleases(source.id, cutoff, source.slug)),
      );
      const allReleases = releaseArrays.flat();

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
      try {
        await upsertKnowledgePage({
          scope: "org",
          orgId: org.id,
          content: result.content,
          releaseCount: result.releaseCount,
          lastContributingReleaseAt: latestDate,
        });
      } catch (err) {
        console.error(chalk.red(`Failed to save knowledge page: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          org: org.slug,
          releaseCount: result.releaseCount,
          content: result.content,
          updated: existingPage !== null,
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

  // ── Source Guide subcommands ──

  cmd
    .command("guide")
    .argument("<org>", "Organization slug")
    .option("--json", "Output as JSON")
    .option("--regenerate", "Regenerate the header from current source metadata")
    .option("--notes <text>", "Replace the agent notes section (pass full content)")
    .description("Show or manage the source guide for an organization")
    .action(async (orgSlug: string, opts: { json?: boolean; regenerate?: boolean; notes?: string }) => {
      const org = await findOrg(orgSlug);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${orgSlug}`));
        process.exit(1);
      }

      const orgSources = await getSourcesByOrg(org.id);

      // Update notes
      if (opts.notes !== undefined) {
        await updateSourceGuideNotes(org.id, org.slug, opts.notes);
        if (opts.json) {
          console.log(JSON.stringify({ org: org.slug, notes: opts.notes, updated: true }));
        } else {
          console.log(chalk.green(`Notes updated for ${org.name} source guide.`));
        }
        return;
      }

      // Fetch existing guide
      const existingPage = await getSourceGuideForOrg(org.id, org.slug);

      // Show existing guide unless --regenerate
      if (!opts.regenerate && existingPage) {
        const assembled = assembleSourceGuide(existingPage.content, existingPage.notes);
        if (opts.json) {
          console.log(JSON.stringify({
            org: org.slug,
            content: assembled,
            notes: existingPage.notes,
            updatedAt: existingPage.updatedAt,
          }));
        } else {
          console.log(assembled);
        }
        return;
      }

      if (orgSources.length === 0) {
        console.error(chalk.yellow(`No sources found for ${org.name}`));
        process.exit(0);
      }

      const orgProducts = await getProductsByOrg(org.id);
      const header = generateSourceGuideHeader({
        orgName: org.name,
        orgSlug: org.slug,
        domain: org.domain,
        sources: orgSources,
        products: orgProducts.map((p) => ({ id: p.id, name: p.name, slug: p.slug, description: p.description })),
      });

      // Preserve notes: from existing notes column, or migrate from old-format content
      let notes: string | null = existingPage?.notes ?? null;
      if (!notes && existingPage) {
        notes = extractNotesFromLegacyGuide(existingPage.content);
      }

      await upsertKnowledgePage({
        scope: "source-guide",
        orgId: org.id,
        content: header,
        notes,
        releaseCount: orgSources.length,
      });

      const assembled = assembleSourceGuide(header, notes);

      if (opts.json) {
        console.log(JSON.stringify({ org: org.slug, content: assembled, notes, sources: orgSources.length }));
      } else {
        console.log(chalk.green(`${existingPage ? "Regenerated" : "Generated"} source guide for ${org.name}\n`));
        console.log(assembled);
      }
    });
}

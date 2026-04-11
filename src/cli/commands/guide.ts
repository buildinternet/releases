import type { Command } from "commander";
import chalk from "chalk";
import {
  findOrg, getSourcesByOrg, getProductsByOrg,
  getSourceGuideForOrg, upsertKnowledgePage,
  updateSourceGuideNotes,
} from "../../db/queries.js";
import { generateSourceGuideHeader, assembleSourceGuide, extractNotesFromLegacyGuide } from "../../ai/source-guide.js";

export function registerGuideCommand(program: Command) {
  program
    .command("guide")
    .argument("<org>", "Organization slug or ID")
    .option("--json", "Output as JSON")
    .option("--regenerate", "Regenerate the header from current source metadata")
    .option("--notes <text>", "Replace the agent notes section (pass full content)")
    .description("Show or manage the source guide for an organization")
    .addHelpText("after", `
Examples:
  releases guide vercel
  releases guide vercel --json
  releases guide vercel --regenerate
  releases guide vercel --notes "### Extraction patterns\\n..."`)
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

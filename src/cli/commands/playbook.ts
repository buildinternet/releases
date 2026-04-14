import type { Command } from "commander";
import chalk from "chalk";
import {
  findOrg, getSourcesByOrg, getProductsByOrg,
  getPlaybookForOrg, upsertOverviewPage,
  updatePlaybookNotes,
} from "../../db/queries.js";
import { generatePlaybookHeader, assemblePlaybook, extractNotesFromLegacyPlaybook } from "../../ai/playbook.js";

export function registerPlaybookCommand(program: Command) {
  program
    .command("playbook")
    .argument("<org>", "Organization slug or ID")
    .option("--json", "Output as JSON")
    .option("--regenerate", "Regenerate the header from current source metadata")
    .option("--notes <text>", "Replace the agent notes section (pass full content)")
    .description("Show or manage the playbook for an organization")
    .addHelpText("after", `
Examples:
  releases admin content playbook vercel
  releases admin content playbook vercel --json
  releases admin content playbook vercel --regenerate
  releases admin content playbook vercel --notes "### Extraction patterns\\n..."`)
    .action(async (orgSlug: string, opts: { json?: boolean; regenerate?: boolean; notes?: string }) => {
      const org = await findOrg(orgSlug);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${orgSlug}`));
        process.exit(1);
      }

      const orgSources = await getSourcesByOrg(org.id);

      // Update notes
      if (opts.notes !== undefined) {
        await updatePlaybookNotes(org.id, org.slug, opts.notes);
        if (opts.json) {
          console.log(JSON.stringify({ org: org.slug, notes: opts.notes, updated: true }));
        } else {
          console.log(chalk.green(`Notes updated for ${org.name} playbook.`));
        }
        return;
      }

      // Fetch existing playbook
      const existingPage = await getPlaybookForOrg(org.id, org.slug);

      // Show existing playbook unless --regenerate
      if (!opts.regenerate && existingPage) {
        const assembled = assemblePlaybook(existingPage.content, existingPage.notes);
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
      const header = generatePlaybookHeader({
        orgName: org.name,
        orgSlug: org.slug,
        domain: org.domain,
        sources: orgSources,
        products: orgProducts.map((p) => ({ id: p.id, name: p.name, slug: p.slug, description: p.description })),
      });

      // Preserve notes: from existing notes column, or migrate from old-format content
      let notes: string | null = existingPage?.notes ?? null;
      if (!notes && existingPage) {
        notes = extractNotesFromLegacyPlaybook(existingPage.content);
      }

      await upsertOverviewPage({
        scope: "playbook",
        orgId: org.id,
        content: header,
        notes,
        releaseCount: orgSources.length,
      });

      const assembled = assemblePlaybook(header, notes);

      if (opts.json) {
        console.log(JSON.stringify({ org: org.slug, content: assembled, notes, sources: orgSources.length }));
      } else {
        console.log(chalk.green(`${existingPage ? "Regenerated" : "Generated"} playbook for ${org.name}\n`));
        console.log(assembled);
      }
    });
}

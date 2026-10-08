import { Command } from "commander";
import chalk from "chalk";
import { findOrg } from "../../../api/orgs.js";
import { getPlaybook, updatePlaybookNotes } from "../../../api/sources.js";
import { orgNotFound } from "../../suggest.js";
import { writeJson } from "../../../lib/output.js";
import { readContentArg } from "../../../lib/input.js";
import { formatOverviewFreshnessHint } from "../../../lib/overview-freshness.js";

interface PlaybookOpts {
  json?: boolean;
  notesFile?: string;
}

export function registerPlaybookCommand(program: Command) {
  program
    .command("playbook")
    .description("Read or update an organization's playbook")
    .argument("<org>", "Organization slug or ID")
    .option("--json", "Output as JSON")
    .option(
      "--notes-file <path>",
      "Path to file with agent notes (use - for stdin; empty file clears)",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases admin playbook vercel
  releases admin playbook vercel --json
  releases admin playbook vercel --notes-file playbook-notes.md
  cat playbook-notes.md | releases admin playbook vercel --notes-file -

The playbook's header (source list, products) regenerates automatically after
any source add/edit/remove — no manual regenerate step is needed. The PATCH
run by --notes-file also seeds a fresh header on first write.`,
    )
    .action(async (orgIdentifier: string, opts: PlaybookOpts) => {
      const notesPayload =
        opts.notesFile !== undefined ? await readContentArg(opts.notesFile) : undefined;

      const org = await findOrg(orgIdentifier);
      if (!org) return orgNotFound(orgIdentifier);

      if (notesPayload !== undefined) {
        await updatePlaybookNotes(org.slug, notesPayload);
        if (opts.json) {
          await writeJson({ org: org.slug, notesUpdated: true });
        } else {
          console.log(chalk.green(`Notes updated for ${org.name} playbook.`));
        }
        return;
      }

      const playbook = await getPlaybook(org.slug);

      if (!playbook) {
        if (opts.json) {
          await writeJson({ org: org.slug, playbook: null });
        } else {
          console.log(chalk.yellow(`No playbook available for ${org.name}.`));
        }
        return;
      }

      if (opts.json) {
        await writeJson({
          org: org.slug,
          content: playbook.content,
          notes: playbook.notes ?? null,
          releaseCount: playbook.releaseCount,
          generatedAt: playbook.generatedAt,
          updatedAt: playbook.updatedAt,
        });
        return;
      }

      // Same content-write freshness rules as org overview (updatedAt over generatedAt).
      const freshnessHint = formatOverviewFreshnessHint(playbook) ?? "generated ?";
      console.log(chalk.bold(`${org.name} — playbook`));
      console.log(chalk.dim(`  ${freshnessHint} · ${playbook.releaseCount} sources`));
      console.log();
      console.log(playbook.content);
      if (playbook.notes) {
        console.log();
        console.log(chalk.dim("─── Agent notes ───"));
        console.log(playbook.notes);
      }
    });
}

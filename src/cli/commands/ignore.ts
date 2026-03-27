import { Command } from "commander";
import chalk from "chalk";
import { findOrg, listIgnoredUrls, addIgnoredUrl, removeIgnoredUrl } from "../../db/queries.js";
import { logger } from "../../lib/logger.js";

export function registerIgnoreCommand(program: Command) {
  const ignore = program
    .command("ignore")
    .description("Manage ignored URLs for an organization (prevents re-discovery)");

  ignore
    .command("list")
    .description("List ignored URLs for an organization")
    .requiredOption("--org <org>", "Organization slug, domain, or name")
    .option("--json", "Output as JSON")
    .action(async (opts: { org: string; json?: boolean }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        logger.error(`Organization not found: ${opts.org}`);
        process.exit(1);
      }

      const rows = await listIgnoredUrls(org.id);

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        logger.info(`No ignored URLs for ${org.name}.`);
        return;
      }

      for (const row of rows) {
        const reasonLabel = row.reason ? chalk.gray(` — ${row.reason}`) : "";
        logger.info(`${chalk.yellow(row.url)}${reasonLabel}`);
      }
    });

  ignore
    .command("add <url>")
    .description("Ignore a URL for an organization")
    .requiredOption("--org <org>", "Organization slug, domain, or name")
    .option("--reason <reason>", "Reason for ignoring this URL")
    .option("--dry-run", "Show what would be ignored without writing")
    .action(async (url: string, opts: { org: string; reason?: string; dryRun?: boolean }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        logger.error(`Organization not found: ${opts.org}`);
        process.exit(1);
      }

      if (opts.dryRun) {
        logger.info(chalk.yellow(`[dry-run] Would ignore for ${org.name}: ${url}${opts.reason ? ` (${opts.reason})` : ""}`));
        return;
      }

      await addIgnoredUrl(url, org.id, opts.reason);
      logger.info(chalk.green(`Ignored for ${org.name}: ${url}${opts.reason ? ` (${opts.reason})` : ""}`));
    });

  ignore
    .command("remove <url>")
    .description("Un-ignore a URL for an organization")
    .requiredOption("--org <org>", "Organization slug, domain, or name")
    .action(async (url: string, opts: { org: string }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        logger.error(`Organization not found: ${opts.org}`);
        process.exit(1);
      }

      await removeIgnoredUrl(url, org.id);
      logger.info(chalk.green(`Un-ignored for ${org.name}: ${url}`));
    });
}

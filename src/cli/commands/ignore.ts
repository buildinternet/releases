import { Command } from "commander";
import chalk from "chalk";
import { findOrg, listIgnoredUrls, addIgnoredUrl, removeIgnoredUrl } from "../../db/queries.js";
import { logger } from "../../lib/logger.js";

export function registerIgnoreCommand(program: Command) {
  const ignore = program
    .command("ignore")
    .description("Manage ignored URLs to prevent re-discovery");

  ignore
    .command("list")
    .description("List all ignored URLs")
    .option("--org <org>", "Filter by organization slug, domain, or name")
    .option("--json", "Output as JSON")
    .action(async (opts: { org?: string; json?: boolean }) => {
      let orgId: string | undefined;

      if (opts.org) {
        const org = await findOrg(opts.org);
        if (!org) {
          logger.error(`Organization not found: ${opts.org}`);
          process.exit(1);
        }
        orgId = org.id;
      }

      const rows = await listIgnoredUrls(orgId);

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        logger.info("No ignored URLs found.");
        return;
      }

      for (const row of rows) {
        const reasonLabel = row.reason ? chalk.gray(` — ${row.reason}`) : "";
        logger.info(`${chalk.yellow(row.url)}${reasonLabel}`);
      }
    });

  ignore
    .command("add <url>")
    .description("Manually ignore a URL to prevent re-discovery")
    .option("--reason <reason>", "Reason for ignoring this URL")
    .option("--org <org>", "Associate with an organization")
    .action(async (url: string, opts: { reason?: string; org?: string }) => {
      let orgId: string | undefined;

      if (opts.org) {
        const org = await findOrg(opts.org);
        if (!org) {
          logger.error(`Organization not found: ${opts.org}`);
          process.exit(1);
        }
        orgId = org.id;
      }

      await addIgnoredUrl(url, { orgId, reason: opts.reason });
      logger.info(chalk.green(`Ignored: ${url}${opts.reason ? ` (${opts.reason})` : ""}`));
    });

  ignore
    .command("remove <url>")
    .description("Un-ignore a URL")
    .action(async (url: string) => {
      await removeIgnoredUrl(url);
      logger.info(chalk.green(`Un-ignored: ${url}`));
    });
}

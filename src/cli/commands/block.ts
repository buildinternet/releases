import { Command } from "commander";
import chalk from "chalk";
import { listBlockedUrls, addBlockedUrl, removeBlockedUrl } from "../../db/queries.js";
import { logger } from "../../lib/logger.js";

export function registerBlockCommand(program: Command) {
  const block = program
    .command("block")
    .description("Manage globally blocked URLs and domains");

  block
    .command("list")
    .description("List all globally blocked patterns")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const rows = await listBlockedUrls();

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        logger.info("No blocked patterns.");
        return;
      }

      for (const row of rows) {
        const typeLabel = row.type === "domain" ? chalk.blue("[domain]") : chalk.gray("[exact]");
        const reasonLabel = row.reason ? chalk.gray(` — ${row.reason}`) : "";
        logger.info(`${typeLabel} ${chalk.yellow(row.pattern)}${reasonLabel}`);
      }
    });

  block
    .command("add <pattern>")
    .description("Block a URL or domain globally")
    .option("--domain", "Treat pattern as a domain (blocks all URLs on that domain)")
    .option("--reason <reason>", "Reason for blocking")
    .option("--dry-run", "Show what would be blocked without writing")
    .action(async (pattern: string, opts: { domain?: boolean; reason?: string; dryRun?: boolean }) => {
      const type = opts.domain ? "domain" as const : "exact" as const;
      const typeLabel = type === "domain" ? "domain" : "URL";

      if (opts.dryRun) {
        logger.info(chalk.yellow(`[dry-run] Would block ${typeLabel}: ${pattern}${opts.reason ? ` (${opts.reason})` : ""}`));
        return;
      }

      await addBlockedUrl(pattern, type, opts.reason);
      logger.info(chalk.green(`Blocked ${typeLabel}: ${pattern}${opts.reason ? ` (${opts.reason})` : ""}`));
    });

  block
    .command("remove <pattern>")
    .description("Unblock a URL or domain")
    .action(async (pattern: string) => {
      await removeBlockedUrl(pattern);
      logger.info(chalk.green(`Unblocked: ${pattern}`));
    });
}

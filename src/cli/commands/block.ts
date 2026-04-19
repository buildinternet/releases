import { Command } from "commander";
import chalk from "chalk";
import { listBlockedUrls, addBlockedUrl, removeBlockedUrl } from "../../db/queries.js";
import { logger } from "@buildinternet/releases-lib/logger";

export function registerBlockCommand(program: Command) {
  const block = program.command("block").description("Manage globally blocked URLs and domains");

  block
    .command("list")
    .description("List all globally blocked patterns")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy block list
  releases admin policy block list --json`,
    )
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
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy block add https://example.com/spam
  releases admin policy block add example.com --domain --reason "spam site"
  releases admin policy block add https://example.com/spam --dry-run`,
    )
    .action(
      async (
        pattern: string,
        opts: { domain?: boolean; reason?: string; dryRun?: boolean; json?: boolean },
      ) => {
        const type = opts.domain ? ("domain" as const) : ("exact" as const);
        const typeLabel = type === "domain" ? "domain" : "URL";

        if (opts.dryRun) {
          if (opts.json) {
            console.log(
              JSON.stringify({ pattern, type, reason: opts.reason ?? null, dryRun: true }, null, 2),
            );
          } else {
            logger.info(
              chalk.yellow(
                `[dry-run] Would block ${typeLabel}: ${pattern}${opts.reason ? ` (${opts.reason})` : ""}`,
              ),
            );
          }
          return;
        }

        await addBlockedUrl(pattern, type, opts.reason);
        if (opts.json) {
          console.log(
            JSON.stringify(
              { pattern, type, reason: opts.reason ?? null, status: "blocked" },
              null,
              2,
            ),
          );
        } else {
          logger.info(
            chalk.green(
              `Blocked ${typeLabel}: ${pattern}${opts.reason ? ` (${opts.reason})` : ""}`,
            ),
          );
        }
      },
    );

  block
    .command("remove <pattern>")
    .description("Unblock a URL or domain")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy block remove https://example.com/spam
  releases admin policy block remove example.com`,
    )
    .action(async (pattern: string, opts: { json?: boolean }) => {
      await removeBlockedUrl(pattern);
      if (opts.json) {
        console.log(JSON.stringify({ pattern, status: "unblocked" }, null, 2));
      } else {
        logger.info(chalk.green(`Unblocked: ${pattern}`));
      }
    });
}

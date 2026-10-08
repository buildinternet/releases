import { Command } from "commander";
import chalk from "chalk";
import { listBlockedUrls, addBlockedUrl, removeBlockedUrl } from "../../api/orgs.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import {
  DEFAULT_PAGE_SIZE,
  formatTruncationWarning,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";

export function registerBlockCommand(program: Command) {
  const block = program.command("block").description("Manage globally blocked URLs and domains");

  block
    .command("list")
    .description("List all globally blocked patterns")
    .option("--json", "Output as JSON")
    .option("--limit <n>", `Limit the number of results (default ${DEFAULT_PAGE_SIZE})`)
    .option("--page <n>", "Page number for paginated results")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy block list
  releases admin policy block list --json`,
    )
    .action(async (opts: { json?: boolean; limit?: string; page?: string }) => {
      const parsedLimit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        logger.error("--limit must be a positive integer");
        process.exit(1);
      }
      const explicitLimit = parsedLimit !== undefined;
      const pageSize = explicitLimit ? parsedLimit : DEFAULT_PAGE_SIZE;

      const parsedPage = opts.page === undefined ? 1 : Number(opts.page);
      if (!Number.isInteger(parsedPage) || parsedPage <= 0) {
        logger.error("--page must be a positive integer");
        process.exit(1);
      }
      const page = parsedPage;

      const { items: rows, pagination } = await listBlockedUrls({ limit: pageSize, page });

      if (opts.json) {
        const response: ListResponse<(typeof rows)[number]> = { items: rows, pagination };
        await writeJson(response);
        if (!explicitLimit && pagination.hasMore) {
          logger.warn(
            formatTruncationWarning({
              returned: rows.length,
              pageSize,
              commandExample: `releases admin policy block list --json --limit <n> --page <p>`,
            }),
          );
        }
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
      if (!explicitLimit && pagination.hasMore) {
        logger.warn(
          formatTruncationWarning({
            returned: rows.length,
            pageSize,
            commandExample: `releases admin policy block list --limit <n> --page <p>`,
          }),
        );
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
        await writeJson({ pattern, status: "unblocked" });
      } else {
        logger.info(chalk.green(`Unblocked: ${pattern}`));
      }
    });
}

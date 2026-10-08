import { Command } from "commander";
import chalk from "chalk";
import { findOrg, listIgnoredUrls, addIgnoredUrl, removeIgnoredUrl } from "../../api/orgs.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import {
  DEFAULT_PAGE_SIZE,
  formatTruncationWarning,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";

export function registerIgnoreCommand(program: Command) {
  const ignore = program
    .command("ignore")
    .description("Manage ignored URLs for an organization (prevents re-discovery)");

  ignore
    .command("list")
    .description("List ignored URLs for an organization")
    .requiredOption("--org <org>", "Organization ID (org_…), slug, domain, name, or handle")
    .option("--json", "Output as JSON")
    .option("--limit <n>", `Limit the number of results (default ${DEFAULT_PAGE_SIZE})`)
    .option("--page <n>", "Page number for paginated results")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy ignore list --org acme
  releases admin policy ignore list --org acme --json`,
    )
    .action(async (opts: { org: string; json?: boolean; limit?: string; page?: string }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        logger.error(`Organization not found: ${opts.org}`);
        process.exit(1);
      }

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

      const { items: rows, pagination } = await listIgnoredUrls(org.id, {
        limit: pageSize,
        page,
      });

      if (opts.json) {
        const response: ListResponse<(typeof rows)[number]> = { items: rows, pagination };
        await writeJson(response);
        if (!explicitLimit && pagination.hasMore) {
          logger.warn(
            formatTruncationWarning({
              returned: rows.length,
              pageSize,
              commandExample: `releases admin policy ignore list --org ${opts.org} --json --limit <n> --page <p>`,
            }),
          );
        }
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
      if (!explicitLimit && pagination.hasMore) {
        logger.warn(
          formatTruncationWarning({
            returned: rows.length,
            pageSize,
            commandExample: `releases admin policy ignore list --org ${opts.org} --limit <n> --page <p>`,
          }),
        );
      }
    });

  ignore
    .command("add <url>")
    .description("Ignore a URL for an organization")
    .requiredOption("--org <org>", "Organization ID (org_…), slug, domain, name, or handle")
    .option("--reason <reason>", "Reason for ignoring this URL")
    .option("--dry-run", "Show what would be ignored without writing")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy ignore add https://example.com/blog --org acme
  releases admin policy ignore add https://example.com/blog --org acme --reason "not a changelog"
  releases admin policy ignore add https://example.com/blog --org acme --dry-run`,
    )
    .action(async (url: string, opts: { org: string; reason?: string; dryRun?: boolean }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        logger.error(`Organization not found: ${opts.org}`);
        process.exit(1);
      }

      if (opts.dryRun) {
        logger.info(
          chalk.yellow(
            `[dry-run] Would ignore for ${org.name}: ${url}${opts.reason ? ` (${opts.reason})` : ""}`,
          ),
        );
        return;
      }

      await addIgnoredUrl(url, org.id, opts.reason);
      logger.info(
        chalk.green(`Ignored for ${org.name}: ${url}${opts.reason ? ` (${opts.reason})` : ""}`),
      );
    });

  ignore
    .command("remove <url>")
    .description("Un-ignore a URL for an organization")
    .requiredOption("--org <org>", "Organization ID (org_…), slug, domain, name, or handle")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin policy ignore remove https://example.com/blog --org acme`,
    )
    .action(async (url: string, opts: { org: string; json?: boolean }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        logger.error(`Organization not found: ${opts.org}`);
        process.exit(1);
      }

      await removeIgnoredUrl(url, org.id);
      if (opts.json) {
        await writeJson({ url, org: org.slug, status: "unignored" });
      } else {
        logger.info(chalk.green(`Un-ignored for ${org.name}: ${url}`));
      }
    });
}

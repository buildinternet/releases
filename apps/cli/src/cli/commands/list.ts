import { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../render/table.js";
import { listSourcesWithOrg, findSource } from "../../api/sources.js";
import type { SourceWithOrg } from "../../api/types.js";
import { sourceNotFound } from "../suggest.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { writeJson } from "../../lib/output.js";
import { handlePageAll } from "../../lib/paginate.js";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  DEFAULT_PAGE_SIZE,
  parseMetadataObject,
  formatTruncationWarning,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";
import { isValidKind, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";
import { getFetchMethod } from "../../lib/source-display.js";

function paginateExample(json: boolean): string {
  return `releases list${json ? " --json" : ""} --limit <n> --page <p>`;
}

export function registerListCommand(program: Command, registerOpts?: { alias?: string }) {
  const cmd = program
    .command("list")
    .description("List all configured changelog sources, or show details for a single source");
  if (registerOpts?.alias) cmd.alias(registerOpts.alias);
  cmd
    .argument("[source]", "Show details for a specific source (src_… or slug)")
    .option("--json", "Output as JSON")
    .option("--org <org>", "Filter by organization (org_…, slug, domain, name, or handle)")
    .option("--product <product>", "Filter by product (prod_… or slug)")
    .option("--has-feed", "Only show sources that have a discovered feed URL")
    .option("--query <text>", "Filter by name, slug, or URL")
    .option("--category <category>", "Filter by organization or product category")
    .option(
      "--kind <kind>",
      `Filter by source taxonomy (${KIND_VALUES.join(", ")}). Matches the source's own kind only (no inheritance).`,
    )
    .option("--include-disabled", "Include disabled sources in the list")
    .option("--compact", "Return lightweight fields only")
    .option("--limit <n>", `Limit the number of results (default ${DEFAULT_PAGE_SIZE})`)
    .option("--page <n>", "Page number for paginated results")
    .option("--flat", "Legacy: return a bare array instead of the paginated envelope (--json only)")
    .option(
      "--page-all",
      "Stream every page as newline-delimited JSON (one source per line, --json only)",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases list                                    List all sources
  releases list src_abc123                         Show details for a specific source
  releases list --kind sdk                         Filter by kind
  releases list --org vercel --category ai         Filter by org and category`,
    )
    .action(
      async (
        slug: string | undefined,
        opts: {
          json?: boolean;
          org?: string;
          product?: string;
          category?: string;
          kind?: string;
          hasFeed?: boolean;
          query?: string;
          includeDisabled?: boolean;
          compact?: boolean;
          limit?: string;
          page?: string;
          flat?: boolean;
          pageAll?: boolean;
        },
      ) => {
        if (opts.kind !== undefined && !isValidKind(opts.kind)) {
          logger.error(`Invalid kind "${opts.kind}". Must be one of: ${KIND_VALUES.join(", ")}`);
          process.exit(1);
        }
        const kind = opts.kind as Kind | undefined;
        // Validate pagination flags before the slug fast path so malformed
        // --limit / --page still error consistently, even when ignored by the
        // single-source branch.
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

        if (slug) {
          const source = await findSource(slug);
          if (!source) return sourceNotFound(slug);
          const parsedMeta = parseMetadataObject(source.metadata);
          const method = getFetchMethod(source.type, parsedMeta);
          if (opts.json) {
            const parsed: Record<string, unknown> = {
              ...source,
              method,
              metadata: parsedMeta ?? source.metadata,
            };
            await writeJson(parsed);
            return;
          }
          const label = (key: string, val: string | null | undefined) =>
            `  ${chalk.bold(key.padEnd(16))} ${val ?? chalk.dim("—")}`;
          console.log(chalk.bold(`\n${stripAnsi(source.name)}\n`));
          console.log(label("Slug", source.slug));
          console.log(label("Type", source.type));
          console.log(label("Method", method === "-" ? null : method));
          console.log(label("URL", source.url));
          console.log(label("Org", source.orgId ?? null));
          console.log(label("Last Fetched", source.lastFetchedAt));
          console.log(label("Primary", source.isPrimary ? "yes" : null));
          console.log(label("Status", source.isHidden ? "disabled" : "active"));
          console.log(label("Fetch Priority", source.fetchPriority));
          console.log("");
          return;
        }

        const filters = {
          orgSlug: opts.org,
          productSlug: opts.product,
          category: opts.category,
          kind,
          hasFeed: opts.hasFeed,
          query: opts.query,
          includeHidden: opts.includeDisabled,
        };

        // Shared row → JSON mapper for both the single-page envelope and the
        // --page-all NDJSON stream, so they project an identical shape.
        const toJson = (row: SourceWithOrg): Record<string, unknown> => {
          const parsedMeta = parseMetadataObject(row.metadata);
          const method = getFetchMethod(row.type, parsedMeta);
          if (opts.compact) {
            return {
              id: row.id,
              slug: row.slug,
              name: row.name,
              type: row.type,
              method,
              orgName: row.orgName ?? null,
              productName: row.productName ?? null,
              releaseCount: row.releaseCount,
              latestDate: row.latestDate ?? null,
              lastFetchedAt: row.lastFetchedAt ?? null,
            };
          }
          return { ...row, method, metadata: parsedMeta ?? row.metadata };
        };

        // --page-all: stream every page as NDJSON (one source per line). Returns
        // true only when it handled the request (--json); otherwise falls through.
        if (
          await handlePageAll(
            opts,
            async (p) => {
              const { items, pagination } = await listSourcesWithOrg({
                ...filters,
                limit: pageSize,
                page: p,
                envelope: true,
              });
              return { items, hasMore: pagination.hasMore };
            },
            toJson,
          )
        )
          return;

        const { items: pageItems, pagination: apiPagination } = await listSourcesWithOrg({
          ...filters,
          limit: pageSize,
          page,
          envelope: true,
        });

        if (pageItems.length === 0 && page === 1 && !opts.json) {
          console.log("No sources configured.");
          return;
        }

        if (opts.json) {
          const items: Record<string, unknown>[] = pageItems.map(toJson);

          const warnTruncated = !explicitLimit && apiPagination.hasMore;

          if (opts.flat) {
            await writeJson(items);
          } else {
            const response: ListResponse<Record<string, unknown>> = {
              items,
              pagination: apiPagination,
            };
            await writeJson(response);
          }

          if (warnTruncated) {
            logger.warn(
              formatTruncationWarning({
                returned: items.length,
                pageSize,
                commandExample: paginateExample(true),
              }),
            );
          }
          return;
        }

        console.log(
          renderTable({
            head: [
              { label: "Name" },
              { label: "Slug", noTruncate: true },
              { label: "Type", noTruncate: true },
              { label: "Method", noTruncate: true },
              { label: "URL" },
              { label: "Org" },
              { label: "Product" },
              // Per-source release count \u2014 answers "how many releases does this
              // source have?" without dropping to the raw API. #304
              { label: "Releases", noTruncate: true },
              { label: "Last Fetched", noTruncate: true },
            ],
            rows: pageItems.map((row) => {
              const name = stripAnsi(row.name);
              return [
                row.isPrimary ? `${name} ${chalk.yellow("\u2605")}` : name,
                row.slug,
                row.type,
                getFetchMethod(row.type, parseMetadataObject(row.metadata)),
                row.url,
                row.orgName ? stripAnsi(row.orgName) : chalk.dim("\u2014"),
                row.productName ?? chalk.dim("\u2014"),
                row.releaseCount != null ? String(row.releaseCount) : chalk.dim("\u2014"),
                row.lastFetchedAt ?? chalk.dim("never"),
              ];
            }),
          }),
        );
        if (!explicitLimit && apiPagination.hasMore) {
          logger.warn(
            formatTruncationWarning({
              returned: pageItems.length,
              pageSize,
              commandExample: paginateExample(false),
            }),
          );
        }
      },
    );
}

import { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../render/table.js";
import { getStuckSources } from "../../api/sources.js";
import { timeAgo } from "@buildinternet/releases-core/dates";
import { stripAnsi } from "../../lib/sanitize.js";
import { writeJson } from "../../lib/output.js";

export function registerStuckCommand(program: Command) {
  program
    .command("stuck")
    .description("List sources that chronically fail to fetch (pause candidates)")
    .option("--window <n>", "Recent fetch attempts to examine per source", "5")
    .option("--min-attempts <n>", "Minimum attempts required to appear", "3")
    .option("--include-paused", "Include already-paused sources")
    .option("--limit <n>", "Page size")
    .option("--page <n>", "Page number")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source stuck                        List chronically failing sources
  releases admin source stuck --window 10            Examine last 10 attempts per source
  releases admin source stuck --min-attempts 5       Require at least 5 attempts
  releases admin source stuck --include-paused       Include already-paused sources
  releases admin source stuck --limit 50
  releases admin source stuck --json`,
    )
    .action(
      async (opts: {
        window?: string;
        minAttempts?: string;
        includePaused?: boolean;
        limit?: string;
        page?: string;
        json?: boolean;
      }) => {
        const result = await getStuckSources({
          // --window / --min-attempts always have commander defaults, so they're never undefined here.
          window: parseInt(opts.window!, 10),
          minAttempts: parseInt(opts.minAttempts!, 10),
          includePaused: opts.includePaused,
          limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
          page: opts.page ? parseInt(opts.page, 10) : undefined,
        });

        if (opts.json) {
          // Match the CLI's ListResponse JSON contract (see list.ts): { items, pagination }.
          await writeJson({ items: result.items, pagination: result.pagination });
          return;
        }

        const { items, pagination, meta } = result;
        const summary = `${items.length === 0 ? "No" : items.length} stuck source(s) · window=${meta.window} minAttempts=${meta.minAttempts}`;

        if (items.length === 0) {
          console.log(summary);
          return;
        }

        console.log(
          renderTable({
            head: [
              { label: "Org" },
              { label: "Source" },
              { label: "Type", noTruncate: true },
              { label: "Priority", noTruncate: true },
              { label: "Errors", noTruncate: true, alignRight: true },
              { label: "Last OK", noTruncate: true },
              { label: "Last Error" },
            ],
            rows: items.map((item) => {
              const orgLabel = item.orgSlug ?? chalk.dim("—");
              const sourceLabel = item.isPrimary
                ? `${item.sourceSlug} ${chalk.dim("*")}`
                : item.sourceSlug;
              let priorityLabel: string;
              if (item.fetchPriority === "paused") priorityLabel = chalk.dim("paused");
              else if (item.fetchPriority === "low") priorityLabel = chalk.yellow("low");
              else priorityLabel = "normal";
              const errorsLabel = chalk.red(`${item.recentErrors}/${item.recentAttempts}`);
              const lastOkLabel = item.lastSuccessAt
                ? (timeAgo(item.lastSuccessAt) ?? chalk.dim("—"))
                : chalk.dim("never");
              const lastErrorLabel = item.lastError
                ? chalk.red(stripAnsi(item.lastError))
                : chalk.dim("—");

              return [
                orgLabel,
                sourceLabel,
                item.type,
                priorityLabel,
                errorsLabel,
                lastOkLabel,
                lastErrorLabel,
              ];
            }),
          }),
        );

        console.log(chalk.dim(`\n${summary}`));
        console.log(
          chalk.dim(`Pause one with: releases admin source update <id|org/slug> --priority paused`),
        );

        if (pagination.hasMore) {
          const nextPage = pagination.page + 1;
          console.log(
            chalk.dim(
              `More: releases admin source stuck --page ${nextPage}${opts.limit ? ` --limit ${opts.limit}` : ""}`,
            ),
          );
        }
      },
    );
}

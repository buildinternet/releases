import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { findOrg, findSourceBySlug, getLatestReleases } from "../../db/queries.js";
import { stripAnsi } from "../../lib/sanitize.js";

export function registerLatestCommand(program: Command) {
  program
    .command("latest")
    .description("Show the latest releases, optionally filtered by source")
    .argument("[slug]", "Source slug to filter by")
    .option("-c, --count <n>", "Number of releases to show", "10")
    .option("--org <identifier>", "Filter to an organization")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released latest                         Latest releases across all sources
  released latest my-source               Latest releases from one source
  released latest --org acme --count 20   Latest 20 releases from an org
  released latest --json                  Output as JSON`)
    .action(async (slug: string | undefined, opts: { count: string; org?: string; json?: boolean }) => {
      const count = parseInt(opts.count, 10);

      if (slug) {
        const source = await findSourceBySlug(slug);
        if (!source) {
          console.error(chalk.red(`Source not found: ${slug}`));
          process.exit(1);
        }
      }

      let orgSlug: string | undefined;
      if (opts.org) {
        const org = await findOrg(opts.org);
        if (!org) {
          console.error(chalk.red(`Organization not found: ${opts.org}`));
          process.exit(1);
        }
        orgSlug = org.slug;
      }

      const rows = await getLatestReleases({ slug, orgSlug, count });

      if (rows.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("No releases found."));
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Source"),
          chalk.cyan("Title"),
          chalk.cyan("Version"),
          chalk.cyan("Published At"),
        ],
      });

      for (const row of rows) {
        table.push([
          stripAnsi(row.sourceName),
          stripAnsi(row.title),
          row.version ? stripAnsi(row.version) : "-",
          row.publishedAt ?? "-",
        ]);
      }

      console.log(table.toString());
    });
}

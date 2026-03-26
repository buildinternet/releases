import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { eq, desc, inArray } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases } from "../../db/schema.js";
import { findOrg } from "../../db/queries.js";

export function registerLatestCommand(program: Command) {
  program
    .command("latest")
    .description("Show the latest releases, optionally filtered by source")
    .argument("[slug]", "Source slug to filter by")
    .option("-c, --count <n>", "Number of releases to show", "10")
    .option("--org <identifier>", "Filter to an organization")
    .option("--json", "Output as JSON")
    .action(async (slug: string | undefined, opts: { count: string; org?: string; json?: boolean }) => {
      const db = getDb();
      const count = parseInt(opts.count, 10);

      if (slug) {
        const [source] = await db
          .select()
          .from(sources)
          .where(eq(sources.slug, slug));

        if (!source) {
          console.error(chalk.red(`Source not found: ${slug}`));
          process.exit(1);
        }
      }

      let orgSourceIds: string[] | undefined;
      if (opts.org) {
        const org = await findOrg(opts.org);
        if (!org) {
          console.error(chalk.red(`Organization not found: ${opts.org}`));
          process.exit(1);
        }
        const orgSources = await db.select({ id: sources.id }).from(sources).where(eq(sources.orgId, org.id));
        orgSourceIds = orgSources.map((s) => s.id);
      }

      if (orgSourceIds !== undefined && orgSourceIds.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("No releases found."));
        }
        return;
      }

      let query = db
        .select({
          title: releases.title,
          version: releases.version,
          publishedAt: releases.publishedAt,
          sourceName: sources.name,
        })
        .from(releases)
        .innerJoin(sources, eq(releases.sourceId, sources.id))
        .orderBy(desc(releases.publishedAt))
        .limit(count);

      if (slug) {
        query = query.where(eq(sources.slug, slug)) as typeof query;
      } else if (orgSourceIds) {
        query = query.where(inArray(releases.sourceId, orgSourceIds)) as typeof query;
      }

      const rows = await query;

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
          row.sourceName,
          row.title,
          row.version ?? "-",
          row.publishedAt ?? "-",
        ]);
      }

      console.log(table.toString());
    });
}

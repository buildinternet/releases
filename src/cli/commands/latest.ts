import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases } from "../../db/schema.js";

export function registerLatestCommand(program: Command) {
  program
    .command("latest")
    .description("Show the latest releases, optionally filtered by source")
    .argument("[slug]", "Source slug to filter by")
    .option("-c, --count <n>", "Number of releases to show", "10")
    .action(async (slug: string | undefined, opts: { count: string }) => {
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
      }

      const rows = await query;

      if (rows.length === 0) {
        console.log(chalk.yellow("No releases found."));
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

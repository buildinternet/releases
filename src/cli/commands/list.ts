import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, organizations } from "../../db/schema.js";

export function registerListCommand(program: Command) {
  program
    .command("list")
    .description("List all configured changelog sources")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const db = getDb();
      const allSources = await db
        .select({
          id: sources.id,
          name: sources.name,
          slug: sources.slug,
          type: sources.type,
          url: sources.url,
          lastFetchedAt: sources.lastFetchedAt,
          orgName: organizations.name,
        })
        .from(sources)
        .leftJoin(organizations, eq(sources.orgId, organizations.id));

      if (allSources.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log("No sources configured.");
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(allSources, null, 2));
        return;
      }

      const table = new Table({
        head: ["Name", "Slug", "Type", "URL", "Org", "Last Fetched"],
      });

      for (const row of allSources) {
        table.push([
          row.name,
          row.slug,
          row.type,
          row.url,
          row.orgName ?? chalk.dim("\u2014"),
          row.lastFetchedAt ?? chalk.dim("never"),
        ]);
      }

      console.log(table.toString());
    });
}

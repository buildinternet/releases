import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";

export function registerListCommand(program: Command) {
  program
    .command("list")
    .description("List all configured changelog sources")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const db = getDb();
      const allSources = await db.select().from(sources);

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
        head: ["Name", "Slug", "Type", "URL", "Last Fetched"],
      });

      for (const row of allSources) {
        table.push([
          row.name,
          row.slug,
          row.type,
          row.url,
          row.lastFetchedAt ?? chalk.dim("never"),
        ]);
      }

      console.log(table.toString());
    });
}

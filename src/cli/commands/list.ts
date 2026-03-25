import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";

export function registerListCommand(program: Command) {
  program
    .command("list")
    .description("List all configured changelog sources")
    .action(async () => {
      const db = getDb();
      const rows = await db.select().from(sources);

      if (rows.length === 0) {
        console.log("No sources configured.");
        return;
      }

      const table = new Table({
        head: ["Name", "Slug", "Type", "URL", "Last Fetched"],
      });

      for (const row of rows) {
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

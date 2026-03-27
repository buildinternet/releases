import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { listSourcesWithOrg } from "../../db/queries.js";

export function registerListCommand(program: Command) {
  program
    .command("list")
    .description("List all configured changelog sources")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released list
  released list --json`)
    .action(async (opts: { json?: boolean }) => {
      const allSources = await listSourcesWithOrg();

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

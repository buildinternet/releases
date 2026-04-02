import { Command } from "commander";
import chalk from "chalk";
import { registerAddCommand } from "./commands/add.js";
import { registerEditCommand } from "./commands/edit.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerListCommand } from "./commands/list.js";
import { registerFetchCommand } from "./commands/fetch.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerLatestCommand } from "./commands/latest.js";
import { registerSummaryCommand } from "./commands/summary.js";
import { registerCompareCommand } from "./commands/compare.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerUsageCommand } from "./commands/usage.js";
import { registerOrgCommand } from "./commands/org.js";
import { registerProductCommand } from "./commands/product.js";
import { registerDiscoverCommand } from "./commands/discover.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerApiCommand } from "./commands/api.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerFetchLogCommand } from "./commands/fetch-log.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerIgnoreCommand } from "./commands/ignore.js";
import { registerBlockCommand } from "./commands/block.js";
import { registerImportCommand } from "./commands/import.js";
import { registerEvaluateCommand } from "./commands/evaluate.js";
import { registerSummarizeCommand } from "./commands/summarize.js";
import { registerEnrichCommand } from "./commands/enrich.js";
import { registerMediaCommand } from "./commands/media.js";
import { registerTaskCommand } from "./commands/task.js";
import { CATEGORIES } from "../lib/categories.js";

export const VERSION = "0.9.0";

function row(name: string, desc: string, pad = 22): string {
  const gap = " ".repeat(Math.max(2, pad - name.length));
  return `  ${chalk.bold(name)}${gap}${chalk.dim(desc)}`;
}

function printStyledHelp(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${chalk.bold("released")} ${chalk.dim(`v${VERSION}`)}`);
  lines.push(chalk.dim("Changelog indexer and registry for AI agents and developers"));
  lines.push("");

  lines.push("To get started, onboard a company's changelogs:");
  lines.push("");
  lines.push(`  $ released onboard <company>`);
  lines.push("");
  lines.push("The most common commands from there are:");
  lines.push("");
  lines.push(`  - released fetch      : ${chalk.dim("Fetch new releases from sources")}`);
  lines.push(`  - released search     : ${chalk.dim("Full-text search across releases")}`);
  lines.push(`  - released latest     : ${chalk.dim("Show the most recent releases")}`);
  lines.push(`  - released list       : ${chalk.dim("List and inspect sources")}`);
  lines.push("");

  lines.push(chalk.cyan("Available Commands:"));
  lines.push(row("add <url>", "Add a new changelog source"));
  lines.push(row("edit <slug>", "Edit source settings"));
  lines.push(row("remove <slug>", "Remove a source"));
  lines.push(row("list [slug]", "List sources or inspect one"));
  lines.push(row("import <file>", "Bulk-import orgs and sources"));
  lines.push(row("discover <query>", "Discover changelogs for a company"));
  lines.push(row("evaluate <slug>", "Evaluate a source"));
  lines.push(row("fetch [slug]", "Fetch releases from sources"));
  lines.push(row("fetch-log [slug]", "View recent fetch history"));
  lines.push(row("check <slug>", "Check a source URL for changes"));
  lines.push(row("enrich <slug>", "Enrich sparse releases with full content"));
  lines.push(row("search <query>", "Full-text search across releases"));
  lines.push(row("latest [slug]", "Show latest releases"));
  lines.push(row("summary <slug>", "Summarize recent changes"));
  lines.push(row("summarize <slug>", "AI-powered release summary"));
  lines.push(row("compare <a> <b>", "Compare releases between sources"));
  lines.push(row("stats", "Show database statistics"));
  lines.push(row("org <action>", "Manage organizations"));
  lines.push(row("product <action>", "Manage products within orgs"));
  lines.push(row("categories", "List valid category values"));
  lines.push(row("release <action>", "Show, edit, delete, or suppress releases"));
  lines.push(row("block <action>", "Manage globally blocked URLs"));
  lines.push(row("ignore <action>", "Manage org-scoped ignored URLs"));
  lines.push(row("onboard <company>", "AI-powered company onboarding"));
  lines.push(row("serve", "Start MCP server on stdio"));
  lines.push(row("api", "Start local API server"));
  lines.push(row("task <action>", "Manage remote sessions"));
  lines.push(row("media <action>", "Media management (backfill)"));
  lines.push(row("usage", "Show API usage stats"));
  lines.push("");

  lines.push(chalk.cyan("Flags:"));
  lines.push(row("--json", "Machine-readable JSON output"));
  lines.push(row("--dry-run", "Preview without writing changes"));
  lines.push(row("-h, --help", "Display help for a command"));
  lines.push(row("-v, --version", "Print version number"));
  lines.push("");

  lines.push(chalk.dim(`Use ${chalk.white('"released <command> --help"')} for more information about a command.`));

  return lines.join("\n");
}

export const program = new Command()
  .name("released")
  .description("Changelog indexer and registry for AI agents and developers")
  .version(VERSION, "-v, --version")
  .helpOption(false)
  .option("-h, --help", "Display help")
  .action(() => {
    console.log(printStyledHelp());
    process.exit(0);
  });

registerAddCommand(program);
registerEditCommand(program);
registerRemoveCommand(program);
registerListCommand(program);
registerFetchCommand(program);
registerSearchCommand(program);
registerLatestCommand(program);
registerSummaryCommand(program);
registerCompareCommand(program);
registerServeCommand(program);
registerUsageCommand(program);
registerOrgCommand(program);
registerProductCommand(program);
registerDiscoverCommand(program);
registerStatsCommand(program);
registerApiCommand(program);
registerReleaseCommand(program);
registerCheckCommand(program);
registerFetchLogCommand(program);
registerOnboardCommand(program);
registerIgnoreCommand(program);
registerBlockCommand(program);
registerImportCommand(program);
registerEvaluateCommand(program);
registerSummarizeCommand(program);
registerEnrichCommand(program);
registerMediaCommand(program);
registerTaskCommand(program);

program
  .command("help")
  .argument("[command]", "Command to get help for")
  .description("Display help")
  .allowUnknownOption()
  .action((command?: string) => {
    if (command) {
      const sub = program.commands.find((c) => c.name() === command);
      if (sub) {
        sub.help();
      } else {
        console.error(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.dim(`\nRun ${chalk.white('"released --help"')} to see all available commands.`));
        process.exit(1);
      }
    } else {
      console.log(printStyledHelp());
      process.exit(0);
    }
  });

program
  .command("categories")
  .description("List valid category values")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    if (opts.json) {
      console.log(JSON.stringify(CATEGORIES, null, 2));
    } else {
      for (const cat of CATEGORIES) {
        console.log(cat);
      }
    }
  });

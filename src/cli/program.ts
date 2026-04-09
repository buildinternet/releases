import { Command, Help } from "commander";
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
import { registerPollCommand } from "./commands/poll.js";
import { registerKnowledgeCommand } from "./commands/knowledge.js";
import { CATEGORIES } from "../lib/categories.js";
import { isAdminMode } from "../lib/mode.js";

export const VERSION = "0.9.1";

type AdminEntry = {
  name: string;
  helpLabel: string;
  description: string;
  register: (program: Command) => void;
};

const ADMIN_COMMANDS: AdminEntry[] = [
  { name: "add", helpLabel: "add <url>", description: "Add a new changelog source", register: registerAddCommand },
  { name: "edit", helpLabel: "edit <slug>", description: "Edit source settings", register: registerEditCommand },
  { name: "remove", helpLabel: "remove <slug>", description: "Remove a source", register: registerRemoveCommand },
  { name: "import", helpLabel: "import <file>", description: "Bulk-import orgs and sources", register: registerImportCommand },
  { name: "discover", helpLabel: "discover <query>", description: "Discover changelogs for a company", register: registerDiscoverCommand },
  { name: "evaluate", helpLabel: "evaluate <slug>", description: "Evaluate a source", register: registerEvaluateCommand },
  { name: "fetch", helpLabel: "fetch [slug]", description: "Fetch releases from sources", register: registerFetchCommand },
  { name: "fetch-log", helpLabel: "fetch-log [slug]", description: "View recent fetch history", register: registerFetchLogCommand },
  { name: "check", helpLabel: "check <slug>", description: "Check a source URL for changes", register: registerCheckCommand },
  { name: "poll", helpLabel: "poll [slug]", description: "Poll feed sources for upstream changes", register: registerPollCommand },
  { name: "enrich", helpLabel: "enrich <slug>", description: "Enrich sparse releases with full content", register: registerEnrichCommand },
  { name: "summarize", helpLabel: "summarize <slug>", description: "AI-powered release summary", register: registerSummarizeCommand },
  { name: "org", helpLabel: "org <action>", description: "Manage organizations", register: registerOrgCommand },
  { name: "product", helpLabel: "product <action>", description: "Manage products within orgs", register: registerProductCommand },
  { name: "release", helpLabel: "release <action>", description: "Show, edit, delete, or suppress releases", register: registerReleaseCommand },
  { name: "block", helpLabel: "block <action>", description: "Manage globally blocked URLs", register: registerBlockCommand },
  { name: "ignore", helpLabel: "ignore <action>", description: "Manage org-scoped ignored URLs", register: registerIgnoreCommand },
  { name: "onboard", helpLabel: "onboard <company>", description: "AI-powered company onboarding", register: registerOnboardCommand },
  { name: "task", helpLabel: "task <action>", description: "Manage remote sessions", register: registerTaskCommand },
  { name: "media", helpLabel: "media <action>", description: "Media management (backfill)", register: registerMediaCommand },
  { name: "knowledge", helpLabel: "knowledge <action>", description: "Generate knowledge pages", register: registerKnowledgeCommand },
];

function adminKeyError(name: string): never {
  console.error(chalk.red(`"${name}" requires an API key.`) + " " + chalk.dim("Set RELEASED_API_KEY to enable it."));
  process.exit(1);
}

function row(name: string, desc: string, pad = 22): string {
  const gap = " ".repeat(Math.max(2, pad - name.length));
  return `  ${chalk.bold(name)}${gap}${chalk.dim(desc)}`;
}

function printStyledHelp(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${chalk.bold("releases")} ${chalk.dim(`v${VERSION}`)}`);
  lines.push(chalk.dim("Changelog indexer and registry for AI agents and developers"));
  lines.push("");

  if (isAdminMode()) {
    lines.push("To get started, onboard a company's changelogs:");
    lines.push("");
    lines.push(`  $ releases onboard <company>`);
  } else {
    lines.push("Search and browse changelogs from the registry:");
    lines.push("");
    lines.push(`  $ releases search <query>`);
  }
  lines.push("");
  lines.push("The most common commands are:");
  lines.push("");
  lines.push(`  - releases search     : ${chalk.dim("Full-text search across releases")}`);
  lines.push(`  - releases latest     : ${chalk.dim("Show the most recent releases")}`);
  lines.push(`  - releases list       : ${chalk.dim("List and inspect sources")}`);
  if (isAdminMode()) {
    lines.push(`  - releases fetch      : ${chalk.dim("Fetch new releases from sources")}`);
  }
  lines.push("");

  lines.push(chalk.cyan("Commands:"));
  lines.push(row("search <query>", "Full-text search across releases"));
  lines.push(row("latest [slug]", "Show latest releases"));
  lines.push(row("summary <slug>", "Summarize recent changes"));
  lines.push(row("compare <a> <b>", "Compare releases between sources"));
  lines.push(row("list [slug]", "List sources or inspect one"));
  lines.push(row("stats", "Show database statistics"));
  lines.push(row("usage", "Show API usage stats"));
  lines.push(row("categories", "List valid category values"));
  lines.push(row("serve", "Start MCP server on stdio"));
  lines.push(row("api", "Start local API server"));

  if (isAdminMode()) {
    lines.push("");
    lines.push(chalk.cyan("Admin:"));
    for (const cmd of ADMIN_COMMANDS) {
      lines.push(row(cmd.helpLabel, cmd.description));
    }
  }
  lines.push("");

  lines.push(chalk.cyan("Flags:"));
  lines.push(row("--json", "Machine-readable JSON output"));
  lines.push(row("--dry-run", "Preview without writing changes"));
  lines.push(row("-h, --help", "Display help for a command"));
  lines.push(row("-v, --version", "Print version number"));
  lines.push("");

  lines.push(chalk.dim(`Use ${chalk.white('"releases <command> --help"')} for more information about a command.`));

  return lines.join("\n");
}

export const program = new Command()
  .name("releases")
  .description("Changelog indexer and registry for AI agents and developers")
  .version(VERSION, "-v, --version")
  .configureHelp({
    formatHelp: (cmd, helper) => {
      // Root command gets styled help; subcommands get standard Commander help
      if (cmd.name() === "releases") return printStyledHelp() + "\n";
      return new Help().formatHelp(cmd, helper);
    },
  })
  .action(() => {
    console.log(printStyledHelp());
    process.exit(0);
  });

// Public commands — available to all users
registerSearchCommand(program);
registerLatestCommand(program);
registerSummaryCommand(program);
registerCompareCommand(program);
registerStatsCommand(program);
registerUsageCommand(program);
registerListCommand(program);
registerServeCommand(program);
registerApiCommand(program);

// Admin commands — require RELEASED_API_KEY
if (isAdminMode()) {
  for (const cmd of ADMIN_COMMANDS) cmd.register(program);
} else {
  for (const { name } of ADMIN_COMMANDS) {
    program
      .command(name, { hidden: true })
      .allowUnknownOption()
      .helpOption(false)
      .argument("[args...]")
      .description("")
      .action(() => adminKeyError(name));
  }
}

program
  .command("help")
  .argument("[command]", "Command to get help for")
  .description("Display help")
  .allowUnknownOption()
  .action((command?: string) => {
    if (command) {
      const sub = program.commands.find((c) => c.name() === command);
      const isHidden = sub && ADMIN_COMMANDS.some((a) => a.name === command) && !isAdminMode();
      if (isHidden) {
        adminKeyError(command);
      } else if (sub) {
        sub.help();
      } else {
        console.error(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.dim(`\nRun ${chalk.white('"releases --help"')} to see all available commands.`));
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

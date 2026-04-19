import { Command, Help } from "commander";
import chalk from "chalk";
import { registerAddCommand } from "./commands/add.js";
import { registerEditCommand } from "./commands/edit.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerListCommand } from "./commands/list.js";
import { registerFetchCommand } from "./commands/fetch.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerTailCommand } from "./commands/tail.js";
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
import { registerMediaCommand } from "./commands/media.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerPollCommand } from "./commands/poll.js";
import { registerRefreshChangelogCommand, registerChangelogCommand } from "./commands/refresh-changelog.js";
import { registerPlaybookCommand } from "./commands/playbook.js";
import { registerShowCommand } from "./commands/show.js";
import { registerEmbedCommand } from "./commands/admin/embed.js";
import { registerWebhookAdminCommand } from "./commands/admin/webhook.js";
import { registerWebhookCommand } from "./commands/webhook-verify.js";
import { registerTelemetryCommand } from "./commands/telemetry.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { isAdminMode } from "../lib/mode.js";
import { VERSION } from "./version.js";

export { VERSION };

const IS_DEV = !!process.argv[1]?.endsWith(".ts");
const VERSION_DISPLAY = IS_DEV ? `${VERSION}-dev` : VERSION;

function adminKeyError(name = "admin"): never {
  console.error(
    chalk.red(`"${name}" requires an API key.`) +
      " " +
      chalk.dim("Set RELEASED_API_KEY to enable it."),
  );
  process.exit(1);
}

function row(name: string, desc: string, pad = 22): string {
  const gap = " ".repeat(Math.max(2, pad - name.length));
  return `  ${chalk.bold(name)}${gap}${chalk.dim(desc)}`;
}

function gateAdminSubtree(root: Command): void {
  for (const sub of root.commands) {
    sub.hook("preAction", () => {
      if (!isAdminMode()) {
        adminKeyError("admin");
      }
    });
    gateAdminSubtree(sub);
  }
}

function isWithinAdminCommand(command: Command): boolean {
  let current: Command | null = command;
  while (current) {
    if (current.name() === "admin") return true;
    current = current.parent ?? null;
  }
  return false;
}

function printStyledHelp(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${chalk.bold("releases")} ${chalk.dim(`v${VERSION_DISPLAY}`)}`);
  lines.push(chalk.dim("Changelog indexer and registry for AI agents and developers"));
  lines.push("");

  lines.push("Search and browse changelogs from the registry:");
  lines.push("");
  lines.push(`  $ releases search <query>`);
  lines.push("");
  lines.push("The most common commands are:");
  lines.push("");
  lines.push(`  - releases search     : ${chalk.dim("Full-text search across releases")}`);
  lines.push(`  - releases tail       : ${chalk.dim("Show the most recent releases (add -f to follow)")}`);
  lines.push(`  - releases list       : ${chalk.dim("List and inspect sources")}`);
  lines.push(`  - releases summary    : ${chalk.dim("Summarize recent changes")}`);
  lines.push("");

  lines.push(chalk.cyan("Commands:"));
  lines.push(row("search <query>", "Full-text search across releases"));
  lines.push(row("latest [slug]", "Show latest releases"));
  lines.push(row("summary <slug>", "Summarize recent changes"));
  lines.push(row("compare <a> <b>", "Compare releases between sources"));
  lines.push(row("list [slug]", "List sources or inspect one"));
  lines.push(row("show <id|slug>", "Show any entity by ID or slug"));
  lines.push(row("stats", "Show database statistics"));
  lines.push(row("categories", "List valid category values"));
  lines.push(row("admin", "Operator workflows and local servers"));
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
  .version(VERSION_DISPLAY, "-v, --version")
  .hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== "admin" && isWithinAdminCommand(actionCommand) && !isAdminMode()) {
      adminKeyError("admin");
    }
  })
  .configureHelp({
    formatHelp: (cmd, helper) => {
      // Root command gets styled help; subcommands get standard Commander help.
      // The root is the only command with no parent — guarding on name alone
      // would wrongly format a subcommand literally named "releases" (e.g.
      // `admin embed releases`) with the root's top-level help screen.
      if (cmd.name() === "releases" && cmd.parent === null) return printStyledHelp() + "\n";
      return new Help().formatHelp(cmd, helper);
    },
  })
  .configureOutput({
    outputError: (str, write) => {
      write(str);
      // Append help hint to Commander error messages so users (and agents) know where to look
      const hint = chalk.dim('\nRun "releases --help" for available commands, or "releases <command> --help" for details.');
      write(hint + "\n");
    },
  })
  .showSuggestionAfterError(true)
  .action(() => {
    console.log(printStyledHelp());
    process.exit(0);
  });

// Public commands — available to all users
registerSearchCommand(program);
registerTailCommand(program);
registerWebhookCommand(program);
registerSummaryCommand(program);
registerCompareCommand(program);
registerStatsCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerTelemetryCommand(program);

const admin = program
  .command("admin")
  .description("Operator workflows for onboarding, curation, ingestion, and local servers")
  .showSuggestionAfterError(true)
  .hook("preAction", (_thisCommand, actionCommand) => {
    if (!isAdminMode() && actionCommand.name() !== "admin") {
      adminKeyError("admin");
    }
  })
  .action(() => {
    console.log(chalk.dim('Run "releases admin --help" to see operator commands.'));
  });

const sourceAdmin = admin
  .command("source")
  .description("Manage sources and source ingestion")
  .showSuggestionAfterError(true);
registerListCommand(sourceAdmin);
registerAddCommand(sourceAdmin);
registerEditCommand(sourceAdmin);
registerRemoveCommand(sourceAdmin);
registerImportCommand(sourceAdmin);
registerFetchCommand(sourceAdmin);
registerFetchLogCommand(sourceAdmin);
registerCheckCommand(sourceAdmin);
registerPollCommand(sourceAdmin);
registerRefreshChangelogCommand(sourceAdmin);
registerChangelogCommand(sourceAdmin);

registerOrgCommand(admin);
registerProductCommand(admin);
registerReleaseCommand(admin);
registerWebhookAdminCommand(admin);

const discoveryAdmin = admin
  .command("discovery")
  .description("Run onboarding, evaluation, and remote session workflows");
registerDiscoverCommand(discoveryAdmin);
registerEvaluateCommand(discoveryAdmin);
registerOnboardCommand(discoveryAdmin);
registerTaskCommand(discoveryAdmin);

const policyAdmin = admin
  .command("policy")
  .description("Manage ignored URLs, blocked URLs, and related curation policies");
registerIgnoreCommand(policyAdmin);
registerBlockCommand(policyAdmin);

const contentAdmin = admin
  .command("content")
  .description("Manage generated summaries, playbooks, and media backfills");
registerMediaCommand(contentAdmin);
registerPlaybookCommand(contentAdmin);
const contentSummaryAdmin = contentAdmin
  .command("summary")
  .description("Generate persisted summaries");
registerSummarizeCommand(contentSummaryAdmin, { commandName: "generate" });

const statsAdmin = admin
  .command("stats")
  .description("Inspect operator metrics and usage");
registerUsageCommand(statsAdmin);

registerEmbedCommand(admin);

const mcpAdmin = admin
  .command("mcp")
  .description("Run the local MCP server");
registerServeCommand(mcpAdmin, { commandName: "serve" });

const apiAdmin = admin
  .command("api")
  .description("Run the local JSON API server");
registerApiCommand(apiAdmin, { commandName: "serve" });

gateAdminSubtree(admin);

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

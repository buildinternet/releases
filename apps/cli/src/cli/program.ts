import { Command } from "commander";
import chalk from "chalk";
import { registerAddCommand } from "./commands/add.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerCreateAppStoreCommand } from "./commands/create-appstore.js";
import { registerCreateVideoCommand } from "./commands/create-video.js";
import { registerEditCommand } from "./commands/edit.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerDeleteCommand } from "./commands/delete.js";
import { registerListCommand } from "./commands/list.js";
import { registerShowSourceCommand } from "./commands/source-show.js";
import { registerFetchCommand } from "./commands/fetch.js";
import { registerBackfillCommand, registerBackfillStatusCommand } from "./commands/backfill.js";
import { registerReextractCommand } from "./commands/reextract.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerLookupCommand } from "./commands/lookup.js";
import { registerTailCommand } from "./commands/tail.js";
import { registerUsageCommand } from "./commands/usage.js";
import { registerOrgCommand } from "./commands/org.js";
import { registerProductCommand } from "./commands/product.js";
import {
  registerCollectionCommand,
  registerCollectionReadCommands,
} from "./commands/collection.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerFetchLogCommand } from "./commands/fetch-log.js";
import { registerStuckCommand } from "./commands/stuck.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerIgnoreCommand } from "./commands/ignore.js";
import { registerBlockCommand } from "./commands/block.js";
import { registerImportCommand } from "./commands/import.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerChangelogCommand } from "./commands/changelog.js";
import { registerProductChangelogCommand } from "./commands/product-changelog.js";
import { registerGetCommand } from "./commands/get.js";
import { registerShowCommand } from "./commands/show.js";
import { registerEmbedCommand } from "./commands/admin/embed.js";
import { registerEvaluateCommand } from "./commands/admin/evaluate.js";
import { registerPlaybookCommand } from "./commands/admin/playbook.js";
import { registerOverviewCommands } from "./commands/admin/overview.js";
import { registerWorkCommands } from "./commands/admin/work.js";
import { registerUserCommand } from "./commands/admin/user.js";
import { registerOauthCommand } from "./commands/admin/oauth.js";
import { registerTelemetryCommand } from "./commands/telemetry.js";
import { registerFeedbackCommand, registerFeedbackAdminCommand } from "./commands/feedback.js";
import { registerSubmitCommand, registerRecommendationAdminCommand } from "./commands/recommend.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerWebhookCommand } from "./commands/webhook.js";
import { registerWebhookAdminCommand } from "./commands/admin/webhook.js";
import { registerWorkspaceCommand } from "./commands/workspace.js";
import { registerAgentContextCommand } from "./commands/agent-context.js";
import { registerJsonCommand } from "./commands/json.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { completionNotice } from "./completion/hint.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { isAuthenticated } from "../lib/mode.js";
import { preflightScopeWarning } from "../lib/preflight.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerKeysCommand } from "./commands/keys.js";
import { registerPublishTokenCommand } from "./commands/publish-token.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerFollowsCommands } from "./commands/follows.js";
import { VERSION } from "./version.js";
import { writeJson } from "../lib/output.js";

export { VERSION };

const IS_DEV = !!process.argv[1]?.endsWith(".ts");
const VERSION_SHORT = IS_DEV ? `${VERSION}-dev` : VERSION;
// Include the runtime so agents in unfamiliar environments can tell this is a
// Bun binary (and thus that NODE_EXTRA_CA_CERTS / SSL_CERT_FILE etc. apply).
const VERSION_DISPLAY = `${VERSION_SHORT} (bun ${Bun.version}, ${process.platform}-${process.arch})`;

function adminKeyError(name = "admin"): never {
  console.error(
    chalk.red(`"${name}" requires an API key.`) +
      " " +
      chalk.dim("Run `releases auth login` or set RELEASES_API_KEY."),
  );
  process.exit(1);
}

function adminGate(): void {
  if (!isAuthenticated()) adminKeyError("admin");
  const warn = preflightScopeWarning();
  if (warn) console.error(chalk.yellow(`⚠ ${warn}`));
}

function row(name: string, desc: string, pad = 22): string {
  const gap = " ".repeat(Math.max(2, pad - name.length));
  return `  ${chalk.bold(name)}${gap}${chalk.dim(desc)}`;
}

function gateAdminSubtree(root: Command): void {
  for (const sub of root.commands) {
    sub.hook("preAction", () => {
      adminGate();
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

// Styled completion notice for help surfaces, or null when completions are set
// up or output isn't a TTY (so piped/scripted output stays clean). Persistent
// until completions are installed, then self-resolves.
function styledCompletionNotice(): string | null {
  if (!process.stdout.isTTY) return null;
  const notice = completionNotice();
  return notice ? chalk.dim(notice) : null;
}

// One-line account nudge for the curated landing screen, or null when a
// credential is already configured or output isn't a TTY (piped/scripted
// output stays clean — agents and CI never see it). Mirrors the completion
// notice: passive, dim, self-resolving once the user signs in.
function signedOutAccountNotice(): string | null {
  if (!process.stdout.isTTY) return null;
  if (isAuthenticated()) return null;
  return chalk.dim(
    `Create a free account for personalized feeds and higher rate limits — run ${chalk.white('"releases login"')}.`,
  );
}

function printStyledHelp(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(`${chalk.bold("releases")} ${chalk.dim(`v${VERSION_SHORT}`)}`);
  lines.push(chalk.dim("The changelog & release-notes registry for developers and AI agents"));
  lines.push(chalk.dim("Web catalog: ") + chalk.cyan("https://releases.sh"));
  lines.push("");

  lines.push("Search and browse changelogs from the registry:");
  lines.push("");
  lines.push(`  $ releases search <query>`);
  lines.push("");
  lines.push("The most common commands are:");
  lines.push("");
  lines.push(`  - releases search     : ${chalk.dim("Full-text search across releases")}`);
  lines.push(
    `  - releases tail       : ${chalk.dim("Show the most recent releases (add -f to follow)")}`,
  );
  lines.push(`  - releases list       : ${chalk.dim("List and inspect sources")}`);
  lines.push(`  - releases changelog  : ${chalk.dim("Recent product updates from releases.sh")}`);
  lines.push("");

  lines.push(chalk.cyan("Commands:"));
  lines.push(row("search <query>", "Full-text search across releases"));
  lines.push(row("tail [slug]", "Show the most recent releases (add -f to follow)"));
  lines.push(row("list [slug]", "List sources or inspect one"));
  lines.push(row("get <id|slug>", "Get any entity by ID or slug"));
  lines.push(row("changelog", "Recent product updates from releases.sh"));
  lines.push(row("stats", "Show database statistics"));
  lines.push(row("categories", "List valid category values"));
  lines.push(row("admin", "Operator workflows"));
  lines.push("");

  lines.push(chalk.cyan("Flags:"));
  lines.push(row("--json", "Machine-readable JSON output"));
  lines.push(row("--dry-run", "Preview without writing changes"));
  lines.push(row("-h, --help", "Display help for a command"));
  lines.push(row("-v, --version", "Print version number"));
  lines.push("");

  lines.push(
    chalk.dim(
      `Run ${chalk.white('"releases --help"')} to see all commands, or ${chalk.white('"releases <command> --help"')} for details on one.`,
    ),
  );

  const accountNotice = signedOutAccountNotice();
  if (accountNotice) {
    lines.push("");
    lines.push(accountNotice);
  }

  const notice = styledCompletionNotice();
  if (notice) {
    lines.push("");
    lines.push(notice);
  }

  return lines.join("\n");
}

export const program = new Command()
  .name("releases")
  .description("The changelog & release-notes registry for developers and AI agents")
  .version(VERSION_DISPLAY, "-v, --version")
  // `admin overview` declares a deprecated bare form (`overview <org>`) on the
  // parent command alongside subcommands like `overview inputs <org>`. Without
  // positional options, commander mis-routes options that follow a
  // subcommand's positional arg (e.g. `overview inputs google --json` swallows
  // `--json`). Enable positional parsing so each command's options are scoped
  // to its own position. (Issue releases-cli#133.)
  .enablePositionalOptions()
  .hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== "admin" && isWithinAdminCommand(actionCommand)) {
      adminGate();
    }
  })
  // Bare `releases` (no args) prints the curated quick-start via the default
  // action below. Any explicit help request (`--help`, `-h`, `releases help`)
  // falls through to Commander's default renderer, which lists every
  // registered command — so advanced commands (lookup, collection, auth,
  // completion, …) stay discoverable without cluttering the landing screen.
  .configureOutput({
    outputError: (str, write) => {
      write(str);
      const hint = chalk.dim(
        '\nRun "releases --help" for available commands, or "releases <command> --help" for details.',
      );
      write(hint + "\n");
    },
  })
  .showSuggestionAfterError(true)
  // allowExcessArguments lets us detect unknown tokens in the action below
  // rather than having Commander throw "too many arguments" before we can
  // surface a did-you-mean suggestion.
  .allowExcessArguments(true)
  .action((_opts, cmd) => {
    if (cmd.args.length > 0) {
      // Delegate to Commander's unknownCommand() so showSuggestionAfterError
      // can fire a did-you-mean hint for the unrecognised token.
      cmd.unknownCommand();
    }
    console.log(printStyledHelp());
    process.exit(0);
  });

// Surface the web catalog on the full `--help` listing too (the curated
// landing carries it in the header). Position "after" scopes it to the root
// command, so subcommand help stays clean.
program.addHelpText("after", () => {
  let out = `\n${chalk.dim("Web catalog: ")}${chalk.cyan("https://releases.sh")}`;
  const notice = styledCompletionNotice();
  if (notice) out += `\n${notice}`;
  return out;
});

// Public commands — available to all users
registerSearchCommand(program);
registerLookupCommand(program);
registerTailCommand(program);
registerProductChangelogCommand(program);
registerStatsCommand(program);
registerListCommand(program, { alias: "sources" });
// Canonical verb: get. Deprecated alias: show (emits a warning).
registerGetCommand(program);
registerShowCommand(program);
registerCollectionReadCommands(program);
registerTelemetryCommand(program);
registerFeedbackCommand(program);
registerSubmitCommand(program);
registerWhoamiCommand(program);
registerAuthCommand(program);
registerLoginCommand(program);
registerKeysCommand(program);
registerPublishTokenCommand(program);
registerPublishCommand(program);
registerFollowsCommands(program);
registerAgentContextCommand(program);
registerJsonCommand(program);
registerCompletionCommand(program);
registerSkillsCommand(program);
// `webhook {list,add,…}` — self-serve `/v1/me/webhooks` (auth required).
// `webhook verify` — local signature check, no auth. Admin CRUD under `admin webhook`.
registerWebhookCommand(program);
// `workspace list` — the caller's Better Auth workspaces (auth required).
registerWorkspaceCommand(program);

const admin = program
  .command("admin")
  .description("Operator workflows for onboarding, curation, and ingestion")
  .showSuggestionAfterError(true)
  .hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== "admin") {
      adminGate();
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
registerShowSourceCommand(sourceAdmin);
// Canonical verbs: create, update, delete. Deprecated aliases: add, edit, remove (each emits a warning).
registerCreateCommand(sourceAdmin);
registerCreateAppStoreCommand(sourceAdmin);
registerCreateVideoCommand(sourceAdmin);
registerAddCommand(sourceAdmin);
registerUpdateCommand(sourceAdmin);
registerEditCommand(sourceAdmin);
registerDeleteCommand(sourceAdmin);
registerRemoveCommand(sourceAdmin);
registerImportCommand(sourceAdmin);
registerFetchCommand(sourceAdmin);
registerBackfillCommand(sourceAdmin);
registerBackfillStatusCommand(sourceAdmin);
registerReextractCommand(sourceAdmin);
registerFetchLogCommand(sourceAdmin);
registerStuckCommand(sourceAdmin);
registerCheckCommand(sourceAdmin);
registerChangelogCommand(sourceAdmin);

registerOrgCommand(admin);
registerProductCommand(admin);
registerCollectionCommand(admin);
registerReleaseCommand(admin);
registerUserCommand(admin);
registerOauthCommand(admin);

const discoveryAdmin = admin
  .command("discovery")
  .description("Run onboarding and remote session workflows");
registerOnboardCommand(discoveryAdmin);
registerTaskCommand(discoveryAdmin);
registerEvaluateCommand(discoveryAdmin);

const policyAdmin = admin.command("policy").description("Manage ignored URLs and blocked URLs");
registerIgnoreCommand(policyAdmin);
registerBlockCommand(policyAdmin);

const statsAdmin = admin.command("stats").description("Inspect operator metrics and usage");
registerUsageCommand(statsAdmin);

registerEmbedCommand(admin);
registerPlaybookCommand(admin);
registerOverviewCommands(admin);
registerWorkCommands(admin);

const mcpAdmin = admin.command("mcp").description("MCP server management");
registerServeCommand(mcpAdmin);

registerWebhookAdminCommand(admin);
registerFeedbackAdminCommand(admin);
registerRecommendationAdminCommand(admin);

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
        console.log(
          chalk.dim(`\nRun ${chalk.white('"releases --help"')} to see all available commands.`),
        );
        process.exit(1);
      }
    } else {
      // `releases help` with no argument is an explicit help request, so mirror
      // `releases --help` (full command list) rather than the curated landing.
      program.outputHelp();
      process.exit(0);
    }
  });

program
  .command("categories")
  .description("List valid category values")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    if (opts.json) {
      await writeJson(CATEGORIES);
    } else {
      for (const cat of CATEGORIES) {
        console.log(cat);
      }
    }
  });

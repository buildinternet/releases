#!/usr/bin/env bun
import { program } from "./cli/program.js";
import { runMigrations } from "./db/migrate.js";
import { isRemoteMode, validateRemoteMode } from "./lib/mode.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { recordEvent, maybeShowFirstRunNotice } from "./lib/telemetry.js";
import { checkForUpdate } from "./lib/update-check.js";

const LEGACY_COMMAND_ALIASES: Record<string, string[]> = {
  add: ["admin", "source", "add"],
  edit: ["admin", "source", "edit"],
  remove: ["admin", "source", "remove"],
  import: ["admin", "source", "import"],
  check: ["admin", "source", "check"],
  fetch: ["admin", "source", "fetch"],
  "fetch-log": ["admin", "source", "fetch-log"],
  poll: ["admin", "source", "poll"],
  discover: ["admin", "discovery", "discover"],
  evaluate: ["admin", "discovery", "evaluate"],
  org: ["admin", "org"],
  product: ["admin", "product"],
  release: ["admin", "release"],
  onboard: ["admin", "discovery", "onboard"],
  task: ["admin", "discovery", "task"],
  ignore: ["admin", "policy", "ignore"],
  block: ["admin", "policy", "block"],
  media: ["admin", "content", "media"],
  guide: ["admin", "content", "guide"],
  summarize: ["admin", "content", "summary", "generate"],
  usage: ["admin", "stats", "usage"],
  serve: ["admin", "mcp", "serve"],
  api: ["admin", "api", "serve"],
};

function rewriteLegacyCommand(argv: string[]): string[] {
  const legacy = argv[2];
  if (!legacy) return argv;

  const replacement = LEGACY_COMMAND_ALIASES[legacy];
  if (!replacement) return argv;

  logger.warn(
    `The top-level "${legacy}" command is deprecated. Use "releases ${replacement.join(" ")}" instead.`,
  );
  return [...argv.slice(0, 2), ...replacement, ...argv.slice(3)];
}

function gateAdminArgv(argv: string[]): void {
  const args = argv.slice(2);
  if (args[0] !== "admin") return;
  if (process.env.RELEASED_API_KEY) return;

  const isHelpInvocation =
    args.length === 1 || args.includes("--help") || args.includes("-h") || args[1] === "help";

  if (!isHelpInvocation) {
    logger.error('"admin" requires an API key. Set RELEASED_API_KEY to enable it.');
    process.exit(1);
  }
}

const argv = rewriteLegacyCommand(process.argv);
gateAdminArgv(argv);

validateRemoteMode();

if (!isRemoteMode()) {
  runMigrations();
}

function telemetryCommandName(argv: string[]): string {
  const args = argv.slice(2).filter((a) => !a.startsWith("-"));
  const name = args.slice(0, 3).join(" ");
  return name || "(root)";
}

const telemetryStart = Date.now();
const telemetryCmd = telemetryCommandName(argv);
const skipTelemetry = argv[2] === "telemetry";

if (!skipTelemetry) maybeShowFirstRunNotice();

async function flushTelemetry(exitCode: number): Promise<void> {
  if (skipTelemetry) return;
  await recordEvent({
    surface: "cli",
    command: telemetryCmd,
    exitCode,
    durationMs: Date.now() - telemetryStart,
  });
}

// Start the update check early so it runs in parallel with command execution.
// Skip for --version / --help / telemetry subcommands to keep those instant.
const skipUpdateCheck =
  skipTelemetry ||
  argv.includes("--version") ||
  argv.includes("-v") ||
  argv.includes("--help") ||
  argv.includes("-h");
const updateCheckPromise = skipUpdateCheck ? null : checkForUpdate();

try {
  await program.parseAsync(argv);
  const [, updateMessage] = await Promise.all([
    flushTelemetry(typeof process.exitCode === "number" ? process.exitCode : 0),
    updateCheckPromise,
  ]);
  if (updateMessage) process.stderr.write(updateMessage + "\n");
} catch (err) {
  await flushTelemetry(1);
  throw err;
}

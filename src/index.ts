#!/usr/bin/env bun
import { program } from "./cli/program.js";
import { runMigrations } from "./db/migrate.js";
import { isRemoteMode, validateRemoteMode } from "./lib/mode.js";
import { logger } from "./lib/logger.js";

const LEGACY_COMMAND_ALIASES: Record<string, string[]> = {
  fetch: ["admin", "source", "fetch"],
  poll: ["admin", "source", "poll"],
  org: ["admin", "org"],
  product: ["admin", "product"],
  release: ["admin", "release"],
  onboard: ["admin", "discovery", "onboard"],
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
    args.length === 1 ||
    args.includes("--help") ||
    args.includes("-h") ||
    args[1] === "help";

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

program.parse(argv);

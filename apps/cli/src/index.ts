#!/usr/bin/env bun
import { program } from "./cli/program.js";
import { validateConfig, isAuthenticated } from "./lib/mode.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { recordEvent, maybeShowFirstRunNotice } from "./lib/telemetry.js";
import { checkForUpdate } from "./lib/update-check.js";
import { checkForSkillsUpdate } from "./lib/skills-update-check.js";
import { maybeShowCompletionHint } from "./cli/completion/hint.js";
import { AmbiguousSourceError } from "./api/sources.js";
import { formatAmbiguousSourceError } from "./cli/suggest.js";
import { ApiError, InvalidInputError, CliError, toErrorPayload } from "./lib/errors.js";
import { writeJson, handleStdoutPipeError } from "./lib/output.js";

// Exit cleanly when a downstream reader closes the pipe early (`… | head`),
// rather than hanging in a streaming writer. Registered before any output.
process.stdout.on("error", handleStdoutPipeError);

/** Whether the invocation requested machine-readable output. `--json` is a
 * boolean flag across every command, so a presence check on argv is reliable
 * and lets the top-level handler emit a structured error without threading the
 * parsed option down through every command. */
function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

const LEGACY_COMMAND_ALIASES: Record<string, string[]> = {
  add: ["admin", "source", "add"],
  edit: ["admin", "source", "edit"],
  remove: ["admin", "source", "remove"],
  import: ["admin", "source", "import"],
  check: ["admin", "source", "check"],
  fetch: ["admin", "source", "fetch"],
  "fetch-log": ["admin", "source", "fetch-log"],
  poll: ["admin", "source", "poll"],
  evaluate: ["admin", "discovery", "evaluate"],
  org: ["admin", "org"],
  product: ["admin", "product"],
  release: ["admin", "release"],
  onboard: ["admin", "discovery", "onboard"],
  task: ["admin", "discovery", "task"],
  ignore: ["admin", "policy", "ignore"],
  block: ["admin", "policy", "block"],
  usage: ["admin", "stats", "usage"],
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
  if (isAuthenticated()) return;

  const isHelpInvocation =
    args.length === 1 || args.includes("--help") || args.includes("-h") || args[1] === "help";

  if (!isHelpInvocation) {
    logger.error('"admin" requires an API key. Run `releases auth login` or set RELEASES_API_KEY.');
    process.exit(1);
  }
}

const argv = rewriteLegacyCommand(process.argv);
gateAdminArgv(argv);

validateConfig();

function telemetryCommandName(args: string[]): string {
  const positional = args.slice(2).filter((a) => !a.startsWith("-"));
  const name = positional.slice(0, 3).join(" ");
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

// Also check whether the installed agent skills are stale vs the repo. Same
// skip conditions as the CLI update check, plus skip during `skills` itself
// (the user is already managing skills there). TTY gating happens here so the
// pure function can be unit-tested without simulating a TTY.
const skipSkillsCheck = skipUpdateCheck || argv[2] === "skills" || !process.stderr.isTTY;
const skillsCheckPromise = skipSkillsCheck ? null : checkForSkillsUpdate();

try {
  await program.parseAsync(argv);
  const [, updateMessage, skillsMessage] = await Promise.all([
    flushTelemetry(typeof process.exitCode === "number" ? process.exitCode : 0),
    updateCheckPromise,
    skillsCheckPromise,
  ]);
  if (updateMessage) process.stderr.write(updateMessage + "\n");
  if (skillsMessage) process.stderr.write(skillsMessage + "\n");
  // Show completion hint after the command output, on successful runs only.
  // Skip when the user is already configuring completions or running help/version.
  const isCompletionRelated = argv[2] === "completion" || argv[2] === "telemetry";
  if (!isCompletionRelated && !skipUpdateCheck) maybeShowCompletionHint();
} catch (err) {
  await flushTelemetry(1);
  // A bare source slug that matches sources in more than one org (#264).
  // Print the candidate list + disambiguators cleanly instead of dumping a
  // stack trace. Centralized here so every command that resolves a source by
  // slug gets the guard, not just fetch/fetch-log/update.
  if (err instanceof AmbiguousSourceError) {
    process.stderr.write(formatAmbiguousSourceError(err) + "\n");
    process.exit(1);
  }
  // When the caller asked for JSON, a thrown error should still be a parseable
  // payload on stdout — not an unstructured stderr dump that forces the agent
  // to string-match. Exit non-zero so the failure is still detectable by code.
  if (wantsJson(argv)) {
    await writeJson(toErrorPayload(err));
    process.exit(1);
  }
  // Known, expected error types get a clean one-line stderr message (no stack
  // trace) for humans too. Unexpected errors still re-throw so genuine internal
  // bugs surface their stack.
  if (err instanceof ApiError || err instanceof InvalidInputError || err instanceof CliError) {
    logger.error(err.message);
    process.exit(1);
  }
  throw err;
}

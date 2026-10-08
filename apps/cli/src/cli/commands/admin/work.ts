/**
 * `admin work` — manage the active maintenance run (#227).
 *
 * `RELEASES_RUN_DIR` auto-captures admin mutations into `mutations.jsonl` and
 * defaults the managed-session trace dir, but a one-time `export` does not
 * survive an agent harness (each Bash tool call is a fresh shell). `work start`
 * writes a sticky `.current-run` pointer so logging and the trace-dir default
 * work across separate CLI invocations with no env threading. Explicit
 * `RELEASES_RUN_DIR` still wins. See `src/lib/run-dir.ts`.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../../lib/output.js";
import { startRun, endRun, runStatus } from "../../../lib/run-dir.js";

interface WorkJsonOpts {
  json?: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function workStartAction(batch: string, opts: WorkJsonOpts): Promise<void> {
  const runDir = startRun(batch);
  if (opts.json) {
    await writeJson({ runDir, source: "pointer" });
    return;
  }
  console.log(chalk.green(`Started run: ${runDir}`));
  console.log(chalk.dim("  Mutations and session traces are auto-captured here until `work end`."));
}

async function workStatusAction(opts: WorkJsonOpts): Promise<void> {
  const status = runStatus();
  if (opts.json) {
    await writeJson(status ? { active: true, ...status } : { active: false });
    return;
  }
  if (!status) {
    console.log(chalk.yellow("No active run."));
    console.log(chalk.dim("  Start one with `releases admin work start <batch>`."));
    return;
  }
  console.log(chalk.bold(`Active run: ${status.runDir}`) + chalk.dim(`  (${status.source})`));
  if (!status.exists) {
    console.log(chalk.yellow("  run dir missing on disk (stale pointer — `work end` to clear)"));
    return;
  }
  console.log(
    chalk.dim(
      `  ${plural(status.mutations, "mutation logged", "mutations logged")} · ${plural(
        status.sessions,
        "session traced",
        "sessions traced",
      )}`,
    ),
  );
}

async function workEndAction(opts: WorkJsonOpts): Promise<void> {
  const ended = endRun();
  if (opts.json) {
    await writeJson({ ended });
    return;
  }
  if (ended) {
    logger.info("Ended run — sticky pointer cleared.");
  } else {
    console.log(chalk.yellow("No active run to end."));
  }
}

export function registerWorkCommands(admin: Command): void {
  const work = admin
    .command("work")
    .description("Manage the active maintenance run (mutation log + trace dir)");

  work
    .command("start")
    .description("Start a run: create its dir and point .current-run at it")
    .argument("<batch>", "Short label for the run (slugified into the dir name)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin work start overview-sweep
  releases admin work start "Q2 audit" --json

Creates ~/.releases/work/runs/<ts>-<batch>/ (honoring RELEASES_DATA_DIR) and
writes a sticky pointer at ~/.releases/work/.current-run. Subsequent admin
mutations and session traces are auto-captured into the run with no
RELEASES_RUN_DIR threading. Explicit RELEASES_RUN_DIR still wins when set.`,
    )
    .action(workStartAction);

  work
    .command("status")
    .description("Show the active run dir and a one-line tally")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Resolves the active run as: RELEASES_RUN_DIR env → .current-run pointer → none.
Reports the run dir, where it came from, and how many mutations were logged and
sessions traced.`,
    )
    .action(workStatusAction);

  work
    .command("end")
    .description("Clear the sticky .current-run pointer")
    .option("--json", "Output as JSON")
    .action(workEndAction);
}

import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  findSource,
  backfillSource,
  getBackfillStatus,
  isBackfillAsync,
  type SourceBackfillReport,
  type BackfillAsyncResponse,
} from "../../api/sources.js";
import { sourceNotFound } from "../suggest.js";
import { writeJson } from "../../lib/output.js";
import { readContentArg } from "../../lib/input.js";
import { parsePositiveIntFlag } from "../../lib/flags.js";
import { sleep } from "../../lib/sleep.js";
import { renderBackfillReport } from "./backfill-report.js";

type BackfillOpts = {
  maxWindows?: string;
  dryRun?: boolean; // commander: defaults to true; `--no-dry-run` sets false
  commit?: boolean; // alias for --no-dry-run
  markdownFile?: string;
  wait?: boolean; // opt-in inline polling; default dispatches and returns the handle
  json?: boolean;
};

// Deep Firecrawl backfills run as a durable workflow (minutes). When `--wait`
// polls inline, hit the status endpoint at this cadence until terminal.
const POLL_INTERVAL_MS = 5_000;
const TERMINAL_STATUSES = new Set(["complete", "errored", "terminated"]);

export async function backfillAction(identifier: string, opts: BackfillOpts): Promise<void> {
  // Either opt-in writes: `--no-dry-run` (commander sets dryRun:false) or `--commit`.
  const write = opts.dryRun === false || !!opts.commit;
  const dryRun = !write;
  const wait = !!opts.wait; // dispatch + return the handle by default; `--wait` polls inline
  const maxWindows = parsePositiveIntFlag("max-windows", opts.maxWindows);
  const markdown = opts.markdownFile ? await readContentArg(opts.markdownFile) : undefined;

  // Resolve to the typed src_… ID before calling — the endpoint rejects bare
  // slugs (ambiguous across orgs, #690). findSource() does the org-scoped
  // resolution the other `admin source` verbs use.
  const src = await findSource(identifier);
  if (!src) return sourceNotFound(identifier);

  let res: SourceBackfillReport | BackfillAsyncResponse;
  try {
    res = await backfillSource({ sourceId: src.id, markdown, maxWindows, dryRun });
  } catch (err) {
    // apiFetch embeds the endpoint's actionable message (bare_slug_rejected,
    // non-scrape source, Firecrawl 502, ANTHROPIC/FIRECRAWL key 503, …).
    logger.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // ── Async path: deep Firecrawl backfill dispatched to a durable workflow ────
  // Dispatch and return the handle by default; `--wait` polls inline.
  // Non-blocking-by-default is the right primitive for agents — pair the
  // printed instanceId with `backfill-status` to poll on your own cadence, or
  // pass `--wait` for a blocking report.
  if (isBackfillAsync(res)) {
    if (!wait) {
      if (opts.json) return writeJson(res);
      logger.info(chalk.bold(`Dispatched backfill workflow: ${res.instanceId}`));
      logger.info(chalk.dim(`  status: ${res.statusUrl}`));
      logger.info(
        chalk.dim(
          `  Poll: releases admin source backfill-status ${res.instanceId}  (or re-run with --wait)`,
        ),
      );
      return;
    }

    if (!opts.json) {
      logger.info(chalk.bold(`Dispatched backfill workflow: ${res.instanceId}`));
      logger.info(chalk.dim(`  Polling every ${POLL_INTERVAL_MS / 1000}s until terminal...`));
    }

    let status: Awaited<ReturnType<typeof getBackfillStatus>> = null;
    try {
      // Polling loop — each tick depends on the previous sleep + status fetch.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- intentional poll cadence
        status = await getBackfillStatus(res.instanceId);
        // null = transient 404 during the create→status race; keep polling.
        if (!opts.json) logger.info(chalk.dim(`  status: ${status?.status ?? "dispatching…"}`));
        if (status && TERMINAL_STATUSES.has(status.status)) break;
        // oxlint-disable-next-line no-await-in-loop -- intentional poll interval
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      logger.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }

    if (!status || status.status !== "complete" || !status.output) {
      if (opts.json) await writeJson(status);
      else {
        logger.error(
          chalk.red(`Workflow ended in non-success state: ${status?.status ?? "unknown"}`),
        );
        if (status?.error) logger.error(chalk.red(String(status.error)));
      }
      process.exit(1);
    }

    if (opts.json) return writeJson(status.output);
    renderBackfillReport(status.output);
    return;
  }

  // ── Synchronous path: supplied markdown / plain fetch ───────────────────────
  if (opts.json) return writeJson(res);
  renderBackfillReport(res);
}

/**
 * Single-shot read of a dispatched backfill workflow's state, for resuming after
 * a `backfill` (no `--wait`) dispatch. Renders the report when complete; an agent
 * loops this on its own cadence off the `--json` `status` field. Exits non-zero
 * only on a terminal failure (`errored`/`terminated`) — `running`/`queued` exit 0.
 */
export async function backfillStatusAction(
  instanceId: string,
  opts: { json?: boolean },
): Promise<void> {
  let status;
  try {
    status = await getBackfillStatus(instanceId);
  } catch (err) {
    logger.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // 404 → either the brief create→status race or a wrong/expired ID. Surface it
  // as a non-terminal "pending" (exit 0) so a polling agent re-checks instead of
  // treating it as a hard failure.
  if (status === null) {
    if (opts.json) await writeJson({ instanceId, status: "not_found" });
    else
      logger.info(
        chalk.dim(`status: not found yet for ${instanceId} (still initializing, or wrong ID)`),
      );
    return;
  }

  if (opts.json) {
    await writeJson(status);
  } else if (status.status === "complete" && status.output) {
    renderBackfillReport(status.output);
  } else if (status.status === "errored" || status.status === "terminated") {
    logger.error(chalk.red(`Workflow ${status.status}`));
    if (status.error) logger.error(chalk.red(String(status.error)));
  } else {
    logger.info(chalk.dim(`status: ${status.status} (not finished yet)`));
  }

  if (status.status === "errored" || status.status === "terminated") process.exit(1);
}

export function registerBackfillCommand(program: Command) {
  program
    .command("backfill")
    .description(
      "Full-history backfill for a windowed scrape source (loops extraction over every window)",
    )
    .argument("<identifier>", "Source ID (src_…) or slug")
    .option(
      "--max-windows <n>",
      "Max scrape windows to walk back (endpoint clamps 1–200, default 50)",
    )
    .option("--no-dry-run", "Actually write (default is a dry-run preview)")
    .option("--commit", "Alias for --no-dry-run")
    .option(
      "--markdown-file <path>",
      "Read full-page markdown from a file (use - for stdin) and send it as the body — " +
        "for JS-heavy / bot-blocked sources the worker can't fetch itself. " +
        "Without it the endpoint falls back to Firecrawl (if enabled) then a plain fetch.",
    )
    .option(
      "--wait",
      "For deep Firecrawl backfills (dispatched async): poll to completion and render the report, " +
        "instead of printing the workflow instance ID and exiting",
    )
    .option("--json", "Output the raw backfill report as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source backfill my-source                     Dry-run preview (counts + date range)
  releases admin source backfill my-source --no-dry-run        Write the backfill
  releases admin source backfill my-source --max-windows 100   Walk further back
  releases admin source backfill my-source --wait              Block until a deep (async) backfill finishes
  releases admin source backfill my-source --markdown-file page.md --commit
  cat page.md | releases admin source backfill my-source --markdown-file - --commit

Deep Firecrawl backfills run as a durable workflow and are dispatched async: by
default this prints the instance ID and exits. Poll it with:
  releases admin source backfill-status <instanceId> [--json]`,
    )
    .action(backfillAction);
}

export function registerBackfillStatusCommand(program: Command) {
  program
    .command("backfill-status")
    .description(
      "Check a dispatched backfill workflow's status (resume a `backfill` without --wait)",
    )
    .argument("<instanceId>", "Workflow instance ID printed by `backfill`")
    .option(
      "--json",
      "Output the raw workflow status (incl. the report under `output` when complete)",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases admin source backfill-status backfill-src_abc-1717200000000
  releases admin source backfill-status backfill-src_abc-1717200000000 --json`,
    )
    .action(backfillStatusAction);
}

import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { apiFetch } from "../../api/core.js";
import { findOrg, getSourcesByOrg } from "../../api/orgs.js";
import {
  getActiveSources,
  getSession,
  listFetchableSources,
  listSourcesWithChanges,
  findSource,
  triggerSourceFetch,
} from "../../api/sources.js";
import { newCorrelationId } from "@buildinternet/releases-core/id";
import { orgNotFound, sourceNotFound } from "../suggest.js";
import { writeJson, writeJsonLine } from "../../lib/output.js";
import { trySaveSessionTrace } from "../../lib/trace.js";
import { sleep } from "../../lib/sleep.js";
import {
  classifySessionTerminalState,
  DEFAULT_WAIT_SECONDS,
  NOT_FOUND_GRACE_MS,
  POLL_INTERVAL_MS,
} from "./fetch-wait.js";
import { runLocalHandoff } from "./fetch-local.js";
import type { Session } from "@buildinternet/releases-api-types";

export function registerFetchCommand(program: Command) {
  program
    .command("fetch")
    .description(
      "Fetch releases from configured sources (delegated to a remote managed-agent session)",
    )
    .argument("[identifier]", "Source ID (src_…), org/slug coordinate, or slug to fetch")
    .option("--source <identifier>", "Source ID (src_…), org/slug coordinate, or slug")
    .option("--json", "Output as JSON")
    .option(
      "--local",
      "Stage local onboarding for the `local-ingest` skill instead of dispatching the remote managed agent: " +
        "runs the robots.txt/Content-Signal preflight, resolves the source, discovers candidate page URLs, " +
        "and prints a handoff brief. No model call, no extraction billing. Single source only.",
    )
    .option(
      "--force",
      "With --local, override a Content-Signal refusal (ai-input=no / ai-train=no). " +
        "Use only with explicit publisher permission.",
    )
    .option(
      "--dry-run",
      "Probe a single source without writing to D1 or billing the managed agent: " +
        "feed/GitHub sources report candidate releases parsed; a client-rendered scrape source " +
        "(crawlEnabled/renderRequired) renders its index once and reports candidate links found. " +
        "Single source only.",
    )
    .option("--unfetched", "Only fetch sources that have never been fetched")
    .option("--stale <hours>", "Only fetch sources older than N hours")
    .option("--changed", "Only fetch sources where poll detected upstream changes")
    .option("--retry-errors", "Only fetch sources whose last fetch was an error")
    .option(
      "--org <org>",
      "Fetch all active sources for an organization (org_…, slug, domain, name, or handle); skips push-only agent sources and can't be combined with a source identifier",
    )
    .option(
      "--wait [seconds]",
      `Block until the session reaches a terminal state (default: ${DEFAULT_WAIT_SECONDS}s). ` +
        `Exits non-zero on failure: 2 for managed-agents/provider errors, 1 for our-side errors, 130 for cancellation.`,
    )
    .option(
      "--trace-dir <dir>",
      "With --wait, write the terminal session as <dir>/<sessionId>/{trace.json,summary.md} (default: ~/.releases/work/runs)",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases admin source fetch src_abc123            Fetch a single source by ID
  releases admin source fetch my-source             Fetch a single source by slug
  releases admin source fetch --stale 6             Fetch sources not updated in 6+ hours
  releases admin source fetch --unfetched           Fetch sources never fetched before
  releases admin source fetch --changed             Fetch sources where poll detected changes
  releases admin source fetch --retry-errors        Retry sources that errored last time
  releases admin source fetch --org acme            Fetch all active sources for an org
  releases admin source fetch --org acme --wait     Wait for completion; exit non-zero on failure
  releases admin source fetch --org acme --wait 60  Wait up to 60 seconds
  releases admin source fetch my-source --local     Stage local-ingest handoff (no managed agent)
  releases admin source fetch my-source --local --force   Override a Content-Signal refusal
  releases admin source fetch my-source --dry-run    Probe a source (render check / parse) without writing or billing`,
    )
    .action(
      async (
        slugArg: string | undefined,
        opts: {
          source?: string;
          json?: boolean;
          local?: boolean;
          force?: boolean;
          dryRun?: boolean;
          unfetched?: boolean;
          stale?: string;
          changed?: boolean;
          retryErrors?: boolean;
          org?: string;
          wait?: string | true;
          traceDir?: string;
        },
      ) => {
        const identifier = slugArg ?? opts.source;

        // The positional argument and --source are two spellings of the same
        // thing — refuse both rather than silently preferring the positional.
        if (slugArg && opts.source) {
          logger.error("Pass one source — either the [identifier] argument or --source, not both.");
          process.exit(1);
        }

        // --local short-circuits the remote managed-agent path entirely: it stages
        // the local-ingest handoff (preflight + URL discovery + brief) and never
        // POSTs to /v1/workflows/update. Single-source only — the batch filters
        // and --org fan-out don't apply to a one-source handoff brief.
        if (opts.local) {
          requireSingleSourceFlag("--local", "stages a single-source handoff", identifier, opts);
          return runLocalHandoff(identifier!, { json: opts.json, force: opts.force });
        }

        // --dry-run short-circuits to the per-source probe route — no managed
        // agent, no D1 writes. Single source only; the batch filters and --org
        // fan-out don't apply to a one-source probe.
        if (opts.dryRun) {
          requireSingleSourceFlag("--dry-run", "probes a single source", identifier, opts);
          return runDryRunProbe(identifier!, { json: opts.json });
        }

        if (opts.force) {
          logger.warn("--force only applies with --local; ignoring it for the remote fetch path.");
        }

        // A single source identifier and --org are mutually exclusive — the
        // org fan-out used to win silently, dropping the identifier and
        // dispatching a managed-agent session over every active source in the
        // org (#307). Mirrors `latest`'s --product/--org rejection.
        if (identifier && opts.org) {
          logger.error(
            "A source identifier can't be combined with --org. Pass one source (src_…, org/slug, or --source), or use --org alone to fetch the whole org.",
          );
          process.exit(1);
        }

        // Resolve --wait up front so a malformed value fails before we kick off a remote workflow.
        let waitSeconds: number | null = null;
        if (opts.wait !== undefined) {
          waitSeconds = opts.wait === true ? DEFAULT_WAIT_SECONDS : parseWaitSeconds(opts.wait);
          if (waitSeconds === null) {
            logger.error(`--wait must be a positive integer (seconds), got "${opts.wait}"`);
            process.exit(1);
          }
        }

        let entries: Array<{ id: string; slug: string }> = [];
        let label = "manual fetch";
        let orgId: string | undefined;

        if (opts.org) {
          const org = await findOrg(opts.org);
          if (!org) return orgNotFound(opts.org);
          orgId = org.id;
          const { fetchable, skippedAgents } = selectOrgFetchSources(await getSourcesByOrg(org.id));
          if (skippedAgents > 0)
            logger.info(`Skipping ${skippedAgents} push-only agent source(s) (no fetch adapter)`);
          if (fetchable.length === 0) {
            if (opts.json) await writeJsonLine({ sessionId: null, message: "No active sources" });
            else logger.info(`No active sources for ${org.name}.`);
            return;
          }
          entries = fetchable.map((s) => ({ id: s.id, slug: s.slug }));
          label = `all sources for ${org.slug} (${entries.length})`;
        } else if (identifier) {
          const src = await findSource(identifier);
          if (!src) return sourceNotFound(identifier);
          entries = [{ id: src.id, slug: src.slug }];
          if (src.orgId) orgId = src.orgId;
          label = src.slug;
        } else if (opts.unfetched) {
          const sources = await listFetchableSources({ mode: "unfetched" });
          entries = sources.map((s) => ({ id: s.id, slug: s.slug }));
          label = `${entries.length} unfetched sources`;
        } else if (opts.stale) {
          const hours = parseInt(opts.stale, 10);
          const sources = await listFetchableSources({ mode: "stale", staleHours: hours });
          entries = sources.map((s) => ({ id: s.id, slug: s.slug }));
          label = `${entries.length} stale sources (>${hours}h)`;
        } else if (opts.changed) {
          const allChanged = await listSourcesWithChanges();
          const sources = allChanged.filter((s) => s.type === "scrape" || s.type === "agent");
          const skipped = allChanged.length - sources.length;
          if (skipped > 0)
            logger.info(`Skipping ${skipped} feed/github source(s) (handled by cron)`);
          entries = sources.map((s) => ({ id: s.id, slug: s.slug }));
          label = `${entries.length} changed scrape/agent sources`;
        } else if (opts.retryErrors) {
          const sources = await listFetchableSources({ mode: "retry_errors" });
          entries = sources.map((s) => ({ id: s.id, slug: s.slug }));
          label = `${entries.length} errored sources`;
        } else {
          logger.error(
            "fetch requires a source identifier (src_…, org/slug coordinate, or slug) or filter (--stale, --unfetched, --changed, --retry-errors, --org)",
          );
          process.exit(1);
        }

        if (entries.length === 0) {
          if (opts.json) await writeJsonLine({ sessionId: null, message: "No matching sources" });
          else logger.info("No matching sources to fetch.");
          return;
        }

        if (entries.length > 20) {
          logger.warn(
            `Capping at 20 sources (${entries.length} matched). Use multiple sessions for larger batches.`,
          );
          entries = entries.slice(0, 20);
        }

        try {
          const { slugs: activeSlugs, sessionMap } = await getActiveSources();
          const overlapping = entries.filter((e) => activeSlugs.includes(e.slug));
          if (overlapping.length > 0) {
            const overlapSessionId = sessionMap[overlapping[0].slug];
            const sourceList =
              overlapping.length <= 3
                ? overlapping.map((e) => e.slug).join(", ")
                : `${overlapping.length} sources`;
            console.error(
              chalk.red(
                `Source ${sourceList} already being fetched in session ${overlapSessionId.slice(0, 8)}.`,
              ),
            );
            process.exit(1);
          }
        } catch {
          if (!opts.json)
            logger.warn("Could not check for overlapping sessions — proceeding anyway.");
        }

        const sourceIdentifiers = entries.map((e) => e.id);

        let result: { sessionId: string };
        try {
          result = await apiFetch<{ sessionId: string }>("/v1/workflows/update", {
            method: "POST",
            body: JSON.stringify({
              company: label,
              sourceIdentifiers,
              orgId,
              correlationId: newCorrelationId(),
            }),
          });
        } catch (err) {
          logger.error(
            `Failed to start update session: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
        const waiting = opts.wait !== undefined;
        if (opts.json && !waiting) {
          // When waiting, the final JSON is emitted by waitForSession so we
          // don't write two top-level documents to stdout.
          await writeJson(result);
        } else if (!opts.json) {
          logger.info(`Update session started: ${result.sessionId}`);
          logger.info(`Fetching ${sourceIdentifiers.length} source(s).`);
          if (!waiting) {
            logger.info(`Track progress: releases admin discovery task list`);
          }
        }

        if (waiting && waitSeconds !== null) {
          await waitForSession({
            sessionId: result.sessionId,
            waitSeconds,
            json: opts.json === true,
            traceDir: opts.traceDir,
          });
        }
      },
    );
}

/**
 * Validate a single-source flag (`--local` / `--dry-run`): require a source
 * identifier and reject the batch filters / `--org` / `--wait` that don't apply
 * to a one-source operation. Exits the process on violation. Keeps the
 * mutually-exclusive flag list defined in exactly one place.
 */
function requireSingleSourceFlag(
  flag: string,
  verb: string,
  identifier: string | undefined,
  opts: {
    org?: string;
    unfetched?: boolean;
    stale?: string;
    changed?: boolean;
    retryErrors?: boolean;
    wait?: string | true;
  },
): void {
  if (!identifier) {
    logger.error(`${flag} needs a single source identifier (src_…, org/slug coordinate, or slug).`);
    process.exit(1);
  }
  const conflicting = (
    [
      ["--org", opts.org],
      ["--unfetched", opts.unfetched],
      ["--stale", opts.stale],
      ["--changed", opts.changed],
      ["--retry-errors", opts.retryErrors],
      ["--wait", opts.wait !== undefined],
    ] as const
  )
    .filter(([, v]) => v)
    .map(([name]) => name);
  if (conflicting.length > 0) {
    logger.error(`${flag} ${verb} and can't combine with ${conflicting.join(", ")}.`);
    process.exit(1);
  }
}

/**
 * Single-source dry-run probe: resolves the source, calls
 * `POST /v1/sources/:id/fetch?dryRun=true`, and prints the result. For a
 * client-rendered scrape source this is a render check (renders the index once,
 * reports candidate links found); for a feed/GitHub source it reports candidate
 * releases parsed. Never writes to D1, never dispatches a managed agent.
 */
async function runDryRunProbe(identifier: string, opts: { json?: boolean }): Promise<void> {
  const src = await findSource(identifier);
  if (!src) return sourceNotFound(identifier);

  let result;
  try {
    result = await triggerSourceFetch(src.id, { dryRun: true });
  } catch (err) {
    logger.error(`Dry-run probe failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (opts.json) {
    await writeJson({ source: src.slug, ...result });
    return;
  }

  if (result.renderCheck) {
    // Client-rendered scrape source render probe.
    if (result.status === "error") {
      logger.error(
        chalk.red(`Render check failed for ${src.slug}: ${result.error ?? "unknown error"}`),
      );
      process.exit(1);
    }
    if (!result.rendered) {
      logger.error(
        chalk.red(
          `${src.slug}: render returned an empty page — the index did not hydrate (0 candidate links). ` +
            `The steady-state cron render likely can't see releases here.`,
        ),
      );
      process.exit(1);
    }
    const n = result.candidateCount ?? 0;
    const colour = n > 0 ? chalk.green : chalk.yellow;
    logger.info(colour(`${src.slug}: render OK — ${n} candidate link(s) found on the index.`));
    for (const u of result.sampleUrls ?? []) process.stderr.write(chalk.dim(`  ${u}\n`));
    return;
  }

  // Feed/GitHub/scrape-with-feed dry-run.
  const found = result.releasesFound ?? 0;
  logger.info(chalk.green(`${src.slug}: parsed ${found} candidate release(s) (no writes).`));
}

/**
 * Select the org sources the `--org` fan-out should fetch: visible, unpaused,
 * and not push-only. `agent` sources have no fetch adapter — releases are
 * POSTed to them, never pulled — so dispatching a managed-agent session over
 * one is a wasted no-op (#307). Hidden/paused sources were always excluded and
 * don't count toward `skippedAgents`.
 */
export function selectOrgFetchSources<
  T extends { isHidden?: boolean | null; fetchPriority?: string | null; type: string },
>(sources: T[]): { fetchable: T[]; skippedAgents: number } {
  const active = sources.filter((s) => !s.isHidden && s.fetchPriority !== "paused");
  const fetchable = active.filter((s) => s.type !== "agent");
  return { fetchable, skippedAgents: active.length - fetchable.length };
}

/** Strict integer parse — `parseInt("60abc")` returns 60, which would silently misuse `--wait 60s`. */
export function parseWaitSeconds(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function waitForSession({
  sessionId,
  waitSeconds,
  json,
  traceDir,
}: {
  sessionId: string;
  waitSeconds: number;
  json: boolean;
  traceDir?: string;
}): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + waitSeconds * 1000;
  if (!json) logger.info(`Waiting up to ${waitSeconds}s for session to complete…`);

  while (Date.now() < deadline) {
    let session: Session | null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential polling: each tick depends on the previous response
      session = await getSession(sessionId);
    } catch (err) {
      // apiFetch returns null on GET 404 — anything thrown here is a real
      // transport/auth/5xx problem. Surface it instead of swallowing.
      logger.error(
        `Failed to poll session ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    if (!session) {
      // 404 right after start is normal — the StatusHub event may not have landed yet.
      if (Date.now() - startedAt > NOT_FOUND_GRACE_MS) {
        logger.error(`Session ${sessionId} not found after grace window — giving up`);
        process.exit(1);
      }
      // oxlint-disable-next-line no-await-in-loop -- intentional poll interval
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const summary = classifySessionTerminalState(session);
    if (summary) {
      const tracePath = trySaveSessionTrace(session, traceDir);
      if (json) {
        // oxlint-disable-next-line no-await-in-loop -- terminal write before exiting; not actually a loop iteration
        await writeJson({ ...session, exitCode: summary.exitCode });
      } else {
        if (summary.exitCode === 0) logger.info(chalk.green(summary.message));
        else logger.error(chalk.red(summary.message));
        if (tracePath) process.stderr.write(chalk.dim(`  Trace: ${tracePath}\n`));
      }
      process.exit(summary.exitCode);
    }

    // oxlint-disable-next-line no-await-in-loop -- intentional poll interval
    await sleep(POLL_INTERVAL_MS);
  }

  // Hit the wait deadline — session is still running.
  if (json) {
    await writeJson({ sessionId, status: "timeout", waitSeconds });
  } else {
    logger.error(
      chalk.red(
        `Session ${sessionId.slice(0, 8)} did not reach a terminal state within ${waitSeconds}s`,
      ),
    );
  }
  process.exit(1);
}

import { Command } from "commander";
import chalk from "chalk";
import { listSessions, getSession, cancelSession } from "../../api/sources.js";
import { writeJson } from "../../lib/output.js";
import { writeSessionTrace } from "../../lib/trace.js";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  DEFAULT_PAGE_SIZE,
  formatTruncationWarning,
} from "@buildinternet/releases-core/cli-contracts";
import type { Session } from "@buildinternet/releases-api-types";

const fmtTimestamp = (n: number) => new Date(n).toISOString();

function statusChalk(status: string) {
  if (status === "running") return chalk.yellow;
  if (status === "complete") return chalk.green;
  if (status === "cancelled") return chalk.gray;
  return chalk.red;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/**
 * Resolve a session ID from a unique prefix by listing sessions and filtering
 * client-side. Walks pages lazily — first page handles the common case
 * without extra round-trips; older sessions trigger a paginated walk only
 * when the first page yields no match. Exits the process on no-match or
 * ambiguous match. The server has no `?prefix=` query, so the client
 * filter is the only option.
 */
async function resolveSessionIdFromPrefix(prefix: string): Promise<string> {
  if (prefix.length >= 36) return prefix;

  const matches: { sessionId: string; company: string; status: string }[] = [];
  let page = 1;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- pagination cursor depends on prior page; can't run in parallel
    const { items, pagination } = await listSessions({ page });
    for (const s of items) {
      if (s.sessionId.startsWith(prefix)) matches.push(s);
    }
    // Two matches is already ambiguous; stop walking instead of paging on.
    if (matches.length >= 2) break;
    // Walk until pages exhausted (or 50-page safety cap, ~25k sessions) so
    // an older row with the same prefix on a later page surfaces as ambiguous.
    if (!pagination?.hasMore || page >= 50) break;
    page += 1;
  }

  if (matches.length === 0) {
    console.error(chalk.red(`No session found matching "${prefix}".`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(chalk.red(`Multiple sessions match "${prefix}". Be more specific.`));
    for (const m of matches) console.error(`  ${m.sessionId}  ${m.company}  ${m.status}`);
    process.exit(1);
  }
  return matches[0].sessionId;
}

export function registerTaskCommand(program: Command) {
  const task = program.command("task").description("Manage remote fetch and discovery sessions");

  task
    .command("list")
    .description("List active and recent sessions")
    .option("--json", "Output as JSON")
    .option("--limit <n>", `Limit the number of results (default ${DEFAULT_PAGE_SIZE})`)
    .option("--page <n>", "Page number for paginated results")
    .action(async (opts: { json?: boolean; limit?: string; page?: string }) => {
      const parsedLimit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        logger.error("--limit must be a positive integer");
        process.exit(1);
      }
      const explicitLimit = parsedLimit !== undefined;
      const pageSize = explicitLimit ? parsedLimit : DEFAULT_PAGE_SIZE;

      const parsedPage = opts.page === undefined ? 1 : Number(opts.page);
      if (!Number.isInteger(parsedPage) || parsedPage <= 0) {
        logger.error("--page must be a positive integer");
        process.exit(1);
      }
      const page = parsedPage;

      const { items: sessions, pagination } = await listSessions({
        limit: pageSize,
        page,
      });

      if (opts.json) {
        await writeJson({ items: sessions, pagination });
        if (!explicitLimit && pagination.hasMore) {
          logger.warn(
            formatTruncationWarning({
              returned: sessions.length,
              pageSize,
              commandExample: `releases admin discovery task list --json --limit <n> --page <p>`,
            }),
          );
        }
        return;
      }

      if (sessions.length === 0) {
        console.log(chalk.gray("No sessions found."));
        return;
      }

      for (const s of sessions) {
        const ageSec = Math.round((Date.now() - s.startedAt) / 1000);
        const sources = s.totalSources ? `${s.sourcesFetched ?? 0}/${s.totalSources} sources` : "";
        const releases = s.releasesInserted ? `${s.releasesInserted} new` : "";
        const details = [sources, releases].filter(Boolean).join(", ");
        const detailStr = details ? chalk.gray(` (${details})`) : "";

        console.log(
          `  ${statusChalk(s.status)(s.status.padEnd(10))} ${s.company.padEnd(30)} ${chalk.gray(s.sessionId.slice(0, 8))}  ${chalk.gray(formatDuration(ageSec) + " ago")}${detailStr}`,
        );
      }
      if (!explicitLimit && pagination.hasMore) {
        logger.warn(
          formatTruncationWarning({
            returned: sessions.length,
            pageSize,
            commandExample: `releases admin discovery task list --limit <n> --page <p>`,
          }),
        );
      }
    });

  task
    .command("get")
    .description("Show full detail for a single session (timing, usage, error, agent state)")
    .argument("<sessionId>", "Session ID (or unique prefix)")
    .option("--json", "Output as JSON")
    .option(
      "--save [dir]",
      "Snapshot the session as <dir>/<sessionId>/{trace.json,summary.md} (default: ~/.releases/work/runs)",
    )
    .action(async (sessionIdArg: string, opts: { json?: boolean; save?: string | boolean }) => {
      const sessionId = await resolveSessionIdFromPrefix(sessionIdArg);

      const session = (await getSession(sessionId)) as Session | null;
      if (!session) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }

      if (opts.save) {
        // Explicit request — surface failures rather than failing open.
        try {
          const dir = writeSessionTrace(
            session,
            typeof opts.save === "string" ? opts.save : undefined,
          );
          process.stderr.write(chalk.dim(`Saved trace to ${dir}\n`));
        } catch (err) {
          logger.error(`Failed to save trace: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      if (opts.json) {
        await writeJson(session);
        return;
      }

      const durSec = Math.round((session.lastUpdatedAt - session.startedAt) / 1000);

      console.log(`${chalk.bold("Session")} ${session.sessionId}`);
      console.log(`  Company:    ${session.company}`);
      console.log(`  Type:       ${session.type}`);
      if (session.agent) console.log(`  Agent:      ${session.agent}`);
      console.log(`  Status:     ${statusChalk(session.status)(session.status)}`);
      if (session.step) console.log(`  Step:       ${session.step}`);
      if (session.currentAction) console.log(`  Action:     ${session.currentAction}`);
      console.log(`  Started:    ${fmtTimestamp(session.startedAt)}`);
      console.log(
        `  Last upd.:  ${fmtTimestamp(session.lastUpdatedAt)}  (${formatDuration(durSec)})`,
      );
      if (session.runner) console.log(`  Runner:     ${session.runner}`);
      if (session.correlationId) console.log(`  Corr. ID:   ${session.correlationId}`);
      if (session.anthropicSessionId) console.log(`  Anthropic:  ${session.anthropicSessionId}`);

      const counts: string[] = [];
      if (session.totalSources != null)
        counts.push(`${session.sourcesFetched ?? 0}/${session.totalSources} sources`);
      if (session.sourcesFound != null) counts.push(`${session.sourcesFound} found`);
      if (session.sourcesValidated != null) counts.push(`${session.sourcesValidated} validated`);
      if (session.releasesInserted != null)
        counts.push(`${session.releasesInserted} releases inserted`);
      else if (session.releasesFound != null)
        counts.push(`${session.releasesFound} releases found`);
      if (counts.length > 0) console.log(`  Progress:   ${counts.join(", ")}`);

      if (session.error) {
        console.log(`  ${chalk.red("Error:")}      ${session.error}`);
        const errFields: string[] = [];
        if (session.errorSource) errFields.push(`source=${session.errorSource}`);
        if (session.errorType) errFields.push(`type=${session.errorType}`);
        if (session.stopReason) errFields.push(`stop=${session.stopReason}`);
        if (session.retryCount != null) errFields.push(`retries=${session.retryCount}`);
        if (errFields.length > 0) console.log(`              ${chalk.gray(errFields.join("  "))}`);
      }

      if (session.warnings && session.warnings.length > 0) {
        console.log(`  Warnings:`);
        for (const w of session.warnings) console.log(`    ${chalk.yellow("•")} ${w}`);
      }

      if (session.usage) {
        const u = session.usage;
        const tokens = [
          u.inputTokens != null ? `in=${u.inputTokens.toLocaleString()}` : null,
          u.outputTokens != null ? `out=${u.outputTokens.toLocaleString()}` : null,
          u.cacheReadTokens ? `cache_r=${u.cacheReadTokens.toLocaleString()}` : null,
          u.cacheWriteTokens ? `cache_w=${u.cacheWriteTokens.toLocaleString()}` : null,
        ]
          .filter(Boolean)
          .join("  ");
        const cost =
          u.estimatedUsd != null ? `  ${chalk.bold(`$${u.estimatedUsd.toFixed(4)}`)}` : "";
        console.log(`  Usage:      ${tokens}${cost}`);
        if (u.model) console.log(`              ${chalk.gray(u.model)}`);
      }

      if (session.activeSources && session.activeSources.length > 0) {
        console.log(`  Active:     ${session.activeSources.join(", ")}`);
      }

      if (session.result) {
        const sources = session.result.sources;
        const sourceCount = Array.isArray(sources) ? sources.length : 0;
        if (sourceCount > 0) {
          console.log(`  Result:     ${sourceCount} source(s) reported`);
          console.log(chalk.gray(`              (use --json to see full result block)`));
        } else {
          console.log(`  Result:     ${chalk.gray("(use --json to see full result block)")}`);
        }
      }
    });

  task
    .command("cancel")
    .description("Cancel a running session")
    .argument("<sessionId>", "Session ID (or prefix) to cancel")
    .action(async (sessionIdArg: string) => {
      const sessionId = await resolveSessionIdFromPrefix(sessionIdArg);
      const result = await cancelSession(sessionId);
      if (result.ok) {
        console.log(chalk.green(`Cancel requested for session ${sessionId.slice(0, 8)}.`));
      } else {
        console.error(chalk.red(`Failed to cancel: ${result.error}`));
        process.exit(1);
      }
    });
}

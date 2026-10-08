import { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../render/table.js";
import { findSource, getFetchLogs } from "../../api/sources.js";
import { type ActiveFetchSession } from "../../api/types.js";
import { timeAgo } from "@buildinternet/releases-core/dates";
import { stripAnsi } from "../../lib/sanitize.js";
import { writeJson } from "../../lib/output.js";
import { sourceNotFound } from "../suggest.js";

/**
 * Colour a fetch_log status for the table. crawl_timeout (#1361) and blocked
 * (#1171) are distinct degraded states — surfacing them as their own labels
 * (not the catch-all "no change") is the point of #1360; an unknown status is
 * shown verbatim rather than mislabeled.
 */
export function formatStatusLabel(status: string): string {
  switch (status) {
    case "dry_run":
      return chalk.magenta("dry run");
    case "success":
      return chalk.green("success");
    case "error":
      return chalk.red("error");
    case "crawl_timeout":
      return chalk.yellow("crawl timeout");
    case "blocked":
      return chalk.yellow("blocked");
    case "no_change":
      return chalk.dim("no change");
    default:
      return chalk.dim(status);
  }
}

/**
 * One-line banner for a source whose managed-agent fetch is still running
 * (#1360), so an operator polling the fetch log can tell "in flight" from
 * "stuck/dead" instead of seeing only terminal history.
 */
export function formatActiveFetchBanner(session: ActiveFetchSession): string {
  const startedAgo = timeAgo(new Date(session.startedAt).toISOString()) ?? "just now";
  return (
    chalk.yellow("● fetch in progress") +
    chalk.dim(` — session ${session.sessionId} · started ${startedAgo}`)
  );
}

export function registerFetchLogCommand(program: Command) {
  program
    .command("fetch-log [source]")
    .description("Show fetch history for sources")
    .option("--limit <n>", "Number of log entries", "20")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source fetch-log                 Show recent fetch history
  releases admin source fetch-log my-source       Show history for one source (slug, org/slug, or src_…)
  releases admin source fetch-log --limit 50
  releases admin source fetch-log --json`,
    )
    .action(async (source: string | undefined, opts: { limit?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit ?? "20", 10);
      // The /v1/admin/logs/fetch query param resolves typed IDs and bare slugs
      // only — `org/slug` coordinates 404 there. Round-trip through findSource
      // first so every shape the CLI advertises lands cleanly. Pass the
      // canonical typed ID downstream to short-circuit ambiguous-slug cases.
      let resolvedSource: string | undefined;
      if (source) {
        const found = await findSource(source);
        if (!found) return sourceNotFound(source);
        resolvedSource = found.id;
      }
      const { logs, activeSession } = await getFetchLogs({ source: resolvedSource, limit });

      // --json stays the bare logs array for back-compat with existing scripts;
      // the in-progress banner is human-output only.
      if (opts.json) {
        await writeJson(logs);
        return;
      }

      // Show the live in-flight fetch first — it's meaningful even when there is
      // no terminal history yet (a brand-new source mid-first-fetch).
      if (activeSession) {
        console.log(formatActiveFetchBanner(activeSession));
        console.log("");
      }

      if (logs.length === 0) {
        console.log("No fetch logs found.");
        return;
      }

      console.log(
        renderTable({
          head: [
            { label: "Source" },
            { label: "Status", noTruncate: true },
            { label: "Found", noTruncate: true, alignRight: true },
            { label: "Inserted", noTruncate: true, alignRight: true },
            { label: "Duration", noTruncate: true, alignRight: true },
            { label: "Error" },
            { label: "When", noTruncate: true },
          ],
          rows: logs.map((log) => {
            const statusLabel = formatStatusLabel(log.status);
            const sourceLabel = log.sourceName
              ? `${stripAnsi(log.sourceName)} ${chalk.dim(`(${log.sourceSlug})`)}`
              : log.sourceSlug || chalk.dim("—");
            return [
              sourceLabel,
              statusLabel,
              String(log.releasesFound),
              log.releasesInserted > 0 ? chalk.green(String(log.releasesInserted)) : chalk.dim("0"),
              log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : chalk.dim("—"),
              log.error ? chalk.red(stripAnsi(log.error)) : chalk.dim("—"),
              timeAgo(log.createdAt) ?? "—",
            ];
          }),
        }),
      );
      const hint = source
        ? `  More: "releases get ${source}" for source details · "releases admin source fetch ${source}" to re-fetch`
        : `  More: "releases admin source fetch-log <source>" to filter by source (slug, org/slug, or src_…) · "releases get <source>" for source details`;
      console.log(chalk.dim(`\n${hint}`));
    });
}

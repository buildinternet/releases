import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getRunsDir, expandHome } from "@buildinternet/releases-lib/config";
import { resolveRunDir } from "./run-dir.js";
import type { Session } from "@buildinternet/releases-api-types";

/**
 * Managed-session traces. Server-triggered sessions (`onboard`,
 * `source fetch --wait`) return full records the CLI reads but does not
 * persist. These helpers land one as `<dir>/<id>/{trace.json,summary.md}`,
 * with `summary.md` mirroring the run-summary template in
 * `docs/architecture/maintenance-workspace.md` so managed sessions and
 * Claude-Code batches read uniformly.
 */

/**
 * Where a trace is written, in precedence order:
 *   1. an explicit `--trace-dir` / `--save` value,
 *   2. the active run dir — `RELEASES_RUN_DIR`, then the sticky `.current-run`
 *      pointer (#227) — so traces co-locate with a batch's mutations.jsonl,
 *   3. the default runs dir (`~/.releases/work/runs`).
 */
export function resolveTraceDir(explicit?: string): string {
  if (explicit) return expandHome(explicit);
  const runDir = resolveRunDir();
  if (runDir) return runDir;
  return getRunsDir();
}

function fmtUsd(n: number | undefined): string {
  return n != null ? `~$${n.toFixed(4)}` : "n/a";
}

function sessionStatusLabel(status: Session["status"]): string {
  switch (status) {
    case "complete":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "partial"; // running / unknown — captured before reaching terminal
  }
}

function mdTable(rows: Array<[string, string]>): string {
  return [
    "| Field | Value |",
    "| ----- | ----- |",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");
}

export function buildSessionSummaryMarkdown(session: Session): string {
  const status = sessionStatusLabel(session.status);
  const succeeded = session.status === "complete" ? 1 : 0;
  const cost = fmtUsd(session.usage?.estimatedUsd);
  const durSec = Math.max(0, Math.round((session.lastUpdatedAt - session.startedAt) / 1000));

  const rows: Array<[string, string]> = [
    ["Session ID", session.sessionId],
    ["Company", session.company],
    ["Type", session.type],
  ];
  if (session.agent) rows.push(["Agent", session.agent]);
  if (session.usage?.model) rows.push(["Model", session.usage.model]);
  if (session.usage?.inputTokens != null || session.usage?.outputTokens != null) {
    rows.push([
      "Tokens",
      `in ${(session.usage.inputTokens ?? 0).toLocaleString()} / out ${(session.usage.outputTokens ?? 0).toLocaleString()}`,
    ]);
  }
  const sourceBits: string[] = [];
  if (session.totalSources != null) {
    sourceBits.push(`${session.sourcesFetched ?? 0}/${session.totalSources} fetched`);
  }
  if (session.sourcesFound != null) sourceBits.push(`${session.sourcesFound} found`);
  if (session.sourcesValidated != null) sourceBits.push(`${session.sourcesValidated} validated`);
  if (sourceBits.length > 0) rows.push(["Sources", sourceBits.join(", ")]);
  if (session.releasesInserted != null) {
    rows.push(["Releases inserted", String(session.releasesInserted)]);
  }
  rows.push(["Started", new Date(session.startedAt).toISOString()]);
  rows.push(["Duration", `${durSec}s`]);
  if (session.anthropicSessionId) rows.push(["Anthropic session", session.anthropicSessionId]);

  const resultBlock = session.error ?? "See ./trace.json for the full session record.";

  return [
    `# ${session.type} session — ${session.company}`,
    "",
    `**Status:** ${status}`,
    `**Targets:** 1 | **Succeeded:** ${succeeded} | **Cost:** ${cost} (managed-session estimatedUsd)`,
    "",
    "## Session",
    "",
    mdTable(rows),
    "",
    "## Result",
    "",
    resultBlock,
    "",
  ].join("\n");
}

/**
 * Trace IDs come from API responses (session/instance IDs). Constrain them to a
 * single safe path segment so a malicious or tampered response can't traverse
 * out of the trace dir (`../`, absolute paths, separators). Fail closed: an
 * unusable id throws rather than writing to an unexpected location.
 */
function safeTraceSegment(id: string): string {
  const seg = basename(id);
  // Reject anything that isn't already a clean single segment. `basename`
  // normalizes ("../escape" -> "escape"), so comparing the result back to the
  // input is what actually rejects traversal/separators/absolute paths.
  if (!seg || seg === "." || seg === ".." || seg !== id) {
    throw new Error(`Unsafe trace id: ${JSON.stringify(id)}`);
  }
  return seg;
}

/** Low-level writer. `traceDir` must already be resolved (see resolveTraceDir). */
export function writeTrace(opts: {
  traceDir: string;
  id: string;
  record: unknown;
  summaryMarkdown: string;
}): string {
  const dir = join(opts.traceDir, safeTraceSegment(opts.id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trace.json"), JSON.stringify(opts.record, null, 2) + "\n");
  writeFileSync(join(dir, "summary.md"), opts.summaryMarkdown);
  return dir;
}

export function writeSessionTrace(session: Session, explicitDir?: string): string {
  return writeTrace({
    traceDir: resolveTraceDir(explicitDir),
    id: session.sessionId,
    record: session,
    summaryMarkdown: buildSessionSummaryMarkdown(session),
  });
}

/**
 * Fail-open variant for auto-capture paths (onboard / fetch --wait). A trace
 * write must never break the session command, so this swallows errors and
 * returns `null` instead of throwing. Explicit `--save` surfaces errors via
 * the throwing `writeSessionTrace` directly.
 */
export function trySaveSessionTrace(session: Session, explicitDir?: string): string | null {
  try {
    return writeSessionTrace(session, explicitDir);
  } catch {
    return null;
  }
}

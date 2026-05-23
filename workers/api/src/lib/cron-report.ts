/**
 * Pure formatter for cron-run email reports. Kept separate from the email
 * sender so tests (which run outside the Workers runtime) can import it
 * without pulling in the `cloudflare:email` module.
 */
import type { FinalizeRunParams } from "../db/cron-runs-dao.js";
import type { TopSearchRow } from "./search-queries-top.js";

export type CronReportStatus = FinalizeRunParams["status"];

export type CronReportResultsOrg = {
  orgSlug: string;
  orgName: string;
  sourcesFetched: number;
  releasesFound: number;
  releasesInserted: number;
  errors: number;
};

/**
 * Optional roll-up of what the dispatched sessions actually did, attached
 * after a settle window in the workflow path. Absent on the immediate
 * dispatched-only emails (preflight aborts, the inline cron fallback).
 */
export type CronReportResults = {
  perOrg: CronReportResultsOrg[];
  /** Count of dispatched sessions with no fetch_log rows yet (still running). */
  sessionsWithNoActivity: number;
  /** Wall-clock window the aggregator covered (informational). */
  settleWindowMinutes: number;
};

export type CronReport = {
  cronName: string;
  runId: string;
  status: CronReportStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  candidates: number;
  dispatched: number;
  skippedOverCap: number;
  dispatchErrors: number;
  abortReason?: string | null;
  notes?: string | null;
  sessionsStarted?: string[];
  dispatchErrorDetail?: Array<{ orgSlug: string; error: string }>;
  results?: CronReportResults;
  /**
   * Top search queries over the last 24h (bot-filtered). Populated by the
   * `top-searches` step in the workflow; absent on aborted/inline runs.
   */
  topSearches?: TopSearchRow[];
  /** Base URL for cron-run detail links in the body (no trailing slash). */
  adminBaseUrl?: string;
};

export type FormattedReport = {
  subject: string;
  text: string;
  html: string;
};

const SEVERITY_PREFIX: Record<CronReportStatus, string> = {
  done: "",
  degraded: "[degraded] ",
  dispatch_failed: "[failed] ",
  aborted: "[aborted] ",
};

function formatDuration(ms: number | null): string {
  if (ms == null) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

/** "Acme Inc (acme)" — name with slug, falling back to the slug alone. */
function orgLabel(o: CronReportResultsOrg): string {
  const name = o.orgName?.trim();
  return name && name !== o.orgSlug ? `${name} (${o.orgSlug})` : o.orgSlug;
}

function totalReleasesInserted(r: CronReportResults): number {
  let n = 0;
  for (const o of r.perOrg) n += o.releasesInserted;
  return n;
}

function totalReleasesFound(r: CronReportResults): number {
  let n = 0;
  for (const o of r.perOrg) n += o.releasesFound;
  return n;
}

function totalSourcesFetched(r: CronReportResults): number {
  let n = 0;
  for (const o of r.perOrg) n += o.sourcesFetched;
  return n;
}

function totalErrors(r: CronReportResults): number {
  let n = 0;
  for (const o of r.perOrg) n += o.errors;
  return n;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCronReport(report: CronReport): FormattedReport {
  const prefix = SEVERITY_PREFIX[report.status];
  const dispatchedSegment = `${report.dispatched}/${report.candidates} dispatched`;
  const resultsSegment = report.results
    ? ` → ${totalReleasesInserted(report.results)} inserted`
    : "";
  const subject = `${prefix}${report.cronName}: ${report.status} — ${dispatchedSegment}${resultsSegment}`;

  const lines: string[] = [];
  lines.push(`Cron: ${report.cronName}`);
  lines.push(`Run: ${report.runId}`);
  lines.push(`Status: ${report.status}${report.abortReason ? ` (${report.abortReason})` : ""}`);
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Ended:   ${report.endedAt}`);
  lines.push(`Duration: ${formatDuration(report.durationMs)}`);
  lines.push("");
  lines.push(`Candidates:       ${report.candidates}`);
  lines.push(`Dispatched:       ${report.dispatched}`);
  lines.push(`Skipped (cap):    ${report.skippedOverCap}`);
  lines.push(`Dispatch errors:  ${report.dispatchErrors}`);

  if (report.results) {
    const r = report.results;
    lines.push("");
    lines.push(`Results (after ${r.settleWindowMinutes}min settle):`);
    lines.push(`  Sources fetched:    ${totalSourcesFetched(r)}`);
    lines.push(`  Releases found:     ${totalReleasesFound(r)}`);
    lines.push(`  Releases inserted:  ${totalReleasesInserted(r)}`);
    lines.push(`  Fetch errors:       ${totalErrors(r)}`);
    if (r.sessionsWithNoActivity > 0) {
      lines.push(
        `  Still running:      ${r.sessionsWithNoActivity} session${r.sessionsWithNoActivity === 1 ? "" : "s"}`,
      );
    }
    if (r.perOrg.length > 0) {
      lines.push("");
      lines.push("Per org:");
      for (const o of r.perOrg) {
        const errSeg = o.errors > 0 ? ` errors=${o.errors}` : "";
        lines.push(
          `  - ${orgLabel(o)}: fetched=${o.sourcesFetched} found=${o.releasesFound} inserted=${o.releasesInserted}${errSeg}`,
        );
      }
    }
  }

  if (report.topSearches !== undefined) {
    lines.push("");
    lines.push("Top searches (last 24h):");
    if (report.topSearches.length === 0) {
      lines.push("  (no search traffic)");
    } else {
      for (const s of report.topSearches) {
        const ts = new Date(s.lastSeen).toISOString();
        lines.push(`  - ${s.query} (${s.count}x, last seen ${ts})`);
      }
    }
  }

  if (report.notes) {
    lines.push("");
    lines.push(`Notes: ${report.notes}`);
  }

  if (report.dispatchErrorDetail && report.dispatchErrorDetail.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const e of report.dispatchErrorDetail) {
      lines.push(`  - ${e.orgSlug}: ${e.error}`);
    }
  }

  if (report.sessionsStarted && report.sessionsStarted.length > 0) {
    lines.push("");
    lines.push(`Sessions (${report.sessionsStarted.length}):`);
    for (const id of report.sessionsStarted) lines.push(`  - ${id}`);
  }

  if (report.adminBaseUrl) {
    lines.push("");
    lines.push(`Detail: ${report.adminBaseUrl}/v1/admin/cron-runs/${report.runId}`);
  }

  const text = lines.join("\n");

  const statusColor =
    report.status === "done" ? "#16a34a" : report.status === "degraded" ? "#d97706" : "#dc2626";

  const htmlRows: string[] = [];
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(label)}</td><td style="padding:4px 0;font-family:ui-monospace,monospace;">${escapeHtml(value)}</td></tr>`;
  htmlRows.push(row("Cron", report.cronName));
  htmlRows.push(row("Run", report.runId));
  htmlRows.push(
    row("Status", report.status + (report.abortReason ? ` (${report.abortReason})` : "")),
  );
  htmlRows.push(row("Started", report.startedAt));
  htmlRows.push(row("Ended", report.endedAt));
  htmlRows.push(row("Duration", formatDuration(report.durationMs)));
  htmlRows.push(row("Candidates", String(report.candidates)));
  htmlRows.push(row("Dispatched", String(report.dispatched)));
  htmlRows.push(row("Skipped (cap)", String(report.skippedOverCap)));
  htmlRows.push(row("Dispatch errors", String(report.dispatchErrors)));

  let resultsHtml = "";
  if (report.results) {
    const r = report.results;
    const stillRunning =
      r.sessionsWithNoActivity > 0
        ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">Still running</td><td style="padding:4px 0;font-family:ui-monospace,monospace;">${r.sessionsWithNoActivity} session${r.sessionsWithNoActivity === 1 ? "" : "s"}</td></tr>`
        : "";
    const orgRows = r.perOrg
      .map((o) => {
        const errSeg =
          o.errors > 0 ? ` <span style="color:#dc2626;">errors=${o.errors}</span>` : "";
        return `<tr><td style="padding:4px 12px 4px 0;font-family:ui-monospace,monospace;">${escapeHtml(orgLabel(o))}</td><td style="padding:4px 12px 4px 0;color:#64748b;">${o.sourcesFetched} fetched</td><td style="padding:4px 12px 4px 0;color:#64748b;">${o.releasesFound} found</td><td style="padding:4px 0;"><strong>${o.releasesInserted}</strong> inserted${errSeg}</td></tr>`;
      })
      .join("");
    const orgTable =
      r.perOrg.length > 0
        ? `<h3 style="margin-top:24px;">Per org</h3><table style="border-collapse:collapse;font-size:14px;">${orgRows}</table>`
        : "";
    resultsHtml = `<h3 style="margin-top:24px;">Results <span style="font-weight:400;color:#64748b;">(after ${r.settleWindowMinutes}min settle)</span></h3><table style="border-collapse:collapse;font-size:14px;"><tr><td style="padding:4px 12px 4px 0;color:#64748b;">Sources fetched</td><td style="padding:4px 0;font-family:ui-monospace,monospace;">${totalSourcesFetched(r)}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#64748b;">Releases found</td><td style="padding:4px 0;font-family:ui-monospace,monospace;">${totalReleasesFound(r)}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#64748b;">Releases inserted</td><td style="padding:4px 0;font-family:ui-monospace,monospace;"><strong>${totalReleasesInserted(r)}</strong></td></tr><tr><td style="padding:4px 12px 4px 0;color:#64748b;">Fetch errors</td><td style="padding:4px 0;font-family:ui-monospace,monospace;">${totalErrors(r)}</td></tr>${stillRunning}</table>${orgTable}`;
  }

  let topSearchesHtml = "";
  if (report.topSearches !== undefined) {
    if (report.topSearches.length === 0) {
      topSearchesHtml = `<h3 style="margin-top:24px;">Top searches <span style="font-weight:400;color:#64748b;">(last 24h)</span></h3><p style="color:#64748b;font-size:14px;">No search traffic.</p>`;
    } else {
      const searchRows = report.topSearches
        .map((s) => {
          const ts = new Date(s.lastSeen).toISOString();
          return `<tr><td style="padding:4px 12px 4px 0;font-family:ui-monospace,monospace;">${escapeHtml(s.query)}</td><td style="padding:4px 12px 4px 0;color:#64748b;text-align:right;">${s.count}x</td><td style="padding:4px 0;color:#64748b;font-size:12px;">${escapeHtml(ts)}</td></tr>`;
        })
        .join("");
      topSearchesHtml = `<h3 style="margin-top:24px;">Top searches <span style="font-weight:400;color:#64748b;">(last 24h)</span></h3><table style="border-collapse:collapse;font-size:14px;">${searchRows}</table>`;
    }
  }

  let errorsHtml = "";
  if (report.dispatchErrorDetail && report.dispatchErrorDetail.length > 0) {
    const items = report.dispatchErrorDetail
      .map((e) => `<li><strong>${escapeHtml(e.orgSlug)}</strong>: ${escapeHtml(e.error)}</li>`)
      .join("");
    errorsHtml = `<h3 style="margin-top:24px;">Errors</h3><ul>${items}</ul>`;
  }

  let notesHtml = "";
  if (report.notes) {
    notesHtml = `<p style="color:#475569;margin-top:16px;"><em>${escapeHtml(report.notes)}</em></p>`;
  }

  let detailLink = "";
  if (report.adminBaseUrl) {
    const url = `${report.adminBaseUrl}/v1/admin/cron-runs/${report.runId}`;
    detailLink = `<p style="margin-top:16px;"><a href="${escapeHtml(url)}">View run detail</a></p>`;
  }

  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:640px;">
<h2 style="color:${statusColor};margin-bottom:8px;">${escapeHtml(report.cronName)} — ${escapeHtml(report.status)}</h2>
<table style="border-collapse:collapse;font-size:14px;">${htmlRows.join("")}</table>
${resultsHtml}
${topSearchesHtml}
${notesHtml}
${errorsHtml}
${detailLink}
</body></html>`;

  return { subject, text, html };
}

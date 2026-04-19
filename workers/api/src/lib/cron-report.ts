/**
 * Pure formatter for cron-run email reports. Kept separate from the email
 * sender so tests (which run outside the Workers runtime) can import it
 * without pulling in the `cloudflare:email` module.
 */
import type { FinalizeRunParams } from "../db/cron-runs-dao.js";

export type CronReportStatus = FinalizeRunParams["status"];

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
  const subject = `${prefix}${report.cronName}: ${report.status} — ${report.dispatched}/${report.candidates} dispatched`;

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
${notesHtml}
${errorsHtml}
${detailLink}
</body></html>`;

  return { subject, text, html };
}

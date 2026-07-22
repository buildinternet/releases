/**
 * Pure formatter for cron-run email reports. Kept separate from the email
 * sender so tests (which run outside the Workers runtime) can import it
 * without pulling in the `cloudflare:email` module.
 */
import type { FinalizeRunParams } from "../db/cron-runs-dao.js";
import type { TopSearchRow } from "./search-queries-top.js";
import {
  renderEmail,
  type EmailBlock,
  type EmailDataRow,
  type EmailTone,
} from "@releases/rendering/email-shell";

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

  // The plain-text body above is pinned byte-for-byte by
  // tests/unit/cron-report-formatter.test.ts — it stays hand-built. Only the
  // HTML twin below goes through the shared email shell.
  const text = lines.join("\n");

  // "failed" covers both the immediate dispatch failure and an aborted
  // preflight — both mean the run didn't complete normally, unlike "degraded"
  // (it ran, some orgs errored).
  const tone: EmailTone =
    report.status === "degraded"
      ? "warn"
      : report.status === "dispatch_failed" || report.status === "aborted"
        ? "crit"
        : "accent";

  const blocks: EmailBlock[] = [
    {
      t: "data",
      rows: [
        { label: "Candidates", value: String(report.candidates) },
        { label: "Dispatched", value: String(report.dispatched) },
        { label: "Skipped (cap)", value: String(report.skippedOverCap) },
        {
          label: "Dispatch errors",
          value: String(report.dispatchErrors),
          kind: report.dispatchErrors > 0 ? "err" : undefined,
        },
        { label: "Duration", value: formatDuration(report.durationMs) },
      ],
    },
  ];

  if (report.results) {
    const r = report.results;
    blocks.push({ t: "kicker", text: `Results (after ${r.settleWindowMinutes}min settle)` });
    const resultRows: EmailDataRow[] = [
      { label: "Sources fetched", value: String(totalSourcesFetched(r)) },
      { label: "Releases found", value: String(totalReleasesFound(r)) },
      { label: "Releases inserted", value: String(totalReleasesInserted(r)) },
      {
        label: "Fetch errors",
        value: String(totalErrors(r)),
        kind: totalErrors(r) > 0 ? "err" : undefined,
      },
    ];
    if (r.sessionsWithNoActivity > 0) {
      resultRows.push({
        label: "Still running",
        value: `${r.sessionsWithNoActivity} session${r.sessionsWithNoActivity === 1 ? "" : "s"}`,
      });
    }
    blocks.push({ t: "data", rows: resultRows });

    if (r.perOrg.length > 0) {
      blocks.push({ t: "kicker", text: "Per org" });
      for (const o of r.perOrg) {
        const errSeg = o.errors > 0 ? ` errors=${o.errors}` : "";
        // Markdown `**bold**` (not the `entity` block) so the org label bolds
        // via the shared `<strong>` — matches what an operator scanning the
        // list expects to jump out.
        blocks.push({
          t: "p",
          text: `**${orgLabel(o)}**: fetched=${o.sourcesFetched} found=${o.releasesFound} inserted=${o.releasesInserted}${errSeg}`,
        });
      }
    }
  }

  if (report.topSearches !== undefined) {
    blocks.push({ t: "kicker", text: "Top searches (last 24h)" });
    if (report.topSearches.length === 0) {
      blocks.push({ t: "fine", text: "No search traffic." });
    } else {
      for (const s of report.topSearches) {
        const ts = new Date(s.lastSeen).toISOString();
        blocks.push({ t: "p", text: `${s.query} — ${s.count}x, last seen ${ts}` });
      }
    }
  }

  if (report.dispatchErrorDetail && report.dispatchErrorDetail.length > 0) {
    blocks.push({ t: "kicker", text: "Dispatch errors" });
    for (const e of report.dispatchErrorDetail) {
      blocks.push({ t: "p", text: `**${e.orgSlug}**: ${e.error}` });
    }
  }

  if (report.notes) {
    blocks.push({ t: "fine", text: report.notes });
  }

  if (report.adminBaseUrl) {
    blocks.push({
      t: "button",
      label: "View run detail",
      url: `${report.adminBaseUrl}/v1/admin/cron-runs/${report.runId}`,
    });
  }

  const { html } = renderEmail({
    lane: "Cron",
    tone,
    title: `${report.cronName} — ${report.status}`,
    subtitle: `${report.runId}${report.abortReason ? ` (${report.abortReason})` : ""}`,
    blocks,
    footer: {
      reason: `Automated report from Releases — the ${report.cronName} cron run.`,
    },
  });

  return { subject, text, html };
}

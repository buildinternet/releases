/**
 * Pure formatter for the poll-and-fetch failure alert.
 *
 * The `workflow_failures` table only records an opaque `source_id`, which made
 * the alert email impossible to act on without a DB round-trip. The summary
 * workflow joins each failure to its owning `sources` + `organizations` row and
 * passes the identity here so the email names the company and source — e.g.
 * "Vercel — Next.js (vercel/next-js)" — alongside the URL, fetch type, failing
 * step, and error. The source id stays as a trailing detail for admin lookup.
 *
 * Kept free of `cloudflare:*` imports so it can be unit-tested outside the
 * Workers runtime.
 */

export type PollFetchFailure = {
  sourceId: string;
  stepName: string;
  error: string;
};

/** Identity columns joined from `sources` + `organizations` for one source. */
export type PollFetchSourceDetail = {
  sourceId: string;
  sourceName: string | null;
  sourceSlug: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  orgName: string | null;
  orgSlug: string | null;
};

export type FormattedAlert = {
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "Vercel — Next.js", degrading to the bare source id if nothing resolved. */
function headline(detail: PollFetchSourceDetail | undefined, sourceId: string): string {
  if (!detail) return sourceId;
  const org = detail.orgName ?? detail.orgSlug;
  const src = detail.sourceName ?? detail.sourceSlug;
  if (org && src) return `${org} — ${src}`;
  return src ?? org ?? sourceId;
}

/** "vercel/next-js" coordinate from slugs, when both are present. */
function coordinate(detail: PollFetchSourceDetail | undefined): string | null {
  if (!detail?.orgSlug || !detail?.sourceSlug) return null;
  return `${detail.orgSlug}/${detail.sourceSlug}`;
}

/**
 * The ordered detail rows for one failure, computed once so the text and HTML
 * renderers stay in sync. `kind` lets the HTML side apply per-field markup
 * (link for the url, red for the error) without re-deriving which rows exist.
 */
type DetailRow = { label: string; value: string; kind?: "url" | "error" };

function detailRows(f: PollFetchFailure, detail: PollFetchSourceDetail | undefined): DetailRow[] {
  const rows: DetailRow[] = [];
  const coord = coordinate(detail);
  if (coord) rows.push({ label: "org/source", value: coord });
  if (detail?.sourceUrl) rows.push({ label: "url", value: detail.sourceUrl, kind: "url" });
  if (detail?.sourceType) rows.push({ label: "type", value: detail.sourceType });
  rows.push({ label: "step", value: f.stepName });
  rows.push({ label: "error", value: f.error, kind: "error" });
  rows.push({ label: "source id", value: f.sourceId });
  return rows;
}

export function formatPollFetchAlert(
  failures: PollFetchFailure[],
  detailsById: Map<string, PollFetchSourceDetail>,
  scheduledTime: number,
): FormattedAlert {
  const scheduledIso = new Date(scheduledTime).toISOString();

  // Subject names the source when exactly one failed (the common case); a
  // wider outage stays count-based to keep the line short. The raw epoch
  // `scheduledTime` is preserved so the per-fire dedup key in sendAlert still
  // collapses only true retries of the same summary fire.
  const subject =
    failures.length === 1
      ? `[alert] poll-and-fetch: ${headline(
          detailsById.get(failures[0].sourceId),
          failures[0].sourceId,
        )} failed at ${failures[0].stepName} (scheduledTime=${scheduledTime})`
      : `[alert] poll-and-fetch: ${failures.length} source(s) failed (scheduledTime=${scheduledTime})`;

  const lines: string[] = [
    `${failures.length} source(s) failed during the poll-and-fetch fan-out.`,
    `Scheduled time: ${scheduledIso}`,
    "",
  ];
  for (const f of failures) {
    const detail = detailsById.get(f.sourceId);
    lines.push(headline(detail, f.sourceId));
    for (const { label, value } of detailRows(f, detail)) {
      // Pad "label:" to a fixed column so the values line up vertically.
      lines.push(`    ${`${label}:`.padEnd(13)}${value}`);
    }
    lines.push("");
  }
  const text = `${lines.join("\n").trimEnd()}\n`;

  const htmlRow = ({ label, value, kind }: DetailRow): string => {
    const escaped = escapeHtml(value);
    let cell: string;
    switch (kind) {
      case "url":
        cell = `<a href="${escaped}">${escaped}</a>`;
        break;
      case "error":
        cell = `<span style="color:#dc2626;">${escaped}</span>`;
        break;
      default:
        cell = escaped;
    }
    return `<tr><td style="padding:2px 12px 2px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(
      label,
    )}</td><td style="padding:2px 0;font-family:ui-monospace,monospace;word-break:break-word;">${cell}</td></tr>`;
  };

  const blocks = failures
    .map((f) => {
      const detail = detailsById.get(f.sourceId);
      const rows = detailRows(f, detail).map(htmlRow).join("");
      return `<div style="margin-top:16px;border-left:3px solid #dc2626;padding-left:12px;">
<h3 style="margin:0 0 6px;font-size:15px;">${escapeHtml(headline(detail, f.sourceId))}</h3>
<table style="border-collapse:collapse;font-size:13px;">${rows}</table>
</div>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:640px;">
<h2 style="color:#dc2626;margin-bottom:4px;">poll-and-fetch — ${failures.length} source(s) failed</h2>
<p style="color:#64748b;font-size:13px;margin-top:0;">Scheduled time: ${escapeHtml(scheduledIso)}</p>
${blocks}
</body></html>`;

  return { subject, text, html };
}

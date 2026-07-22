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

import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";

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

/** Padded `"label:"` at a fixed column so the values line up vertically. */
function field(label: string, value: string): string {
  return `    ${`${label}:`.padEnd(13)}${value}`;
}

/**
 * Only http/https values become clickable anchors. Validates the original
 * (pre-escape) URL so a malformed or hostile `sources.url` — e.g. a
 * `javascript:` scheme — renders as escaped text, never a live link in an
 * operator's mail client. Escaping already blocks attribute breakout; this
 * blocks the scheme itself.
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
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
      lines.push(field(label, value));
    }
    lines.push("");
  }
  const text = `${lines.join("\n").trimEnd()}\n`;

  const blocks: EmailBlock[] = [];
  for (const f of failures) {
    const detail = detailsById.get(f.sourceId);
    // Only a validated http(s) source URL becomes the entity's link — a
    // hostile `javascript:` scheme still shows up as plain text in the `data`
    // rows below, but never as a clickable anchor.
    const url = detail?.sourceUrl && isHttpUrl(detail.sourceUrl) ? detail.sourceUrl : undefined;
    blocks.push({
      t: "entity",
      coord: headline(detail, f.sourceId),
      metrics: `step: ${f.stepName}`,
      url,
      sev: "crit",
    });
    blocks.push({
      t: "data",
      rows: detailRows(f, detail).map((r) => ({
        label: r.label,
        value: r.value,
        kind: r.kind === "error" ? "err" : undefined,
      })),
    });
  }

  const { html } = renderEmail({
    lane: "Alert · Poll fetch",
    tone: "crit",
    title: `poll-and-fetch — ${failures.length} source(s) failed`,
    subtitle: `Scheduled time: ${scheduledIso}`,
    blocks,
    footer: {
      reason:
        "Automated alert from Releases — one or more sources failed during the scheduled poll-and-fetch run.",
    },
  });

  return { subject, text, html };
}

/**
 * Admin digest for first-party + Firecrawl source staleness scans.
 */
import type { FirecrawlStaleEntry } from "../cron/firecrawl-staleness.js";
import type { StaleSourceEntry } from "../cron/source-staleness.js";
import { appendHtmlFooter, appendTextFooter, wrapHtmlEmail } from "./email-layout.js";
import { escapeHtml } from "./html-escape.js";

export type StalenessDigestInput = {
  firstParty: StaleSourceEntry[];
  firecrawl: FirecrawlStaleEntry[];
  /** Web/admin origin for source links, e.g. https://releases.sh */
  webOrigin: string;
  scannedAt: string;
};

function orgHeadline(orgName: string | null, orgSlug: string | null, slug: string): string {
  if (orgName && orgSlug && orgName !== orgSlug) return `${orgName} (${orgSlug}) — ${slug}`;
  if (orgSlug) return `${orgSlug}/${slug}`;
  return slug;
}

function sourceAdminUrl(webOrigin: string, orgSlug: string | null, slug: string): string | null {
  if (!orgSlug) return null;
  return `${webOrigin}/${orgSlug}/${slug}`;
}

export function buildStalenessDigestEmail(input: StalenessDigestInput): {
  subject: string;
  text: string;
  html: string;
} {
  const total = input.firstParty.length + input.firecrawl.length;
  const subject = `[staleness] ${total} source${total === 1 ? "" : "s"} overdue`;
  const lines: string[] = [
    `Source staleness digest — ${input.scannedAt}`,
    "",
    `${total} source(s) are overdue for new releases or monitor deliveries.`,
    "",
  ];

  if (input.firstParty.length > 0) {
    lines.push(`First-party (${input.firstParty.length})`);
    lines.push(
      "Established-cadence sources we still poll but that have gone quiet past their overdue window.",
    );
    lines.push("");
    for (const e of input.firstParty) {
      lines.push(orgHeadline(e.orgName, e.orgSlug, e.slug));
      lines.push(`    type:         ${e.sourceType}`);
      lines.push(`    quiet for:    ${e.daysSinceNewest}d (window ${e.windowDays}d)`);
      lines.push(`    median gap:   ${e.medianGapDays}d`);
      lines.push(`    newest:       ${e.newestRelease ?? "(never)"}`);
      lines.push(`    last seen:    ${e.lastSeenAt}`);
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      if (adminUrl) lines.push(`    page:         ${adminUrl}`);
      lines.push(`    source id:    ${e.sourceId}`);
      lines.push("");
    }
  }

  if (input.firecrawl.length > 0) {
    lines.push(`Firecrawl monitors (${input.firecrawl.length})`);
    lines.push("Firecrawl-owned sources whose monitor has stopped delivering.");
    lines.push("");
    for (const e of input.firecrawl) {
      lines.push(orgHeadline(e.orgName, e.orgSlug, e.slug));
      lines.push(`    last fetch:   ${e.lastFetchedAt ?? "(never)"}`);
      lines.push(`    threshold:    ${e.staleHours}h (${e.thresholdBasis})`);
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      if (adminUrl) lines.push(`    page:         ${adminUrl}`);
      lines.push(`    source id:    ${e.sourceId}`);
      lines.push("");
    }
  }

  const footer = {
    reason:
      "Internal daily digest from Releases — sources flagged by the staleness scans (first-party poll path and Firecrawl monitors).",
    links: [{ label: "Admin status", href: `${input.webOrigin}/admin/status` }],
  };
  const text = appendTextFooter(lines.join("\n").trimEnd(), footer);

  const htmlBlocks: string[] = [
    `<h1 style="font:600 18px system-ui,sans-serif;margin:0 0 4px;">Source staleness digest</h1>`,
    `<p style="color:#64748b;font-size:13px;margin:0 0 16px;">${escapeHtml(input.scannedAt)} · ${total} overdue</p>`,
  ];

  const renderSection = (title: string, blurb: string, rows: string): void => {
    htmlBlocks.push(
      `<h2 style="font:600 14px system-ui,sans-serif;margin:20px 0 6px;">${escapeHtml(title)}</h2>`,
      `<p style="font:13px system-ui,sans-serif;color:#64748b;margin:0 0 10px;">${escapeHtml(blurb)}</p>`,
      rows,
    );
  };

  if (input.firstParty.length > 0) {
    const rows = input.firstParty
      .map((e) => {
        const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
        const headline = escapeHtml(orgHeadline(e.orgName, e.orgSlug, e.slug));
        const link = adminUrl
          ? `<a href="${escapeHtml(adminUrl)}" style="color:#1a56db;text-decoration:none;">${headline}</a>`
          : headline;
        return (
          `<div style="margin:10px 0;padding-left:12px;border-left:3px solid #f59e0b;">` +
          `<div style="font-weight:600;">${link}</div>` +
          `<div style="font:13px ui-monospace,monospace;color:#475569;margin-top:4px;">` +
          `quiet ${e.daysSinceNewest}d · window ${e.windowDays}d · ${escapeHtml(e.sourceType)}` +
          `</div></div>`
        );
      })
      .join("");
    renderSection(
      `First-party (${input.firstParty.length})`,
      "Established-cadence sources we still poll but that have gone quiet.",
      rows,
    );
  }

  if (input.firecrawl.length > 0) {
    const rows = input.firecrawl
      .map((e) => {
        const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
        const headline = escapeHtml(orgHeadline(e.orgName, e.orgSlug, e.slug));
        const link = adminUrl
          ? `<a href="${escapeHtml(adminUrl)}" style="color:#1a56db;text-decoration:none;">${headline}</a>`
          : headline;
        return (
          `<div style="margin:10px 0;padding-left:12px;border-left:3px solid #dc2626;">` +
          `<div style="font-weight:600;">${link}</div>` +
          `<div style="font:13px ui-monospace,monospace;color:#475569;margin-top:4px;">` +
          `last fetch ${escapeHtml(e.lastFetchedAt ?? "never")} · threshold ${e.staleHours}h` +
          `</div></div>`
        );
      })
      .join("");
    renderSection(
      `Firecrawl monitors (${input.firecrawl.length})`,
      "Firecrawl-owned sources whose monitor has stopped delivering.",
      rows,
    );
  }

  const html = wrapHtmlEmail(appendHtmlFooter(htmlBlocks.join(""), footer));
  return { subject, text, html };
}

/**
 * Admin digest for first-party + Firecrawl source staleness scans.
 */
import type { FirecrawlStaleEntry } from "../cron/firecrawl-staleness.js";
import type { StaleSourceEntry } from "../cron/source-staleness.js";
import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";

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

  const blocks: EmailBlock[] = [
    {
      t: "p",
      text: `${total} source(s) are overdue for new releases or monitor deliveries.`,
    },
  ];

  if (input.firstParty.length > 0) {
    blocks.push({ t: "kicker", text: `First-party (${input.firstParty.length})` });
    blocks.push({
      t: "fine",
      text: "Established-cadence sources we still poll but that have gone quiet past their overdue window.",
    });
    for (const e of input.firstParty) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `quiet ${e.daysSinceNewest}d · window ${e.windowDays}d · median gap ${e.medianGapDays}d · newest ${e.newestRelease ?? "(never)"} · last seen ${e.lastSeenAt} · ${e.sourceId}`,
        url: adminUrl ?? undefined,
        sev: "warn",
      });
    }
  }

  if (input.firecrawl.length > 0) {
    blocks.push({ t: "kicker", text: `Firecrawl monitors (${input.firecrawl.length})` });
    blocks.push({
      t: "fine",
      text: "Firecrawl-owned sources whose monitor has stopped delivering.",
    });
    for (const e of input.firecrawl) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `last fetch ${e.lastFetchedAt ?? "(never)"} · threshold ${e.staleHours}h (${e.thresholdBasis}) · ${e.sourceId}`,
        url: adminUrl ?? undefined,
        sev: "crit",
      });
    }
  }

  const { html, text } = renderEmail({
    lane: "Admin · Staleness",
    tone: "warn",
    title: "Source staleness digest",
    subtitle: input.scannedAt,
    blocks,
    footer: {
      reason:
        "Internal daily digest from Releases — sources flagged by the staleness scans (first-party poll path and Firecrawl monitors).",
      links: [{ label: "Admin status", href: `${input.webOrigin}/admin/status` }],
    },
  });

  return { subject, text, html };
}

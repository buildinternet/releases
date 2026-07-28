/**
 * Admin digest for first-party + Firecrawl source staleness scans.
 */
import type { FirecrawlStaleEntry } from "../cron/firecrawl-staleness.js";
import type { StaleSourceEntry } from "../cron/source-staleness.js";
import type { ProviderHealthEntry } from "../cron/provider-health.js";
import { renderEmail, subjectNames, type EmailBlock } from "@releases/rendering/email-shell";

export type StalenessDigestInput = {
  firstParty: StaleSourceEntry[];
  firecrawl: FirecrawlStaleEntry[];
  /** Sources whose most recent ingest attempt failed as a provider quota/billing shutoff. */
  providerHealth: ProviderHealthEntry[];
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
  const total = input.firstParty.length + input.firecrawl.length + input.providerHealth.length;
  // A provider quota shutoff is the most urgent signal here — a systemic
  // outage, not one flaky source — so it drives the subject line whenever
  // present, ahead of ordinary staleness counts.
  const hasProviderIssue = input.providerHealth.length > 0;
  // Name the orgs that went quiet: "4 overdue" alone reads the same every day
  // and says nothing about whether this run needs attention.
  const affected = subjectNames([
    ...input.providerHealth.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...input.firstParty.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...input.firecrawl.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
  ]);
  const subject = hasProviderIssue
    ? `[staleness] provider quota shutoff: ${input.providerHealth.length} source${input.providerHealth.length === 1 ? "" : "s"} unable to ingest${affected ? ` (${affected})` : ""}`
    : `[staleness] ${total} source${total === 1 ? "" : "s"} overdue${affected ? `: ${affected}` : ""}`;

  // `total` now spans three scans, so the lead has to name the provider-health
  // entries when there are any — otherwise the first line an operator reads
  // during a quota shutoff describes those crit rows as merely "overdue", which
  // is the exact misreading this section was added to prevent.
  const blocks: EmailBlock[] = [
    {
      t: "p",
      text: hasProviderIssue
        ? `${total} source(s) need attention — including ${input.providerHealth.length} unable to ingest at all because the AI provider is cut off.`
        : `${total} source(s) are overdue for new releases or monitor deliveries.`,
    },
  ];

  if (input.providerHealth.length > 0) {
    blocks.push({ t: "kicker", text: `Provider health (${input.providerHealth.length})` });
    blocks.push({
      t: "fine",
      text: "Sources whose most recent ingest attempt failed because the AI provider itself is cut off (spend cap or billing shutoff) — not an ordinary transient error. This needs a human to raise the cap or wait out the stated reset; retrying will not help.",
    });
    for (const e of input.providerHealth) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      const regain = e.regainAccessAt ? `regains ${e.regainAccessAt}` : "no stated reset";
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `provider ${e.provider} · ${regain} · last evaluated ${e.lastFetchedAt ?? "(never)"} · failing since ${e.lastAttemptAt} · ${e.sourceId}`,
        url: adminUrl ?? undefined,
        sev: "crit",
      });
    }
  }

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
        "Internal daily digest from Releases — sources flagged by the staleness scans (first-party poll path, Firecrawl monitors, and provider health).",
      links: [{ label: "Admin status", href: `${input.webOrigin}/admin/status` }],
    },
  });

  return { subject, text, html };
}

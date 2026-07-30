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
  /**
   * Whether the quota shutoff behind `providerHealth` is corroborated as still
   * in effect (see `ProviderHealthScanResult.outageActive`). When false, those
   * entries are aftermath of a since-cleared outage — sources that failed
   * during it and were never re-attempted — and must not be presented as
   * "currently unable to ingest".
   */
  providerOutageActive: boolean;
  /** Web/admin origin for source links, e.g. https://releases.sh */
  webOrigin: string;
  scannedAt: string;
};

/**
 * Source types whose fetch path is transparent: the upstream API tells us
 * outright whether there are new releases (GitHub releases API, App Store
 * lookup, video feeds). A quiet source of these types means the upstream
 * simply hasn't shipped — our polling is demonstrably healthy — so it is
 * informational, not a breakage signal. Scrape/feed/agent pipelines are
 * opaque: extraction can silently fail or the page/feed can move, so quiet
 * there genuinely may mean broken ingest.
 */
const TRANSPARENT_SOURCE_TYPES = new Set(["github", "appstore", "video"]);

/**
 * The actionable population for a digest run: an active provider shutoff (or
 * a cleared one's missed ingests), opaque-pipeline first-party sources gone
 * quiet, and dead Firecrawl monitors. Upstream-quiet transparent sources are
 * excluded — they ride along informationally but should never by themselves
 * trigger an email. `sendStalenessDigest` uses this to decide whether to send.
 */
export function countNeedsAttention(
  input: Pick<StalenessDigestInput, "firstParty" | "firecrawl" | "providerHealth">,
): number {
  return (
    input.providerHealth.length +
    input.firstParty.filter((e) => !TRANSPARENT_SOURCE_TYPES.has(e.sourceType)).length +
    input.firecrawl.length
  );
}

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
  const providerActive = input.providerOutageActive ? input.providerHealth : [];
  const providerAftermath = input.providerOutageActive ? [] : input.providerHealth;
  const opaque = input.firstParty.filter((e) => !TRANSPARENT_SOURCE_TYPES.has(e.sourceType));
  const upstreamQuiet = input.firstParty.filter((e) => TRANSPARENT_SOURCE_TYPES.has(e.sourceType));

  // "Needs attention" is the actionable population: an active provider
  // shutoff, opaque-pipeline sources gone quiet, a cleared outage's missed
  // ingests, and dead Firecrawl monitors. Upstream-quiet transparent sources
  // are appended informationally and deliberately kept out of the headline
  // counts — counting a GitHub repo that simply stopped shipping as a source
  // that "needs attention" made the fleet read far more broken than it is.
  const attention =
    providerActive.length + providerAftermath.length + opaque.length + input.firecrawl.length;
  const hasProviderIssue = providerActive.length > 0;
  // Name the orgs that need attention: "4 overdue" alone reads the same every
  // day and says nothing about whether this run needs attention.
  const affected = subjectNames([
    ...providerActive.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...providerAftermath.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...opaque.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...input.firecrawl.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
  ]);
  const subject = hasProviderIssue
    ? `[staleness] provider quota shutoff: ${providerActive.length} source${providerActive.length === 1 ? "" : "s"} unable to ingest${affected ? ` (${affected})` : ""}`
    : attention > 0
      ? `[staleness] ${attention} source${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention${affected ? `: ${affected}` : ""}`
      : `[staleness] ${upstreamQuiet.length} source${upstreamQuiet.length === 1 ? "" : "s"} quiet upstream`;

  // The lead has to name the provider-health entries when there are any —
  // otherwise the first line an operator reads during a quota shutoff
  // describes those crit rows as merely "overdue", which is the exact
  // misreading this section was added to prevent.
  const quietSuffix =
    upstreamQuiet.length > 0
      ? ` A further ${upstreamQuiet.length} are healthy but quiet upstream (no new releases from the vendor).`
      : "";
  const blocks: EmailBlock[] = [
    {
      t: "p",
      text: hasProviderIssue
        ? `${attention} source(s) need attention — including ${providerActive.length} unable to ingest at all because the AI provider is cut off.${quietSuffix}`
        : attention > 0
          ? `${attention} source(s) need attention.${quietSuffix}`
          : `No sources need attention.${quietSuffix}`,
    },
  ];

  if (providerActive.length > 0) {
    blocks.push({ t: "kicker", text: `Provider health (${providerActive.length})` });
    blocks.push({
      t: "fine",
      text: "Sources whose most recent ingest attempt failed because the AI provider itself is cut off (spend cap or billing shutoff) — not an ordinary transient error. This needs a human to raise the cap or wait out the stated reset; retrying will not help.",
    });
    for (const e of providerActive) {
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

  if (providerAftermath.length > 0) {
    blocks.push({
      t: "kicker",
      text: `Provider outage aftermath (${providerAftermath.length})`,
    });
    blocks.push({
      t: "fine",
      text: "Sources whose last attempt failed during a provider quota shutoff that has since cleared (no quota errors anywhere in the fleet for 24h+). They have not been re-attempted since — change-driven sources only run when their page changes — so the ingest that failed is still missing. Re-fetch these manually to recover it.",
    });
    for (const e of providerAftermath) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `failed ${e.lastAttemptAt} · last evaluated ${e.lastFetchedAt ?? "(never)"} · ${e.sourceId}`,
        url: adminUrl ?? undefined,
        sev: "warn",
      });
    }
  }

  if (opaque.length > 0) {
    blocks.push({ t: "kicker", text: `First-party — possible ingest breakage (${opaque.length})` });
    blocks.push({
      t: "fine",
      text: "Scrape/feed sources with an established cadence that have gone quiet past their overdue window. These pipelines can fail silently — the page or feed may have moved, or extraction may be returning nothing — so a quiet one is worth a manual check.",
    });
    for (const e of opaque) {
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

  if (upstreamQuiet.length > 0) {
    blocks.push({ t: "kicker", text: `Upstream quiet (${upstreamQuiet.length})` });
    blocks.push({
      t: "fine",
      text: "Sources polled through transparent APIs (GitHub releases, App Store, video feeds) with nothing new past their usual cadence. Polling is healthy and succeeding — the vendor simply hasn't shipped. Informational only.",
    });
    for (const e of upstreamQuiet) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `quiet ${e.daysSinceNewest}d · window ${e.windowDays}d · median gap ${e.medianGapDays}d · newest ${e.newestRelease ?? "(never)"} · last seen ${e.lastSeenAt} · ${e.sourceId}`,
        url: adminUrl ?? undefined,
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

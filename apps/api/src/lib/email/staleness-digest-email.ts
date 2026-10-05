/**
 * Admin digest for first-party + Firecrawl source staleness scans.
 */
import type {
  FirecrawlOutage,
  FirecrawlQuietEntry,
  FirecrawlStaleEntry,
} from "../../cron/firecrawl-staleness.js";
import type { StaleSourceEntry } from "../../cron/source-staleness.js";
import type { PushStaleEntry } from "../../cron/push-staleness.js";
import type { ProviderHealthEntry } from "../../cron/provider-health.js";
import { renderEmail, subjectNames, type EmailBlock } from "@releases/rendering/email-shell";

export type StalenessDigestInput = {
  firstParty: StaleSourceEntry[];
  /** Firecrawl sources with no webhook delivery inside their window — a broken pipe. */
  firecrawl: FirecrawlStaleEntry[];
  /**
   * Firecrawl sources still receiving deliveries but with nothing ingested in a
   * while. Informational only — like upstream-quiet, never triggers a send.
   */
  firecrawlQuiet?: FirecrawlQuietEntry[];
  /**
   * Set when all or nearly all Firecrawl sources stopped delivering at once. The
   * cause is shared, so the digest shows one headline instead of N rows.
   */
  firecrawlOutage?: FirecrawlOutage | null;
  /** Push-fed sources (#2381) whose publisher appears to have stopped pushing. */
  pushFed: PushStaleEntry[];
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
 * quiet, dead Firecrawl monitors, and push-fed sources that stopped
 * receiving pushes. Upstream-quiet transparent sources are excluded — they
 * ride along informationally but should never by themselves trigger an
 * email. A push-fed entry IS actionable (unlike upstream-quiet): silence
 * there means the publisher's pipeline broke, not that they simply haven't
 * shipped. `sendStalenessDigest` uses this to decide whether to send.
 */
export function countNeedsAttention(
  input: Pick<StalenessDigestInput, "firstParty" | "firecrawl" | "pushFed" | "providerHealth">,
): number {
  return (
    input.providerHealth.length +
    input.firstParty.filter((e) => !TRANSPARENT_SOURCE_TYPES.has(e.sourceType)).length +
    input.firecrawl.length +
    input.pushFed.length
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

const RECEIVER = "`POST /v1/inbound/firecrawl`";

/** One sentence on what the receiver's own auth-rejection marker says about the cause. */
function outageDiagnosis(outage: FirecrawlOutage): string {
  const r = outage.authRejection;
  if (!r) {
    return `The receiver handler has recorded no auth rejections, so either nothing is reaching it (the route was removed or is gated by middleware before the handler — check the Cloudflare request logs for 401/404 on ${RECEIVER}) or Firecrawl stopped sending (credits, suspended account).`;
  }
  const when = `since ${r.firstAt} (most recent ${r.lastAt})`;
  switch (r.reason) {
    case "secret-unbound":
      return `\`FIRECRAWL_WEBHOOK_SECRET\` is unbound in the API worker, so the receiver rejects every delivery — ${when}.`;
    case "missing":
      return `The receiver has been rejecting deliveries that carry no \`X-Firecrawl-Token\` header ${when}. Re-sync the monitors so their webhook config carries the token again.`;
    case "mismatch":
      return `The receiver has been rejecting deliveries whose \`X-Firecrawl-Token\` doesn't match \`FIRECRAWL_WEBHOOK_SECRET\` ${when}. The secret changed without a monitor re-sync, or the other way round.`;
  }
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
  const firecrawlQuiet = input.firecrawlQuiet ?? [];
  const outage = input.firecrawlOutage ?? null;
  const outageScope = outage
    ? outage.stale === outage.scanned
      ? `all ${outage.scanned}`
      : `${outage.stale} of ${outage.scanned}`
    : "";

  // "Needs attention" is the actionable population: an active provider
  // shutoff, opaque-pipeline sources gone quiet, a cleared outage's missed
  // ingests, and dead Firecrawl monitors. Upstream-quiet transparent sources
  // are appended informationally and deliberately kept out of the headline
  // counts — counting a GitHub repo that simply stopped shipping as a source
  // that "needs attention" made the fleet read far more broken than it is.
  const attention =
    providerActive.length +
    providerAftermath.length +
    opaque.length +
    input.firecrawl.length +
    input.pushFed.length;
  const hasProviderIssue = providerActive.length > 0;
  // Name the orgs that need attention: "4 overdue" alone reads the same every
  // day and says nothing about whether this run needs attention.
  const affected = subjectNames([
    ...providerActive.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...providerAftermath.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...opaque.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...input.firecrawl.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
    ...input.pushFed.map((e) => e.orgName ?? e.orgSlug ?? e.slug),
  ]);
  const subject = hasProviderIssue
    ? `[staleness] provider quota shutoff: ${providerActive.length} source${providerActive.length === 1 ? "" : "s"} unable to ingest${affected ? ` (${affected})` : ""}`
    : outage
      ? `[staleness] Firecrawl deliveries stopped for ${outageScope} sources`
      : attention > 0
        ? `[staleness] ${attention} source${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention${affected ? `: ${affected}` : ""}`
        : `[staleness] ${upstreamQuiet.length} source${upstreamQuiet.length === 1 ? "" : "s"} quiet upstream`;

  // The lead has to name the provider-health entries when there are any —
  // otherwise the first line an operator reads during a quota shutoff
  // describes those crit rows as merely "overdue", which is the exact
  // misreading this section was added to prevent.
  const quietSuffix =
    (upstreamQuiet.length > 0
      ? ` A further ${upstreamQuiet.length} are healthy but quiet upstream (no new releases from the vendor).`
      : "") +
    (firecrawlQuiet.length > 0
      ? ` ${firecrawlQuiet.length} Firecrawl page${firecrawlQuiet.length === 1 ? " is" : "s are"} delivering but unchanged.`
      : "");
  const blocks: EmailBlock[] = [
    {
      t: "p",
      text: hasProviderIssue
        ? `${attention} source(s) need attention — including ${providerActive.length} unable to ingest at all because the AI provider is cut off.${quietSuffix}`
        : outage
          ? `${attention} source(s) need attention — ${outage.stale} of them because Firecrawl deliveries stopped fleet-wide, which points to one shared cause.${quietSuffix}`
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

  if (outage) {
    blocks.push({ t: "kicker", text: `Firecrawl deliveries stopped (${outage.stale})` });
    blocks.push({
      t: "entity",
      coord: "Firecrawl webhook receiver",
      metrics: `no deliveries for ${outageScope} sources · last delivery ${outage.lastDeliveryAt ?? "(never)"} · auth rejections ${outage.authRejection ? `${outage.authRejection.reason}, last ${outage.authRejection.lastAt}` : "none recorded"}`,
      sev: "crit",
    });
    blocks.push({
      t: "p",
      text: `Firecrawl deliveries stopped for ${outageScope} sources${outage.lastDeliveryAt ? ` since ${outage.lastDeliveryAt}` : ""}. Check the receiver route (${RECEIVER}) and \`FIRECRAWL_WEBHOOK_SECRET\`, then the Firecrawl account.`,
    });
    blocks.push({ t: "p", text: outageDiagnosis(outage) });
    blocks.push({
      t: "fine",
      text: `Affected: ${input.firecrawl.map((e) => (e.orgSlug ? `${e.orgSlug}/${e.slug}` : e.slug)).join(", ")}.`,
    });
  } else if (input.firecrawl.length > 0) {
    blocks.push({ t: "kicker", text: `Firecrawl — no deliveries (${input.firecrawl.length})` });
    blocks.push({
      t: "fine",
      text: "Firecrawl-owned sources that have received no webhook delivery inside their window — whether or not the page changed. The monitor may be paused or deleted, or the account out of credits.",
    });
    for (const e of input.firecrawl) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `last delivery ${e.lastDeliveryAt ?? "(not recorded)"} · last ingest ${e.lastFetchedAt ?? "(never)"} · threshold ${e.staleHours}h (${e.thresholdBasis}) · ${e.sourceId}`,
        url: adminUrl ?? undefined,
        sev: "crit",
      });
    }
  }

  if (input.pushFed.length > 0) {
    blocks.push({ t: "kicker", text: `No pushes lately (${input.pushFed.length})` });
    blocks.push({
      t: "fine",
      text: "Push-fed sources whose publisher has gone quiet past their overdue window. The publisher's pipeline may have stopped — check its workflow runs and API token.",
    });
    for (const e of input.pushFed) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `quiet ${e.daysSinceActivity}d · window ${e.windowDays}d · last activity ${e.lastActivityAt} · ${e.sourceId}`,
        url: adminUrl ?? undefined,
        sev: "warn",
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

  if (firecrawlQuiet.length > 0) {
    blocks.push({
      t: "kicker",
      text: `Firecrawl — delivering, unchanged (${firecrawlQuiet.length})`,
    });
    blocks.push({
      t: "fine",
      text: "Monitors are delivering on schedule, but nothing new has been ingested in two weeks or more. The pipe is healthy; the page just hasn't changed. Informational only.",
    });
    for (const e of firecrawlQuiet) {
      const adminUrl = sourceAdminUrl(input.webOrigin, e.orgSlug, e.slug);
      blocks.push({
        t: "entity",
        coord: orgHeadline(e.orgName, e.orgSlug, e.slug),
        metrics: `unchanged ${e.quietDays}d · last delivery ${e.lastDeliveryAt} · last ingest ${e.lastFetchedAt ?? "(never)"} · ${e.sourceId}`,
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
        "Internal daily digest from Releases — sources flagged by the staleness scans (first-party poll path, Firecrawl webhook deliveries, push-fed sources, and provider health).",
      links: [{ label: "Admin status", href: `${input.webOrigin}/admin/status` }],
    },
  });

  return { subject, text, html };
}

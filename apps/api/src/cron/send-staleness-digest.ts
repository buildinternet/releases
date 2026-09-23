/**
 * Daily admin digest: run first-party + Firecrawl staleness scans and email
 * the operator when any sources are overdue. Logging still happens inside each
 * scan; this is the inbox-friendly rollup.
 */
import { logEvent } from "@releases/lib/log-event";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import { scanStaleFirecrawlSources, type FirecrawlStalenessEnv } from "./firecrawl-staleness.js";
import { scanStaleSources, type SourceStalenessEnv } from "./source-staleness.js";
import { scanProviderHealth, type ProviderHealthEnv } from "./provider-health.js";
import { buildStalenessDigestEmail, countNeedsAttention } from "../lib/staleness-digest-email.js";
import { sendEmail, type EmailEnv } from "../lib/email.js";

export type SendStalenessDigestEnv = SourceStalenessEnv &
  FirecrawlStalenessEnv &
  ProviderHealthEnv &
  EmailEnv & {
    WEB_BASE_URL?: string;
  };

function webOrigin(env: SendStalenessDigestEnv): string {
  const raw = releaseWebBase(env);
  try {
    return new URL(raw).origin;
  } catch {
    return "https://releases.sh";
  }
}

export async function sendStalenessDigest(
  env: SendStalenessDigestEnv,
  now: Date = new Date(),
): Promise<{ emailed: boolean; firstParty: number; firecrawl: number; providerHealth: number }> {
  const firstParty = await scanStaleSources(env, now);
  const firecrawl = await scanStaleFirecrawlSources(env, now);
  // scanProviderHealth already fails open internally (any DB/query error is
  // caught and logged there, returning an empty result). This try/catch is
  // defense-in-depth: a provider-health regression must never take down the
  // rest of the digest, which is the entire lesson of the outage this exists
  // to catch.
  let providerHealth: Awaited<ReturnType<typeof scanProviderHealth>>;
  try {
    providerHealth = await scanProviderHealth(env, now);
  } catch (err) {
    logEvent("warn", {
      component: "staleness-digest",
      event: "provider-health-scan-error",
      err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
    });
    providerHealth = { scanned: 0, broken: 0, entries: [], outageActive: false };
  }

  // Send only when something is actionable. Upstream-quiet transparent
  // sources (a GitHub repo that simply stopped shipping) ride along as an
  // informational section but never trigger an email by themselves — a daily
  // "N sources overdue" email whose rows are mostly quiet vendors trained the
  // operator to read the fleet as far more broken than it is.
  const attention = countNeedsAttention({
    firstParty: firstParty.entries,
    firecrawl: firecrawl.entries,
    providerHealth: providerHealth.entries,
  });

  if (attention === 0) {
    logEvent("info", {
      component: "staleness-digest",
      event: "skipped-empty",
      scannedFirstParty: firstParty.scanned,
      scannedFirecrawl: firecrawl.scanned,
      scannedProviderHealth: providerHealth.scanned,
      upstreamQuiet: firstParty.entries.length,
    });
    return { emailed: false, firstParty: 0, firecrawl: 0, providerHealth: 0 };
  }

  const rendered = buildStalenessDigestEmail({
    firstParty: firstParty.entries,
    firecrawl: firecrawl.entries,
    providerHealth: providerHealth.entries,
    providerOutageActive: providerHealth.outageActive,
    webOrigin: webOrigin(env),
    scannedAt: now.toISOString(),
  });

  try {
    const result = await sendEmail(env, {
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.sent) {
      logEvent("info", {
        component: "staleness-digest",
        event: "email-skipped",
        reason: result.reason,
        firstParty: firstParty.entries.length,
        firecrawl: firecrawl.entries.length,
        providerHealth: providerHealth.entries.length,
      });
      return {
        emailed: false,
        firstParty: firstParty.entries.length,
        firecrawl: firecrawl.entries.length,
        providerHealth: providerHealth.entries.length,
      };
    }
    logEvent("info", {
      component: "staleness-digest",
      event: "email-sent",
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
      providerHealth: providerHealth.entries.length,
    });
    return {
      emailed: true,
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
      providerHealth: providerHealth.entries.length,
    };
  } catch (err) {
    logEvent("warn", {
      component: "staleness-digest",
      event: "email-error",
      err,
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
      providerHealth: providerHealth.entries.length,
    });
    return {
      emailed: false,
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
      providerHealth: providerHealth.entries.length,
    };
  }
}

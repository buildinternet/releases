/**
 * Daily admin digest: run first-party + Firecrawl staleness scans and email
 * the operator when any sources are overdue. Logging still happens inside each
 * scan; this is the inbox-friendly rollup.
 */
import { logEvent } from "@releases/lib/log-event";
import { scanStaleFirecrawlSources, type FirecrawlStalenessEnv } from "./firecrawl-staleness.js";
import { scanStaleSources, type SourceStalenessEnv } from "./source-staleness.js";
import { buildStalenessDigestEmail } from "../lib/staleness-digest-email.js";
import { sendEmail, type EmailEnv } from "../lib/email.js";

export type SendStalenessDigestEnv = SourceStalenessEnv &
  FirecrawlStalenessEnv &
  EmailEnv & {
    WEB_BASE_URL?: string;
  };

function webOrigin(env: SendStalenessDigestEnv): string {
  const raw = env.WEB_BASE_URL ?? "https://releases.sh";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://releases.sh";
  }
}

export async function sendStalenessDigest(
  env: SendStalenessDigestEnv,
  now: Date = new Date(),
): Promise<{ emailed: boolean; firstParty: number; firecrawl: number }> {
  const firstParty = await scanStaleSources(env, now);
  const firecrawl = await scanStaleFirecrawlSources(env, now);
  const total = firstParty.entries.length + firecrawl.entries.length;

  if (total === 0) {
    logEvent("info", {
      component: "staleness-digest",
      event: "skipped-empty",
      scannedFirstParty: firstParty.scanned,
      scannedFirecrawl: firecrawl.scanned,
    });
    return { emailed: false, firstParty: 0, firecrawl: 0 };
  }

  const rendered = buildStalenessDigestEmail({
    firstParty: firstParty.entries,
    firecrawl: firecrawl.entries,
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
      });
      return {
        emailed: false,
        firstParty: firstParty.entries.length,
        firecrawl: firecrawl.entries.length,
      };
    }
    logEvent("info", {
      component: "staleness-digest",
      event: "email-sent",
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
    });
    return {
      emailed: true,
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
    };
  } catch (err) {
    logEvent("warn", {
      component: "staleness-digest",
      event: "email-error",
      err,
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
    });
    return {
      emailed: false,
      firstParty: firstParty.entries.length,
      firecrawl: firecrawl.entries.length,
    };
  }
}

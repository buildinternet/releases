import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { createDb } from "../db.js";
import { listDigestRecipients, advanceDigestWatermark } from "../queries/digest-prefs.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { sendDigestEmail } from "../lib/digest-email.js";
import { parsePositiveInt } from "./feed-enrich.js";
import type { AuthEmailBinding } from "../auth/email.js";

export interface SendDigestsEnv {
  DB: D1Database;
  AUTH_EMAIL?: AuthEmailBinding;
  DIGEST_EMAIL_FROM?: string;
  WEB_BASE_URL?: string;
  /** API worker's own public origin — used for unsubscribe URLs. Falls back to https://api.releases.sh. */
  API_BASE_URL?: string;
  MEDIA_ORIGIN?: string;
  FLAGS?: FlagshipBinding;
  DIGEST_EMAILS_ENABLED?: string;
  CRON_ENABLED?: string;
  DIGEST_MAX_PER_RUN?: string;
  DIGEST_MAX_RELEASES?: string;
  ENVIRONMENT?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: ReturnType<typeof createDb>;
}

export interface SendDigestsArgs {
  cadence: "daily" | "weekly";
  runStart: Date;
}

const DEFAULT_MAX_PER_RUN = 500;
const DEFAULT_MAX_RELEASES = 50;

/**
 * Build the absolute unsubscribe URL. Points at the API worker (it serves
 * /v1/digest/unsubscribe/:token). Falls back to the prod host.
 */
function unsubscribeUrlFor(apiOrigin: string, token: string): string {
  return `${apiOrigin}/v1/digest/unsubscribe/${token}`;
}

/**
 * Gather → render → send digests for one cadence. For each verified, subscribed
 * user: select releases published in `(last_digest_at, runStart]` from everything
 * they follow; if none, skip (watermark unchanged); else send and advance the
 * watermark to `runStart`. Per-recipient failures are logged and never abort the
 * loop. Gated by CRON_ENABLED + the digest-emails-enabled flag.
 */
export async function sendDigests(env: SendDigestsEnv, args: SendDigestsArgs): Promise<void> {
  const { cadence, runStart } = args;

  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "digest", event: "cron-disabled", cadence });
    return;
  }
  if (!(await flag(env.FLAGS, env.DIGEST_EMAILS_ENABLED, FLAGS.digestEmailsEnabled))) {
    logEvent("info", { component: "digest", event: "flag-off", cadence });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const maxPerRun = parsePositiveInt(env.DIGEST_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const maxReleases = parsePositiveInt(env.DIGEST_MAX_RELEASES, DEFAULT_MAX_RELEASES);
  const baseUrl = env.WEB_BASE_URL ?? "https://releases.sh";
  const apiOrigin = env.API_BASE_URL ?? "https://api.releases.sh";
  const mediaOrigin = env.MEDIA_ORIGIN ?? "";
  const before = runStart.toISOString();
  const manageUrl = `${baseUrl}/following`;

  const recipients = await listDigestRecipients(db, cadence, maxPerRun);
  let sentCount = 0;
  let emptyCount = 0;
  let failCount = 0;

  for (const recip of recipients) {
    const after = recip.lastDigestAt ? recip.lastDigestAt.toISOString() : null;
    const rows = await getFollowedReleases(db, recip.userId, {
      limit: maxReleases,
      offset: 0,
      publishedAfter: after,
      publishedBefore: before,
    });
    if (rows.length === 0) {
      emptyCount++;
      continue;
    }
    const releaseItems = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));
    const res = await sendDigestEmail(env, {
      to: recip.email,
      recipientName: recip.name,
      cadence,
      releases: releaseItems,
      baseUrl,
      manageUrl,
      unsubscribeUrl: unsubscribeUrlFor(apiOrigin, recip.manageToken),
    });
    if (res.sent) {
      await advanceDigestWatermark(db, recip.userId, runStart);
      sentCount++;
    } else {
      failCount++;
    }
  }

  logEvent("info", {
    component: "digest",
    event: "run-done",
    cadence,
    considered: recipients.length,
    sent: sentCount,
    emptySkipped: emptyCount,
    failed: failCount,
    capped: recipients.length >= maxPerRun,
  });
}

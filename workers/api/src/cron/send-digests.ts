import { logEvent } from "@releases/lib/log-event";
import { createDb, type AnyDb } from "../db.js";
import {
  listDigestRecipients,
  advanceDigestWatermark,
  type DigestRecipient,
} from "../queries/digest-prefs.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { sendDigestEmail, type DigestEmailEnv } from "../lib/digest-email.js";
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
export const DEFAULT_MAX_RELEASES = 50;

/**
 * Build the absolute unsubscribe URL. Points at the API worker (it serves
 * /v1/digest/unsubscribe/:token). Falls back to the prod host.
 */
function unsubscribeUrlFor(apiOrigin: string, token: string): string {
  return `${apiOrigin}/v1/digest/unsubscribe/${token}`;
}

/** The render/send knobs shared by every recipient in a run. */
export interface DigestDeliveryConfig {
  baseUrl: string;
  apiOrigin: string;
  mediaOrigin: string;
  maxReleases: number;
}

/** Resolve the per-run delivery config from the worker env (one place, no drift). */
export function digestDeliveryConfig(env: SendDigestsEnv): DigestDeliveryConfig {
  return {
    baseUrl: env.WEB_BASE_URL ?? "https://releases.sh",
    apiOrigin: env.API_BASE_URL ?? "https://api.releases.sh",
    mediaOrigin: env.MEDIA_ORIGIN ?? "",
    maxReleases: parsePositiveInt(env.DIGEST_MAX_RELEASES, DEFAULT_MAX_RELEASES),
  };
}

/**
 * Gather one recipient's followed releases published in `(after, before]` and
 * email them a single digest. Returns whether mail went out, the release count,
 * and (on no-send) why. Does NOT touch the watermark — the caller decides: the
 * cron advances it on send; the admin test-send route leaves it alone. Shared by
 * the cron loop and the test-send route so both render identically.
 */
export async function gatherAndSendDigest(
  env: DigestEmailEnv,
  db: AnyDb,
  recip: Pick<DigestRecipient, "userId" | "email" | "name" | "manageToken">,
  cadence: "daily" | "weekly",
  opts: DigestDeliveryConfig & { after: string | null; before: string },
): Promise<{ sent: boolean; count: number; reason?: "no_releases" | "no_binding" | "error" }> {
  const rows = await getFollowedReleases(db, recip.userId, {
    limit: opts.maxReleases,
    publishedAfter: opts.after,
    publishedBefore: opts.before,
  });
  if (rows.length === 0) return { sent: false, count: 0, reason: "no_releases" };

  const releaseItems = rows.map((r) => mapLatestRowToReleaseItem(r, opts.mediaOrigin));
  const res = await sendDigestEmail(env, {
    to: recip.email,
    recipientName: recip.name,
    cadence,
    releases: releaseItems,
    baseUrl: opts.baseUrl,
    manageUrl: `${opts.baseUrl}/following`,
    unsubscribeUrl: unsubscribeUrlFor(opts.apiOrigin, recip.manageToken),
  });
  return { sent: res.sent, count: rows.length, reason: res.sent ? undefined : res.reason };
}

/**
 * Gather → render → send digests for one cadence. For each verified, subscribed
 * user: select releases published in `(last_digest_at, runStart]` from everything
 * they follow; if none, skip (watermark unchanged); else send and advance the
 * watermark to `runStart`. Per-recipient failures are logged and never abort the
 * loop. Gated only by CRON_ENABLED — there is no feature flag; the per-user
 * opt-in (cadence defaults to off) is what keeps mail from going out broadly.
 */
export async function sendDigests(env: SendDigestsEnv, args: SendDigestsArgs): Promise<void> {
  const { cadence, runStart } = args;

  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "digest", event: "cron-disabled", cadence });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const maxPerRun = parsePositiveInt(env.DIGEST_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const config = digestDeliveryConfig(env);
  const before = runStart.toISOString();

  const recipients = await listDigestRecipients(db, cadence, maxPerRun);
  let sentCount = 0;
  let emptyCount = 0;
  let failCount = 0;

  for (const recip of recipients) {
    const after = recip.lastDigestAt ? recip.lastDigestAt.toISOString() : null;
    const { sent, reason } = await gatherAndSendDigest(env, db, recip, cadence, {
      ...config,
      after,
      before,
    });
    if (sent) {
      await advanceDigestWatermark(db, recip.userId, runStart);
      sentCount++;
    } else if (reason === "no_releases") {
      emptyCount++;
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

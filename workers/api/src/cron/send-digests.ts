import { logEvent } from "@releases/lib/log-event";
import { createDb, type AnyDb } from "../db.js";
import {
  listDigestRecipients,
  advanceDigestWatermark,
  type DigestRecipient,
} from "../queries/digest-prefs.js";
import {
  getFollowedReleases,
  mapLatestRowToReleaseItem,
  releaseWebBase,
} from "../queries/releases.js";
import { sendDigestEmail, type DigestEmailEnv } from "../lib/digest-email.js";
import { parsePositiveInt } from "./feed-enrich.js";
import type { AuthEmailBinding } from "../auth/email.js";
import { sendDigestBatch } from "../queues/enqueue-release-fanout.js";
import type { DigestDeliveryMessage } from "../queues/types.js";

export interface SendDigestsEnv {
  DB: D1Database;
  DIGEST_DELIVERY_QUEUE?: Queue<DigestDeliveryMessage>;
  AUTH_EMAIL?: AuthEmailBinding;
  DIGEST_EMAIL_FROM?: string;
  WEB_BASE_URL?: string;
  /** API worker's own public origin — used for unsubscribe URLs. Falls back to https://api.releases.sh. */
  API_BASE_URL?: string;
  MEDIA_ORIGIN?: string;
  CRON_ENABLED?: string;
  DIGEST_MAX_PER_RUN?: string;
  DIGEST_MAX_RELEASES?: string;
  DIGEST_PUBLISHED_FLOOR_DAYS?: string;
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
 * How far before the window opens a release may have been *published* and still be
 * mailed. Bounds the blast radius of a history backfill, which lands old posts with
 * a fresh `fetched_at` and would otherwise all qualify as "new to this reader".
 */
export const DEFAULT_PUBLISHED_FLOOR_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  publishedFloorDays: number;
}

/** Resolve the per-run delivery config from the worker env (one place, no drift). */
export function digestDeliveryConfig(env: SendDigestsEnv): DigestDeliveryConfig {
  return {
    baseUrl: releaseWebBase(env),
    apiOrigin: env.API_BASE_URL ?? "https://api.releases.sh",
    mediaOrigin: env.MEDIA_ORIGIN ?? "",
    maxReleases: parsePositiveInt(env.DIGEST_MAX_RELEASES, DEFAULT_MAX_RELEASES),
    publishedFloorDays: parsePositiveInt(
      env.DIGEST_PUBLISHED_FLOOR_DAYS,
      DEFAULT_PUBLISHED_FLOOR_DAYS,
    ),
  };
}

/**
 * The publish-date floor for a window opening at `after` (or, on a reader's first
 * digest, at `before`). Anchored to the window's own start rather than the run
 * instant, so widening the window — an operator's `sinceDays`, or a watermark that
 * stalled because the reader had an empty day — widens the floor with it instead
 * of silently clipping the extra days.
 */
function publishedFloorFor(after: string | null, before: string, floorDays: number): string | null {
  const anchor = Date.parse(after ?? before);
  if (Number.isNaN(anchor)) return null;
  return new Date(anchor - floorDays * DAY_MS).toISOString();
}

/**
 * Gather one recipient's followed releases INGESTED in `(after, before]` and email
 * them a single digest. Returns whether mail went out, the release count, and (on
 * no-send) why. Does NOT touch the watermark — the caller decides: the cron advances
 * it on send; the admin test-send route leaves it alone. Shared by the cron loop and
 * the test-send route so both render identically.
 *
 * The window is on ingest time, not publish time. Because the watermark advances to
 * `runStart` on every send, a publish-time window silently dropped anything we
 * ingested after the run that fired for its publish date — the lag between a post
 * going live and our fetch picking it up. That hole swallowed editorial feed/scrape
 * posts (hours of lag) while sparing GitHub tags (fetched within the hour), so
 * digests skewed toward SDK churn. Windowing on `fetched_at` delivers every row
 * exactly once, on the first run after we saw it.
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
    fetchedAfter: opts.after,
    fetchedBefore: opts.before,
    publishedFloor: publishedFloorFor(opts.after, opts.before, opts.publishedFloorDays),
  });
  if (rows.length === 0) return { sent: false, count: 0, reason: "no_releases" };

  const releaseItems = rows.map((r) =>
    mapLatestRowToReleaseItem(r, opts.mediaOrigin, opts.baseUrl),
  );
  const res = await sendDigestEmail(env, {
    to: recip.email,
    recipientName: recip.name,
    cadence,
    releases: releaseItems,
    baseUrl: opts.baseUrl,
    manageUrl: `${opts.baseUrl}/following`,
    unsubscribeUrl: unsubscribeUrlFor(opts.apiOrigin, recip.manageToken),
    // End of the covered window (the run start) — dates the subject/title.
    referenceDate: opts.before,
  });
  return { sent: res.sent, count: rows.length, reason: res.sent ? undefined : res.reason };
}

/**
 * Inline gather → send loop (fallback when digest-delivery queue is unbound).
 */
export async function sendDigestsInline(env: SendDigestsEnv, args: SendDigestsArgs): Promise<void> {
  const { cadence, runStart } = args;
  const db = env._drizzleOverride ?? createDb(env.DB);
  const config = digestDeliveryConfig(env);
  const before = runStart.toISOString();

  const recipients = await listDigestRecipients(
    db,
    cadence,
    parsePositiveInt(env.DIGEST_MAX_PER_RUN, DEFAULT_MAX_PER_RUN),
  );
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
    mode: "inline",
    considered: recipients.length,
    sent: sentCount,
    emptySkipped: emptyCount,
    failed: failCount,
    capped: recipients.length >= parsePositiveInt(env.DIGEST_MAX_PER_RUN, DEFAULT_MAX_PER_RUN),
  });
}

/**
 * Gather → render → send digests for one cadence. When `DIGEST_DELIVERY_QUEUE`
 * is bound, enqueues one message per recipient for the queue consumer; otherwise
 * falls back to the inline loop (local dev / tests). Gated only by
 * CRON_ENABLED — per-user opt-in (cadence defaults to off) is the volume gate.
 */
export async function sendDigests(env: SendDigestsEnv, args: SendDigestsArgs): Promise<void> {
  const { cadence, runStart } = args;

  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "digest", event: "cron-disabled", cadence });
    return;
  }

  if (!env.DIGEST_DELIVERY_QUEUE) {
    await sendDigestsInline(env, args);
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const maxPerRun = parsePositiveInt(env.DIGEST_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const recipients = await listDigestRecipients(db, cadence, maxPerRun);
  const messages: DigestDeliveryMessage[] = recipients.map((recip) => ({
    userId: recip.userId,
    cadence,
    runStart: runStart.toISOString(),
    after: recip.lastDigestAt ? recip.lastDigestAt.toISOString() : null,
  }));

  try {
    await sendDigestBatch(env.DIGEST_DELIVERY_QUEUE, messages);
  } catch (err) {
    logEvent("warn", {
      component: "digest",
      event: "enqueue-failed",
      cadence,
      err: err instanceof Error ? err : String(err),
    });
    await sendDigestsInline(env, args);
    return;
  }

  logEvent("info", {
    component: "digest",
    event: "run-done",
    cadence,
    mode: "queued",
    enqueued: messages.length,
    capped: recipients.length >= maxPerRun,
  });
}

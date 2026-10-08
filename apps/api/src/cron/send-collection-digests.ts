import { eq } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import { collections } from "@buildinternet/releases-core/schema";
import { createDb, type AnyDb } from "../db.js";
import {
  buildCollectionWeeklyDigestDetail,
  getCollectionWeeklyDigest,
} from "../queries/collection-summaries.js";
import {
  claimCollectionDigestSend,
  getCollectionDigestRecipient,
  listCollectionDigestRecipientIds,
  releaseCollectionDigestSend,
} from "../queries/collection-digest-subs.js";
import { releaseWebBase } from "../queries/releases.js";
import { sendCollectionDigestEmail } from "../lib/email/collection-digest-email.js";
import type { AuthEmailBinding } from "../auth/email.js";
import { sendDigestBatch } from "../queues/enqueue-release-fanout.js";
import type { CollectionDigestDeliveryMessage, DigestQueueMessage } from "../queues/types.js";

/**
 * Collection weekly digest emails (#2459). The collection-summaries workflow calls
 * `sendCollectionDigests` once, for the digests it just wrote for the just-closed
 * week; it never runs for catch-up weeks, `force` regens, or the backfill route.
 * Each subscriber becomes one `collection-digest` message on the digest-delivery
 * queue (or an inline send when the queue isn't bound).
 */

export interface SendCollectionDigestsEnv {
  DB: D1Database;
  DIGEST_DELIVERY_QUEUE?: Queue<DigestQueueMessage>;
  AUTH_EMAIL?: AuthEmailBinding;
  DIGEST_EMAIL_FROM?: string;
  WEB_BASE_URL?: string;
  /** API worker's public origin, for unsubscribe URLs. Falls back to https://api.releases.sh. */
  API_BASE_URL?: string;
  CRON_ENABLED?: string;
  ENVIRONMENT?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: AnyDb;
}

/** A digest a run just wrote, by collection id. */
export interface NewCollectionDigest {
  collectionId: string;
  weekStart: string;
}

function collectionUnsubscribeUrl(apiOrigin: string, token: string, slug: string): string {
  return `${apiOrigin}/v1/digest/unsubscribe/${token}?collection=${encodeURIComponent(slug)}`;
}

/**
 * Send one subscriber one collection digest. Claims the week before sending so a
 * redelivered or duplicated message can't mail twice; a failed send releases the
 * claim and asks for a retry.
 */
export async function processCollectionDigestMessage(
  env: SendCollectionDigestsEnv,
  body: CollectionDigestDeliveryMessage,
): Promise<"ack" | "retry"> {
  const log = { userId: body.userId, collectionId: body.collectionId, weekStart: body.weekStart };
  try {
    const db: AnyDb = env._drizzleOverride ?? createDb(env.DB);
    const [col] = await db
      .select({ slug: collections.slug, name: collections.name })
      .from(collections)
      .where(eq(collections.id, body.collectionId));
    const digest = col
      ? await getCollectionWeeklyDigest(db, body.collectionId, body.weekStart)
      : null;
    const recip = digest
      ? await getCollectionDigestRecipient(db, body.userId, body.collectionId)
      : null;
    if (!col || !digest || !recip) {
      logEvent("info", { component: "collection-digest-queue", event: "skipped", ...log });
      return "ack";
    }

    const claimed =
      (recip.lastSentWeek === null || recip.lastSentWeek < body.weekStart) &&
      (await claimCollectionDigestSend(
        db,
        body.userId,
        body.collectionId,
        body.weekStart,
        recip.lastSentWeek,
      ));
    if (!claimed) {
      logEvent("info", {
        component: "collection-digest-queue",
        event: "skipped",
        reason: "already_sent",
        ...log,
      });
      return "ack";
    }

    const detail = await buildCollectionWeeklyDigestDetail(db, digest);
    const res = await sendCollectionDigestEmail(env, {
      to: recip.email,
      collection: col,
      digest: detail,
      baseUrl: releaseWebBase(env),
      unsubscribeUrl: collectionUnsubscribeUrl(
        env.API_BASE_URL ?? "https://api.releases.sh",
        recip.manageToken,
        col.slug,
      ),
    });
    if (res.sent) {
      logEvent("info", { component: "collection-digest-queue", event: "sent", ...log });
      return "ack";
    }
    await releaseCollectionDigestSend(
      db,
      body.userId,
      body.collectionId,
      body.weekStart,
      recip.lastSentWeek,
    );
    logEvent("warn", {
      component: "collection-digest-queue",
      event: "send-failed",
      reason: res.reason ?? "error",
      ...log,
    });
    return "retry";
  } catch (err) {
    logEvent("warn", {
      component: "collection-digest-queue",
      event: "process-failed",
      ...log,
      err: err instanceof Error ? err : String(err),
    });
    return "retry";
  }
}

/**
 * Fan out the digests a run just wrote to their subscribers. Never throws: a
 * failure is logged and the digests stay unsent (the next run won't resend old
 * weeks, so an operator re-triggers by hand if it matters).
 */
export async function sendCollectionDigests(
  env: SendCollectionDigestsEnv,
  digests: NewCollectionDigest[],
  opts?: { db?: AnyDb },
): Promise<{ enqueued: number; mode: "queued" | "inline" | "disabled" }> {
  if (env.CRON_ENABLED === "false") return { enqueued: 0, mode: "disabled" };
  if (digests.length === 0)
    return { enqueued: 0, mode: env.DIGEST_DELIVERY_QUEUE ? "queued" : "inline" };
  try {
    const db: AnyDb = opts?.db ?? env._drizzleOverride ?? createDb(env.DB);
    const messages: CollectionDigestDeliveryMessage[] = [];
    for (const d of digests) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of collections per run
      const userIds = await listCollectionDigestRecipientIds(db, d.collectionId, d.weekStart);
      for (const userId of userIds) {
        messages.push({ kind: "collection-digest", userId, ...d });
      }
    }

    if (env.DIGEST_DELIVERY_QUEUE) {
      await sendDigestBatch(env.DIGEST_DELIVERY_QUEUE, messages);
    } else {
      for (const m of messages) {
        // oxlint-disable-next-line no-await-in-loop -- inline fallback, sequential sends
        await processCollectionDigestMessage({ ...env, _drizzleOverride: db }, m);
      }
    }
    const mode = env.DIGEST_DELIVERY_QUEUE ? "queued" : "inline";
    logEvent("info", {
      component: "collection-digest",
      event: "run-done",
      mode,
      digests: digests.length,
      enqueued: messages.length,
    });
    return { enqueued: messages.length, mode };
  } catch (err) {
    logEvent("error", {
      component: "collection-digest",
      event: "fanout-failed",
      digests,
      err: err instanceof Error ? err : String(err),
    });
    return { enqueued: 0, mode: env.DIGEST_DELIVERY_QUEUE ? "queued" : "inline" };
  }
}

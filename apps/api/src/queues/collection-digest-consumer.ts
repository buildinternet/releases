import { eq } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import { collections } from "@buildinternet/releases-core/schema";
import type { CollectionWeeklyDigestDetail } from "@buildinternet/releases-api-types";
import { createDb, type AnyDb } from "../db.js";
import {
  buildCollectionWeeklyDigestDetail,
  getCollectionWeeklyDigest,
} from "../queries/collection-summaries.js";
import {
  claimCollectionDigestSend,
  getCollectionDigestRecipient,
  releaseCollectionDigestSend,
} from "../queries/collection-digest-subs.js";
import { releaseWebBase } from "../queries/releases.js";
import { sendCollectionDigestEmail } from "../lib/email/collection-digest-email.js";
import { unsubscribeUrlFor, type SendDigestsEnv } from "../cron/send-digests.js";
import type { CollectionDigestDeliveryMessage } from "./types.js";

export type CollectionDigestConsumerEnv = Pick<
  SendDigestsEnv,
  | "DB"
  | "DIGEST_DELIVERY_QUEUE"
  | "AUTH_EMAIL"
  | "DIGEST_EMAIL_FROM"
  | "WEB_BASE_URL"
  | "API_BASE_URL"
  | "CRON_ENABLED"
  | "ENVIRONMENT"
> & {
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: AnyDb;
};

/** The parts of one week's email every subscriber shares. */
interface WeekPayload {
  collection: { slug: string; name: string };
  digest: CollectionWeeklyDigestDetail;
}

/**
 * Per-batch memo of `WeekPayload` by `collectionId:weekStart`, so a batch of
 * subscribers to the same digest loads and hydrates it once. Holds promises so
 * concurrent lookups share one load.
 */
export type WeekPayloadCache = Map<string, Promise<WeekPayload | null>>;

async function loadWeek(
  db: AnyDb,
  collectionId: string,
  weekStart: string,
): Promise<WeekPayload | null> {
  const [[col], digest] = await Promise.all([
    db
      .select({ slug: collections.slug, name: collections.name })
      .from(collections)
      .where(eq(collections.id, collectionId)),
    getCollectionWeeklyDigest(db, collectionId, weekStart),
  ]);
  if (!col || !digest) return null;
  return { collection: col, digest: await buildCollectionWeeklyDigestDetail(db, digest) };
}

/**
 * Send one subscriber one collection digest (#2459). Claims the week before
 * sending so a redelivered or duplicated message can't mail twice; a failed send
 * releases the claim and asks for a retry.
 */
export async function processCollectionDigestMessage(
  env: CollectionDigestConsumerEnv,
  body: CollectionDigestDeliveryMessage,
  cache: WeekPayloadCache = new Map(),
): Promise<"ack" | "retry"> {
  const { userId, collectionId, weekStart } = body;
  const log = { component: "collection-digest-queue", userId, collectionId, weekStart };
  const skip = (reason: string): "ack" => {
    logEvent("info", { ...log, event: "skipped", reason });
    return "ack";
  };

  try {
    const db: AnyDb = env._drizzleOverride ?? createDb(env.DB);
    const recip = await getCollectionDigestRecipient(db, userId, collectionId);
    if (!recip) return skip("not_subscribed");
    if (recip.lastSentWeek !== null && recip.lastSentWeek >= weekStart) {
      return skip("already_sent");
    }

    const key = `${collectionId}:${weekStart}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = loadWeek(db, collectionId, weekStart);
      cache.set(key, pending);
    }
    const week = await pending;
    if (!week) return skip("no_digest");

    if (!(await claimCollectionDigestSend(db, userId, collectionId, weekStart))) {
      return skip("already_sent");
    }

    const res = await sendCollectionDigestEmail(env, {
      to: recip.email,
      ...week,
      baseUrl: releaseWebBase(env),
      unsubscribeUrl: unsubscribeUrlFor(
        env.API_BASE_URL ?? "https://api.releases.sh",
        recip.manageToken,
        week.collection.slug,
      ),
    });
    if (res.sent) return "ack";

    await releaseCollectionDigestSend(db, userId, collectionId, weekStart, recip.lastSentWeek);
    logEvent("warn", { ...log, event: "send-failed", reason: res.reason ?? "error" });
    return "retry";
  } catch (err) {
    logEvent("warn", {
      ...log,
      event: "process-failed",
      err: err instanceof Error ? err : String(err),
    });
    return "retry";
  }
}

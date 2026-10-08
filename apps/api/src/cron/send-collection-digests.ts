import { logEvent } from "@releases/lib/log-event";
import { createDb, type AnyDb } from "../db.js";
import { listCollectionDigestRecipientIds } from "../queries/collection-digest-subs.js";
import { sendDigestBatch } from "../queues/enqueue-release-fanout.js";
import {
  processCollectionDigestMessage,
  type CollectionDigestConsumerEnv,
  type WeekPayloadCache,
} from "../queues/collection-digest-consumer.js";
import type { CollectionDigestDeliveryMessage } from "../queues/types.js";
import { addDaysToDateKey, etWeekStart } from "@buildinternet/releases-core/dates";

/**
 * Collection weekly digest emails (#2459). The collection-summaries run hands
 * over every digest it just wrote; only the just-closed week's are mailed, so
 * catch-up weeks never email anyone (and `force` regens / the backfill route
 * never call this). Each subscriber becomes one `collection-digest` message on
 * the digest-delivery queue, or an inline send when the queue isn't bound.
 */

export type SendCollectionDigestsEnv = CollectionDigestConsumerEnv;

/**
 * Fan out the run's new digests to their subscribers. Never throws: a failure
 * is logged and the week stays unsent (later runs don't resend old weeks).
 */
export async function sendCollectionDigests(
  env: SendCollectionDigestsEnv,
  digested: ReadonlyArray<{ collectionId: string; weekStart: string }>,
  todayEt: string,
): Promise<{ enqueued: number; mode: "queued" | "inline" | "disabled" }> {
  if (env.CRON_ENABLED === "false") return { enqueued: 0, mode: "disabled" };
  const mode = env.DIGEST_DELIVERY_QUEUE ? "queued" : "inline";
  const justClosed = addDaysToDateKey(etWeekStart(todayEt), -7);
  const digests = digested.filter((d) => d.weekStart === justClosed);
  if (digests.length === 0) return { enqueued: 0, mode };

  try {
    const db: AnyDb = env._drizzleOverride ?? createDb(env.DB);
    const perDigest = await Promise.all(
      digests.map(async ({ collectionId, weekStart }) =>
        (await listCollectionDigestRecipientIds(db, collectionId, weekStart)).map(
          (userId): CollectionDigestDeliveryMessage => ({
            kind: "collection-digest",
            userId,
            collectionId,
            weekStart,
          }),
        ),
      ),
    );
    const messages = perDigest.flat();

    if (env.DIGEST_DELIVERY_QUEUE) {
      await sendDigestBatch(env.DIGEST_DELIVERY_QUEUE, messages);
    } else {
      const inlineEnv = { ...env, _drizzleOverride: db };
      const cache: WeekPayloadCache = new Map();
      for (const m of messages) {
        // oxlint-disable-next-line no-await-in-loop -- inline fallback, sequential sends
        await processCollectionDigestMessage(inlineEnv, m, cache);
      }
    }
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
    return { enqueued: 0, mode };
  }
}

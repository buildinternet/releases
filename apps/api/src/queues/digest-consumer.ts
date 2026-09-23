import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { advanceDigestWatermark, getDigestRecipientByUserId } from "../queries/digest-prefs.js";
import {
  digestDeliveryConfig,
  gatherAndSendDigest,
  type SendDigestsEnv,
} from "../cron/send-digests.js";
import type { DigestDeliveryMessage } from "./types.js";

export type DigestConsumerEnv = SendDigestsEnv;

/**
 * Process one digest-delivery queue message: gather followed releases, send
 * email, advance watermark on success. Idempotent across retries — if the
 * watermark already reached `runStart`, ack without re-sending.
 */
export async function processDigestDeliveryMessage(
  env: DigestConsumerEnv,
  body: DigestDeliveryMessage,
): Promise<"ack" | "retry"> {
  try {
    const db = env._drizzleOverride ?? createDb(env.DB);
    const runStart = new Date(body.runStart);
    if (Number.isNaN(runStart.getTime())) {
      logEvent("warn", {
        component: "digest-queue",
        event: "invalid-run-start",
        userId: body.userId,
        runStart: body.runStart,
      });
      return "ack";
    }

    const recip = await getDigestRecipientByUserId(db, body.userId, body.cadence);
    if (!recip) {
      logEvent("info", {
        component: "digest-queue",
        event: "skipped",
        reason: "not_due",
        userId: body.userId,
        cadence: body.cadence,
      });
      return "ack";
    }

    if (recip.lastDigestAt && recip.lastDigestAt.getTime() >= runStart.getTime()) {
      logEvent("info", {
        component: "digest-queue",
        event: "skipped",
        reason: "already_sent",
        userId: body.userId,
        cadence: body.cadence,
      });
      return "ack";
    }

    const config = digestDeliveryConfig(env);
    const { sent, reason } = await gatherAndSendDigest(env, db, recip, body.cadence, {
      ...config,
      after: body.after,
      before: body.runStart,
    });

    if (sent) {
      await advanceDigestWatermark(db, body.userId, runStart);
      logEvent("info", {
        component: "digest-queue",
        event: "sent",
        userId: body.userId,
        cadence: body.cadence,
      });
      return "ack";
    }

    if (reason === "no_releases") {
      logEvent("info", {
        component: "digest-queue",
        event: "skipped",
        reason: "no_releases",
        userId: body.userId,
        cadence: body.cadence,
      });
      return "ack";
    }

    logEvent("warn", {
      component: "digest-queue",
      event: "send-failed",
      userId: body.userId,
      cadence: body.cadence,
      reason: reason ?? "error",
    });
    return "retry";
  } catch (err) {
    logEvent("warn", {
      component: "digest-queue",
      event: "process-failed",
      userId: body.userId,
      cadence: body.cadence,
      err: err instanceof Error ? err : String(err),
    });
    return "retry";
  }
}

/**
 * Dev/admin on-demand digest test-send. Root-key gated via the `admin/digest`
 * namespace in route-namespaces.ts (every method requires `authMiddleware`).
 *
 *   POST /v1/admin/digest/test
 *   { userId?, email?, cadence?: "daily"|"weekly", sinceDays?: number, advanceWatermark?: boolean }
 *
 * Sends a single digest to one user *right now*, bypassing the cron schedule,
 * the `digest-emails-enabled` flag, and the email-verified filter — it's an
 * explicit operator action for testing the render + delivery path. The lookback
 * window is `sinceDays` (default 7), independent of the user's real watermark;
 * the watermark is left untouched unless `advanceWatermark: true` is passed, so
 * the same test can be re-run repeatedly.
 */
import { Hono } from "hono";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { resolveDigestTestRecipient, advanceDigestWatermark } from "../queries/digest-prefs.js";
import { gatherAndSendDigest, digestDeliveryConfig } from "../cron/send-digests.js";
import type { Env } from "../index.js";

export const adminDigestRoutes = new Hono<Env>();

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_DAYS = 7;

interface TestBody {
  userId?: unknown;
  email?: unknown;
  cadence?: unknown;
  sinceDays?: unknown;
  advanceWatermark?: unknown;
}

adminDigestRoutes.post("/admin/digest/test", async (c) => {
  const body = await c.req.json<TestBody>().catch(() => ({}) as TestBody);

  const userId = typeof body.userId === "string" && body.userId ? body.userId : undefined;
  const email = typeof body.email === "string" && body.email ? body.email : undefined;
  if (!userId && !email) {
    return c.json({ error: "bad_request", message: "userId or email is required" }, 400);
  }

  const cadence = body.cadence === "weekly" ? "weekly" : "daily";

  let sinceDays = DEFAULT_SINCE_DAYS;
  if (body.sinceDays !== undefined) {
    if (
      typeof body.sinceDays !== "number" ||
      !Number.isFinite(body.sinceDays) ||
      body.sinceDays <= 0
    ) {
      return c.json({ error: "bad_request", message: "sinceDays must be a positive number" }, 400);
    }
    sinceDays = body.sinceDays;
  }
  const advanceWatermark = body.advanceWatermark === true;

  const db = createDb(c.env.DB);
  const recip = await resolveDigestTestRecipient(db, { userId, email });
  if (!recip) return c.json({ error: "not_found", message: "User not found" }, 404);

  const before = new Date();
  const after = new Date(before.getTime() - sinceDays * DAY_MS);
  const result = await gatherAndSendDigest(c.env, db, recip, cadence, {
    ...digestDeliveryConfig(c.env),
    after: after.toISOString(),
    before: before.toISOString(),
  });

  if (result.sent && advanceWatermark) {
    await advanceDigestWatermark(db, recip.userId, before);
  }

  logEvent("info", {
    component: "digest",
    event: "test-send",
    message: `Admin test digest to ${recip.email}: sent=${result.sent}`,
    cadence,
    sinceDays,
    count: result.count,
    reason: result.reason,
    environment: c.env.ENVIRONMENT,
  });

  return c.json({
    sent: result.sent,
    to: recip.email,
    userId: recip.userId,
    cadence,
    sinceDays,
    releaseCount: result.count,
    advancedWatermark: result.sent && advanceWatermark,
    reason: result.reason,
  });
});

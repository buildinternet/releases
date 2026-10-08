/**
 * Dev/admin on-demand digest test-send. Root-key gated via the `admin/digest`
 * namespace in route-namespaces.ts (every method requires `authMiddleware`).
 *
 *   POST /v1/admin/digest/test
 *   { userId?, email?, cadence?: "daily"|"weekly", sinceDays?: number, advanceWatermark?: boolean }
 *
 * Sends a single digest to one user *right now*, bypassing the cron schedule
 * and the email-verified filter — it's an explicit operator action for testing
 * the render + delivery path. The lookback
 * window is `sinceDays` (default 7), independent of the user's real watermark;
 * the watermark is left untouched unless `advanceWatermark: true` is passed, so
 * the same test can be re-run repeatedly.
 *
 *   POST /v1/admin/digest/collection-test
 *   { collectionSlug, weekStart?, userId?, email? }
 *
 * Renders and sends a REAL collection weekly digest (the same load + render the
 * Monday queue consumer uses) to one user. `weekStart` (YYYY-MM-DD, an ET
 * Monday) defaults to the collection's latest digest. The recipient need not be
 * subscribed, and no subscription row / `last_sent_week` is read or written, so
 * it can be re-run freely before the real send.
 */
import { Hono } from "hono";
import { parseJsonBody } from "../lib/json-body.js";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { resolveDigestTestRecipient, advanceDigestWatermark } from "../queries/digest-prefs.js";
import { gatherAndSendDigest, digestDeliveryConfig } from "../cron/send-digests.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, ValidationError } from "@releases/lib/releases-error";
import { eq } from "drizzle-orm";
import { collections } from "@buildinternet/releases-core/schema";
import {
  buildCollectionWeeklyDigestDetail,
  getCollectionWeeklyDigest,
  getLatestCollectionWeeklyDigest,
} from "../queries/collection-summaries.js";
import {
  buildCollectionDigestEmail,
  sendCollectionDigestEmail,
} from "../lib/email/collection-digest-email.js";
import { unsubscribeUrlFor } from "../cron/send-digests.js";

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
  const body = await parseJsonBody<TestBody>(c);

  const userId = typeof body.userId === "string" && body.userId ? body.userId : undefined;
  const email = typeof body.email === "string" && body.email ? body.email : undefined;
  if (!userId && !email) {
    return respondError(
      c,
      new ValidationError("userId or email is required", { code: "bad_request" }),
    );
  }

  const cadence = body.cadence === "weekly" ? "weekly" : "daily";

  let sinceDays = DEFAULT_SINCE_DAYS;
  if (body.sinceDays !== undefined) {
    if (
      typeof body.sinceDays !== "number" ||
      !Number.isFinite(body.sinceDays) ||
      body.sinceDays <= 0
    ) {
      return respondError(
        c,
        new ValidationError("sinceDays must be a positive number", { code: "bad_request" }),
      );
    }
    sinceDays = body.sinceDays;
  }
  const advanceWatermark = body.advanceWatermark === true;

  const db = createDb(c.env.DB);
  const recip = await resolveDigestTestRecipient(db, { userId, email });
  if (!recip) return respondError(c, new NotFoundError("User not found"));

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

interface CollectionTestBody {
  collectionSlug?: unknown;
  weekStart?: unknown;
  userId?: unknown;
  email?: unknown;
}

adminDigestRoutes.post("/admin/digest/collection-test", async (c) => {
  const body = await parseJsonBody<CollectionTestBody>(c);

  const collectionSlug =
    typeof body.collectionSlug === "string" && body.collectionSlug
      ? body.collectionSlug.trim()
      : undefined;
  if (!collectionSlug) {
    return respondError(
      c,
      new ValidationError("collectionSlug is required", { code: "bad_request" }),
    );
  }
  const userId = typeof body.userId === "string" && body.userId ? body.userId : undefined;
  const email = typeof body.email === "string" && body.email ? body.email : undefined;
  if (!userId && !email) {
    return respondError(
      c,
      new ValidationError("userId or email is required", { code: "bad_request" }),
    );
  }
  let weekStart: string | undefined;
  if (body.weekStart !== undefined && body.weekStart !== "") {
    if (typeof body.weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.weekStart)) {
      return respondError(
        c,
        new ValidationError("weekStart must be a YYYY-MM-DD date", { code: "bad_request" }),
      );
    }
    weekStart = body.weekStart;
  }

  const db = createDb(c.env.DB);
  const [col] = await db
    .select({ id: collections.id, slug: collections.slug, name: collections.name })
    .from(collections)
    .where(eq(collections.slug, collectionSlug));
  if (!col) return respondError(c, new NotFoundError("Collection not found"));

  const row = weekStart
    ? await getCollectionWeeklyDigest(db, col.id, weekStart)
    : await getLatestCollectionWeeklyDigest(db, col.id);
  if (!row) {
    return respondError(
      c,
      new NotFoundError(
        weekStart
          ? `No weekly digest for ${col.slug} on ${weekStart}`
          : `No weekly digest for ${col.slug}`,
      ),
    );
  }

  const recip = await resolveDigestTestRecipient(db, { userId, email });
  if (!recip) return respondError(c, new NotFoundError("User not found"));

  const config = digestDeliveryConfig(c.env);
  const digest = await buildCollectionWeeklyDigestDetail(db, row);
  const res = await sendCollectionDigestEmail(c.env, {
    to: recip.email,
    collection: { slug: col.slug, name: col.name },
    digest,
    baseUrl: config.baseUrl,
    unsubscribeUrl: unsubscribeUrlFor(config.apiOrigin, recip.manageToken, col.slug),
  });

  logEvent("info", {
    component: "collection-digest",
    event: "test-send",
    message: `Admin test collection digest ${col.slug} ${row.weekStart} to ${recip.email}: sent=${res.sent}`,
    collection: col.slug,
    weekStart: row.weekStart,
    releaseCount: digest.releases.length,
    reason: res.reason,
    environment: c.env.ENVIRONMENT,
  });

  return c.json({
    sent: res.sent,
    to: recip.email,
    userId: recip.userId,
    collectionSlug: col.slug,
    weekStart: row.weekStart,
    subject: buildCollectionDigestEmail({
      collection: { slug: col.slug, name: col.name },
      digest,
      baseUrl: config.baseUrl,
      unsubscribeUrl: "",
    }).subject,
    releaseCount: digest.releases.length,
    reason: res.reason,
  });
});

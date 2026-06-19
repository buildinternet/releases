import { eq, and, inArray } from "drizzle-orm";
import {
  webhookSubscriptions,
  type WebhookSubscription,
} from "@buildinternet/releases-core/schema";
import { userFollows } from "../db/schema-follows.js";
import { foldUserFollowRows, type UserFollowTargets } from "./follows-match.js";
import type { D1Db } from "../db.js";

export type WebhookSubscriptionUpdates = Partial<{
  url: string;
  description: string | null;
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  failureStreakStartedAt: string | null;
  sourceId: string | null;
  productId: string | null;
  releaseType: "feature" | "rollup" | null;
}>;

/**
 * Worker-local copy of `matchWebhookSubscriptions` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 *
 * Returns enabled subscriptions for any of the given orgIds. The publisher
 * then matches each event against these in memory using sourceId.
 */
export async function matchWebhookSubscriptions(
  db: D1Db,
  orgIds: string[],
): Promise<WebhookSubscription[]> {
  if (orgIds.length === 0) return [];
  return db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.enabled, true),
        eq(webhookSubscriptions.scope, "org"),
        inArray(webhookSubscriptions.orgId, orgIds),
      ),
    );
}

/** Enabled follows-scoped self-serve subscriptions (org_id is null). */
export async function matchFollowsScopedWebhookSubscriptions(
  db: D1Db,
): Promise<WebhookSubscription[]> {
  return db
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.enabled, true), eq(webhookSubscriptions.scope, "follows")));
}

/** Batch-load follow targets for webhook fan-out. */
export async function loadFollowTargetsForUsers(
  db: D1Db,
  userIds: string[],
): Promise<Map<string, UserFollowTargets>> {
  if (userIds.length === 0) return new Map();
  const unique = [...new Set(userIds)];
  const rows = await db
    .select({
      userId: userFollows.userId,
      targetType: userFollows.targetType,
      targetId: userFollows.targetId,
    })
    .from(userFollows)
    .where(inArray(userFollows.userId, unique));
  return foldUserFollowRows(rows);
}

/**
 * Worker-local copy of `insertWebhookSubscription` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 */
export async function insertWebhookSubscription(
  db: D1Db,
  input: {
    scope?: "org" | "follows";
    orgId: string | null;
    url: string;
    sourceId: string | null;
    productId?: string | null;
    releaseType?: "feature" | "rollup" | null;
    description: string | null;
    userId?: string | null;
  },
): Promise<WebhookSubscription> {
  const scope = input.scope ?? "org";
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({
      scope,
      orgId: input.orgId,
      url: input.url,
      sourceId: scope === "follows" ? null : input.sourceId,
      productId: scope === "follows" ? null : (input.productId ?? null),
      releaseType: input.releaseType ?? null,
      description: input.description,
      userId: input.userId ?? null,
    })
    .returning();
  return row;
}

/**
 * Worker-local copy of `getWebhookSubscriptionById` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 */
export async function getWebhookSubscriptionById(
  db: D1Db,
  id: string,
): Promise<WebhookSubscription | null> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Worker-local copy of `listWebhookSubscriptionsByOrg` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 */
export async function listWebhookSubscriptionsByOrg(
  db: D1Db,
  orgId: string,
  opts?: { enabledOnly?: boolean },
): Promise<WebhookSubscription[]> {
  if (opts?.enabledOnly) {
    return db
      .select()
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.enabled, true)));
  }
  return db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, orgId));
}

/**
 * Worker-local partial update. Returns null when id matches no row.
 * D1 UPDATE on a missing row is a no-op, so re-fetching tells us both
 * "current state" and "did the row exist" in one round-trip.
 */
export async function updateWebhookSubscription(
  db: D1Db,
  id: string,
  updates: WebhookSubscriptionUpdates,
): Promise<WebhookSubscription | null> {
  await db.update(webhookSubscriptions).set(updates).where(eq(webhookSubscriptions.id, id));
  return getWebhookSubscriptionById(db, id);
}

/** Worker-local delete. Idempotent — no error if id missing. */
export async function deleteWebhookSubscription(db: D1Db, id: string): Promise<void> {
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
}

/**
 * Bump secret_version via read-modify-write. Returns the new version, or
 * null when the subscription is missing. Not atomic — concurrent rotations
 * could collide on the same version (admin endpoint, low contention).
 */
export async function bumpWebhookSecretVersion(db: D1Db, id: string): Promise<number | null> {
  const cur = await getWebhookSubscriptionById(db, id);
  if (!cur) return null;
  const newVersion = cur.secretVersion + 1;
  await db
    .update(webhookSubscriptions)
    .set({ secretVersion: newVersion })
    .where(eq(webhookSubscriptions.id, id));
  return newVersion;
}

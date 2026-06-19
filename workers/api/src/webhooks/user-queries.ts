import { and, eq, sql } from "drizzle-orm";
import { organizations, sources, webhookSubscriptions } from "@buildinternet/releases-core/schema";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import {
  computeWebhookDeliveryHealth,
  type WebhookDeliveryHealth,
} from "@releases/core-internal/webhook-resilience";
import type { D1Db } from "../db.js";

export const MAX_USER_WEBHOOK_SUBSCRIPTIONS = 10;
export const MAX_USER_FOLLOWS_WEBHOOK_SUBSCRIPTIONS = 1;

const orgFields = {
  id: organizations.id,
  slug: organizations.slug,
  name: organizations.name,
  deletedAt: organizations.deletedAt,
};

async function liveOrg(
  db: D1Db,
  where: ReturnType<typeof eq>,
): Promise<{ id: string; slug: string; name: string } | null> {
  const row = await db.select(orgFields).from(organizations).where(where).get();
  if (!row || row.deletedAt) return null;
  return { id: row.id, slug: row.slug, name: row.name };
}

export async function resolveWebhookOrg(
  db: D1Db,
  input: { orgId?: string; orgSlug?: string },
): Promise<{ id: string; slug: string; name: string } | null> {
  if (input.orgId) return liveOrg(db, eq(organizations.id, input.orgId));
  if (input.orgSlug) return liveOrg(db, eq(organizations.slug, input.orgSlug));
  return null;
}

export async function resolveWebhookSource(
  db: D1Db,
  orgId: string,
  input: { sourceId?: string; sourceSlug?: string },
): Promise<{ id: string; slug: string; name: string } | null> {
  const fields = {
    id: sources.id,
    slug: sources.slug,
    name: sources.name,
    orgId: sources.orgId,
    deletedAt: sources.deletedAt,
  };
  const row = input.sourceId
    ? await db.select(fields).from(sources).where(eq(sources.id, input.sourceId)).get()
    : input.sourceSlug
      ? await db
          .select(fields)
          .from(sources)
          .where(and(eq(sources.orgId, orgId), eq(sources.slug, input.sourceSlug)))
          .get()
      : null;
  if (!row || row.deletedAt || row.orgId !== orgId) return null;
  return { id: row.id, slug: row.slug, name: row.name };
}

export async function countUserOrgWebhookSubscriptions(db: D1Db, userId: string): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.userId, userId), eq(webhookSubscriptions.scope, "org")))
    .get();
  return Number(row?.n ?? 0);
}

export async function getUserFollowsWebhookSubscription(
  db: D1Db,
  userId: string,
): Promise<WebhookSubscription | null> {
  return (
    (await db
      .select()
      .from(webhookSubscriptions)
      .where(
        and(eq(webhookSubscriptions.userId, userId), eq(webhookSubscriptions.scope, "follows")),
      )
      .get()) ?? null
  );
}

export async function getUserWebhookSubscription(
  db: D1Db,
  userId: string,
  id: string,
): Promise<WebhookSubscription | null> {
  return (
    (await db
      .select()
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)))
      .get()) ?? null
  );
}

export interface UserWebhookListItem {
  id: string;
  scope: "org" | "follows";
  url: string;
  enabled: boolean;
  description: string | null;
  secretVersion: number;
  createdAt: string;
  orgId: string | null;
  orgSlug: string | null;
  orgName: string | null;
  sourceId: string | null;
  sourceSlug: string | null;
  sourceName: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  failureStreakStartedAt: string | null;
  deliveryHealth: WebhookDeliveryHealth;
  deliveryHealthSummary: string;
}

export function userWebhookDeliveryHealth(sub: WebhookSubscription): {
  deliveryHealth: WebhookDeliveryHealth;
  deliveryHealthSummary: string;
} {
  const view = computeWebhookDeliveryHealth(sub);
  return { deliveryHealth: view.health, deliveryHealthSummary: view.summary };
}

export async function listUserWebhookSubscriptionsEnriched(
  db: D1Db,
  userId: string,
  opts?: { enabledOnly?: boolean },
): Promise<UserWebhookListItem[]> {
  const predicates = [eq(webhookSubscriptions.userId, userId)];
  if (opts?.enabledOnly) predicates.push(eq(webhookSubscriptions.enabled, true));

  const rows = await db
    .select({
      subscription: webhookSubscriptions,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      sourceSlug: sources.slug,
      sourceName: sources.name,
    })
    .from(webhookSubscriptions)
    .leftJoin(organizations, eq(organizations.id, webhookSubscriptions.orgId))
    .leftJoin(sources, eq(sources.id, webhookSubscriptions.sourceId))
    .where(and(...predicates));

  return rows.map(({ subscription: s, orgSlug, orgName, sourceSlug, sourceName }) => {
    const item = {
      id: s.id,
      scope: s.scope,
      url: s.url,
      enabled: s.enabled,
      description: s.description,
      secretVersion: s.secretVersion,
      createdAt: s.createdAt,
      orgId: s.orgId,
      orgSlug: orgSlug ?? null,
      orgName: orgName ?? null,
      sourceId: s.sourceId,
      sourceSlug: sourceSlug ?? null,
      sourceName: sourceName ?? null,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      lastErrorMsg: s.lastErrorMsg,
      consecutiveFailures: s.consecutiveFailures,
      disabledReason: s.disabledReason,
      failureStreakStartedAt: s.failureStreakStartedAt,
    };
    return { ...item, ...userWebhookDeliveryHealth(s) };
  });
}

import { and, count, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import { webhookSubscriptions } from "@buildinternet/releases-core/schema";
import type { SemanticAlert } from "@buildinternet/releases-api-types";
import type { AnyDb } from "../db.js";
import { userFollows } from "../db/schema-follows.js";
import {
  semanticAlertMatches,
  semanticAlerts,
  type SemanticAlertRow,
} from "../db/schema-semantic-alerts.js";

/** Unix-second timestamp. `mode: "timestamp"` stores whole seconds. */
function nowSeconds(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function newSemanticAlertId(): string {
  return `sal_${crypto.randomUUID()}`;
}

export function toSemanticAlert(row: SemanticAlertRow): SemanticAlert {
  return {
    id: row.id,
    query: row.query,
    enabled: row.enabled,
    threshold: row.threshold,
    deliverEmail: row.deliverEmail,
    deliverWebhook: row.deliverWebhook,
    webhookSubscriptionId: row.webhookSubscriptionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function countSemanticAlerts(db: AnyDb, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(semanticAlerts)
    .where(eq(semanticAlerts.userId, userId));
  return row?.n ?? 0;
}

export async function listSemanticAlerts(db: AnyDb, userId: string): Promise<SemanticAlert[]> {
  const rows = await db
    .select()
    .from(semanticAlerts)
    .where(eq(semanticAlerts.userId, userId))
    .orderBy(desc(semanticAlerts.createdAt));
  return rows.map(toSemanticAlert);
}

export async function getSemanticAlert(
  db: AnyDb,
  userId: string,
  id: string,
): Promise<SemanticAlertRow | null> {
  const [row] = await db
    .select()
    .from(semanticAlerts)
    .where(and(eq(semanticAlerts.id, id), eq(semanticAlerts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** True when `id` is a webhook subscription owned by this user (not an admin row). */
export async function userOwnsWebhookSubscription(
  db: AnyDb,
  userId: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)))
    .limit(1);
  return row != null;
}

export interface NewSemanticAlertInput {
  query: string;
  enabled: boolean;
  threshold: number;
  deliverEmail: boolean;
  deliverWebhook: boolean;
  webhookSubscriptionId: string | null;
}

export async function insertSemanticAlert(
  db: AnyDb,
  userId: string,
  input: NewSemanticAlertInput,
): Promise<SemanticAlert> {
  const now = nowSeconds();
  const [row] = await db
    .insert(semanticAlerts)
    .values({
      id: newSemanticAlertId(),
      userId,
      query: input.query,
      enabled: input.enabled,
      threshold: input.threshold,
      deliverEmail: input.deliverEmail,
      deliverWebhook: input.deliverWebhook,
      webhookSubscriptionId: input.webhookSubscriptionId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("semantic alert insert returned no row");
  return toSemanticAlert(row);
}

export interface SemanticAlertPatch {
  query?: string;
  enabled?: boolean;
  threshold?: number;
  deliverEmail?: boolean;
  deliverWebhook?: boolean;
  webhookSubscriptionId?: string | null;
}

export async function updateSemanticAlert(
  db: AnyDb,
  userId: string,
  id: string,
  patch: SemanticAlertPatch,
): Promise<SemanticAlert | null> {
  const [row] = await db
    .update(semanticAlerts)
    .set({ ...patch, updatedAt: nowSeconds() })
    .where(and(eq(semanticAlerts.id, id), eq(semanticAlerts.userId, userId)))
    .returning();
  return row ? toSemanticAlert(row) : null;
}

export interface SemanticAlertCandidateRow {
  id: string;
  userId: string;
  query: string;
  threshold: number;
  deliverEmail: boolean;
  deliverWebhook: boolean;
  webhookSubscriptionId: string | null;
}

/**
 * Enabled alerts whose owner follows this release's org or product and that
 * have at least one delivery channel. Same follow predicate as `/v1/me/feed`:
 * an org follow covers the org's sources; a product follow matches that product.
 * A user who follows both is returned once.
 */
export async function listSemanticAlertCandidates(
  db: AnyDb,
  owner: { orgId: string | null; productId: string | null },
): Promise<SemanticAlertCandidateRow[]> {
  const followMatch: SQL[] = [];
  if (owner.orgId) {
    const clause = and(eq(userFollows.targetType, "org"), eq(userFollows.targetId, owner.orgId));
    if (clause) followMatch.push(clause);
  }
  if (owner.productId) {
    const clause = and(
      eq(userFollows.targetType, "product"),
      eq(userFollows.targetId, owner.productId),
    );
    if (clause) followMatch.push(clause);
  }
  if (followMatch.length === 0) return [];
  const followWhere = followMatch.length === 1 ? followMatch[0] : or(...followMatch);
  const delivery = or(
    eq(semanticAlerts.deliverEmail, true),
    eq(semanticAlerts.deliverWebhook, true),
  );
  if (!followWhere || !delivery) return [];

  const rows = await db
    .select({
      id: semanticAlerts.id,
      userId: semanticAlerts.userId,
      query: semanticAlerts.query,
      threshold: semanticAlerts.threshold,
      deliverEmail: semanticAlerts.deliverEmail,
      deliverWebhook: semanticAlerts.deliverWebhook,
      webhookSubscriptionId: semanticAlerts.webhookSubscriptionId,
    })
    .from(semanticAlerts)
    .innerJoin(userFollows, eq(userFollows.userId, semanticAlerts.userId))
    .where(and(eq(semanticAlerts.enabled, true), delivery, followWhere));

  const byId = new Map<string, SemanticAlertCandidateRow>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Alert ids that already matched this release. Republish skips them. */
export async function listClaimedSemanticAlertIds(
  db: AnyDb,
  releaseId: string,
  alertIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunkArray(alertIds, IN_ARRAY_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-budget chunks
    const rows = await db
      .select({ alertId: semanticAlertMatches.alertId })
      .from(semanticAlertMatches)
      .where(
        and(
          eq(semanticAlertMatches.releaseId, releaseId),
          inArray(semanticAlertMatches.alertId, chunk),
        ),
      );
    for (const row of rows) out.add(row.alertId);
  }
  return out;
}

/**
 * Insert the match row. Returns false when this alert already matched this
 * release, so the caller does not deliver again.
 */
export async function claimSemanticAlertMatch(
  db: AnyDb,
  input: { alertId: string; releaseId: string; probability: number },
): Promise<boolean> {
  const inserted = await db
    .insert(semanticAlertMatches)
    .values({
      alertId: input.alertId,
      releaseId: input.releaseId,
      probability: input.probability,
      createdAt: nowSeconds(),
    })
    .onConflictDoNothing()
    .returning({ alertId: semanticAlertMatches.alertId });
  return inserted.length > 0;
}

export async function deleteSemanticAlert(db: AnyDb, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(semanticAlerts)
    .where(and(eq(semanticAlerts.id, id), eq(semanticAlerts.userId, userId)))
    .returning({ id: semanticAlerts.id });
  return deleted.length > 0;
}

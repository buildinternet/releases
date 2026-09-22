import { and, count, desc, eq } from "drizzle-orm";
import { webhookSubscriptions } from "@buildinternet/releases-core/schema";
import type { SemanticAlert } from "@buildinternet/releases-api-types";
import type { AnyDb } from "../db.js";
import { semanticAlerts, type SemanticAlertRow } from "../db/schema-semantic-alerts.js";

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

export async function deleteSemanticAlert(db: AnyDb, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(semanticAlerts)
    .where(and(eq(semanticAlerts.id, id), eq(semanticAlerts.userId, userId)))
    .returning({ id: semanticAlerts.id });
  return deleted.length > 0;
}

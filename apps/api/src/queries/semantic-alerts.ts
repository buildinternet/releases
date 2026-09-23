import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import { releasePath } from "@buildinternet/releases-core/release-slug";
import { releases, webhookSubscriptions } from "@buildinternet/releases-core/schema";
import type {
  SemanticAlert,
  SemanticAlertActivity,
  SemanticAlertListItem,
} from "@buildinternet/releases-api-types";
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

export function emptySemanticAlertActivity(): SemanticAlertActivity {
  return { matches7d: 0, matches30d: 0, lastMatchedAt: null, lastMatch: null };
}

const MATCH_WINDOW_7D_SEC = 7 * 24 * 60 * 60;
const MATCH_WINDOW_30D_SEC = 30 * 24 * 60 * 60;

interface MatchCountRow {
  alertId: string;
  matches7d: number | null;
  matches30d: number | null;
}

interface LatestMatchRow {
  alertId: string;
  releaseId: string;
  createdAt: number | string | null;
  title: string | null;
  titleShort: string | null;
  titleGenerated: string | null;
  version: string | null;
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/** `created_at` is unix seconds (`mode: "timestamp"`). */
function matchTimeIso(value: unknown): string | null {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * Claimed-match activity for a caller's alert ids.
 *
 * Two statements, not one per alert: a 30-day aggregate (7-day count is a
 * case inside it) and one latest row per id. Both use
 * `idx_semantic_alert_matches_alert_created`. The release join is the latest
 * row only, capped at the id count (at most 5 on the account list).
 * Below-threshold scores are not in this table.
 */
export async function loadSemanticAlertActivity(
  db: AnyDb,
  alertIds: string[],
  nowMs: number = Date.now(),
): Promise<Map<string, SemanticAlertActivity>> {
  const ids = [...new Set(alertIds)];
  const byId = new Map<string, SemanticAlertActivity>();
  for (const id of ids) byId.set(id, emptySemanticAlertActivity());
  if (ids.length === 0) return byId;

  const nowSec = Math.floor(nowMs / 1000);
  const since7 = nowSec - MATCH_WINDOW_7D_SEC;
  const since30 = nowSec - MATCH_WINDOW_30D_SEC;

  const [counts, latest] = await Promise.all([
    loadMatchCounts(db, ids, since7, since30),
    loadLatestMatches(db, ids),
  ]);

  for (const row of counts) {
    const activity = byId.get(row.alertId);
    if (!activity) continue;
    activity.matches7d = toCount(row.matches7d);
    activity.matches30d = toCount(row.matches30d);
  }

  for (const row of latest) {
    const activity = byId.get(row.alertId);
    if (!activity) continue;
    activity.lastMatchedAt = matchTimeIso(row.createdAt);
    if (row.title == null) continue;
    const title =
      row.titleShort?.trim() ||
      row.titleGenerated?.trim() ||
      row.title.trim() ||
      row.version?.trim() ||
      "Release";
    activity.lastMatch = {
      releaseId: row.releaseId,
      title,
      path: releasePath({
        id: row.releaseId,
        titleShort: row.titleShort,
        titleGenerated: row.titleGenerated,
        title: row.title,
        version: row.version,
      }),
    };
  }

  return byId;
}

async function loadMatchCounts(
  db: AnyDb,
  alertIds: string[],
  since7: number,
  since30: number,
): Promise<MatchCountRow[]> {
  const chunks = chunkArray(alertIds, IN_ARRAY_CHUNK_SIZE);
  const parts = await Promise.all(
    chunks.map((chunk) =>
      db.all<MatchCountRow>(sql`
        SELECT
          alert_id as alertId,
          SUM(CASE WHEN created_at >= ${since7} THEN 1 ELSE 0 END) as matches7d,
          COUNT(*) as matches30d
        FROM semantic_alert_matches
        WHERE alert_id IN (${idList(chunk)})
          AND created_at >= ${since30}
        GROUP BY alert_id
      `),
    ),
  );
  return parts.flat();
}

async function loadLatestMatches(db: AnyDb, alertIds: string[]): Promise<LatestMatchRow[]> {
  const chunks = chunkArray(alertIds, IN_ARRAY_CHUNK_SIZE);
  const parts = await Promise.all(
    chunks.map((chunk) => {
      const branches = chunk.map(
        (id) => sql`
          SELECT alert_id, release_id, created_at FROM (
            SELECT alert_id, release_id, created_at
            FROM semantic_alert_matches
            WHERE alert_id = ${id}
            ORDER BY created_at DESC
            LIMIT 1
          )
        `,
      );
      return db.all<LatestMatchRow>(sql`
        SELECT
          latest.alert_id as alertId,
          latest.release_id as releaseId,
          latest.created_at as createdAt,
          r.title as title,
          r.title_short as titleShort,
          r.title_generated as titleGenerated,
          r.version as version
        FROM (
          ${sql.join(branches, sql` UNION ALL `)}
        ) as latest
        LEFT JOIN ${releases} as r ON r.id = latest.release_id
        LIMIT ${chunk.length}
      `);
    }),
  );
  return parts.flat();
}

export async function listSemanticAlerts(
  db: AnyDb,
  userId: string,
): Promise<SemanticAlertListItem[]> {
  const rows = await db
    .select()
    .from(semanticAlerts)
    .where(eq(semanticAlerts.userId, userId))
    .orderBy(desc(semanticAlerts.createdAt));
  if (rows.length === 0) return [];
  const activity = await loadSemanticAlertActivity(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    Object.assign(toSemanticAlert(row), {
      activity: activity.get(row.id) ?? emptySemanticAlertActivity(),
    }),
  );
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

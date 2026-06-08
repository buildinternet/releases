import { and, desc, eq, inArray } from "drizzle-orm";
import { organizations, products } from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";
import { userFollows, type FollowTargetType } from "../db/schema-follows.js";

/** A user's follow, enriched with the target entity's display fields. */
export interface EnrichedFollow {
  targetType: FollowTargetType;
  targetId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  /** For products, the owning org's slug (so the web can build a link). */
  orgSlug: string | null;
  createdAt: string;
}

/** The minimal entity shape returned by target validation. */
export interface FollowTargetEntity {
  name: string;
  slug: string;
  avatarUrl: string | null;
  orgSlug: string | null;
}

function newFollowId(): string {
  return `fol_${crypto.randomUUID()}`;
}

/**
 * Resolve a follow target to a live (non-tombstoned) org or product, or null.
 * Used at follow-time so we never persist a follow to a non-existent/hidden
 * entity. Orgs hidden from listings (`isHidden`) are still followable — hidden
 * only suppresses promotion, not direct access — but soft-deleted ones are not.
 */
export async function resolveFollowTarget(
  db: AnyDb,
  targetType: FollowTargetType,
  targetId: string,
): Promise<FollowTargetEntity | null> {
  if (targetType === "org") {
    const row = await db
      .select({
        name: organizations.name,
        slug: organizations.slug,
        avatarUrl: organizations.avatarUrl,
        deletedAt: organizations.deletedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, targetId))
      .get();
    if (!row || row.deletedAt) return null;
    return { name: row.name, slug: row.slug, avatarUrl: row.avatarUrl, orgSlug: null };
  }
  const row = await db
    .select({
      name: products.name,
      slug: products.slug,
      avatarUrl: products.avatarUrl,
      deletedAt: products.deletedAt,
      orgSlug: organizations.slug,
    })
    .from(products)
    .leftJoin(organizations, eq(organizations.id, products.orgId))
    .where(eq(products.id, targetId))
    .get();
  if (!row || row.deletedAt) return null;
  return {
    name: row.name,
    slug: row.slug,
    avatarUrl: row.avatarUrl,
    orgSlug: row.orgSlug ?? null,
  };
}

/**
 * Cheap point-existence check on the unique index `(user_id, target_type,
 * target_id)` — used by the follow route to answer 200 (already following) vs
 * 201 (fresh) without loading + enriching the caller's whole follow set.
 */
export async function hasFollow(
  db: AnyDb,
  userId: string,
  targetType: FollowTargetType,
  targetId: string,
): Promise<boolean> {
  const row = await db
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(
      and(
        eq(userFollows.userId, userId),
        eq(userFollows.targetType, targetType),
        eq(userFollows.targetId, targetId),
      ),
    )
    .get();
  return row !== undefined;
}

/** Idempotently add a follow (re-follow is a no-op via the unique index). */
export async function addFollow(
  db: AnyDb,
  userId: string,
  targetType: FollowTargetType,
  targetId: string,
): Promise<void> {
  await db
    .insert(userFollows)
    .values({ id: newFollowId(), userId, targetType, targetId, createdAt: new Date() })
    .onConflictDoNothing();
}

/** Idempotently remove a follow (removing a non-follow is a no-op). */
export async function removeFollow(
  db: AnyDb,
  userId: string,
  targetType: FollowTargetType,
  targetId: string,
): Promise<void> {
  await db
    .delete(userFollows)
    .where(
      and(
        eq(userFollows.userId, userId),
        eq(userFollows.targetType, targetType),
        eq(userFollows.targetId, targetId),
      ),
    );
}

/** D1 caps a prepared statement at 100 bound params; `inArray` binds one per
 * id, so chunk lookups at `IN_ARRAY_CHUNK_SIZE` (90, repo convention) and
 * concat the results. */
async function fetchInChunks<T>(
  ids: string[],
  run: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_ARRAY_CHUNK_SIZE) {
    out.push(...(await run(ids.slice(i, i + IN_ARRAY_CHUNK_SIZE))));
  }
  return out;
}

/**
 * List a user's follows, enriched with each target's display fields, newest
 * first. Orphaned follows (target soft-deleted/removed) are dropped — a follow
 * whose org/product no longer resolves is omitted.
 *
 * Set-based, constant query count (not N+1): read the ordered follow rows, then
 * partition their ids by type and hydrate orgs and products in two concurrent
 * batched `IN (...)` queries (chunked at 90 ids for D1's 100-bind cap, so a
 * >90-follow power user can't 500). Finally re-walk the original ordered rows
 * against the resulting id→entity maps, dropping misses, to preserve
 * newest-first order.
 */
export async function listFollows(db: AnyDb, userId: string): Promise<EnrichedFollow[]> {
  const rows = (await db
    .select({
      targetType: userFollows.targetType,
      targetId: userFollows.targetId,
      createdAt: userFollows.createdAt,
    })
    .from(userFollows)
    .where(eq(userFollows.userId, userId))
    .orderBy(desc(userFollows.createdAt))
    .all()) as Array<{
    targetType: FollowTargetType;
    targetId: string;
    createdAt: Date;
  }>;

  const orgIds = [...new Set(rows.filter((r) => r.targetType === "org").map((r) => r.targetId))];
  const productIds = [
    ...new Set(rows.filter((r) => r.targetType === "product").map((r) => r.targetId)),
  ];

  // Hydrate orgs and products. They hit different tables and neither block
  // reads the other's rows, so run the two batched queries concurrently —
  // their latencies overlap instead of stacking.
  type OrgRow = {
    id: string;
    name: string;
    slug: string;
    avatarUrl: string | null;
    deletedAt: string | null;
  };
  type ProductRow = {
    id: string;
    name: string;
    slug: string;
    avatarUrl: string | null;
    deletedAt: string | null;
    orgSlug: string | null;
  };
  const [orgRows, productRows] = await Promise.all([
    // Soft-deleted rows are dropped (orphans); hidden orgs are still followable,
    // matching resolveFollowTarget — orgSlug is always null.
    orgIds.length
      ? fetchInChunks(
          orgIds,
          (chunk) =>
            db
              .select({
                id: organizations.id,
                name: organizations.name,
                slug: organizations.slug,
                avatarUrl: organizations.avatarUrl,
                deletedAt: organizations.deletedAt,
              })
              .from(organizations)
              .where(inArray(organizations.id, chunk))
              .all() as Promise<OrgRow[]>,
        )
      : Promise.resolve<OrgRow[]>([]),
    // orgSlug comes from the LEFT JOIN to the owning org (null if absent);
    // soft-deleted products are dropped as orphans.
    productIds.length
      ? fetchInChunks(
          productIds,
          (chunk) =>
            db
              .select({
                id: products.id,
                name: products.name,
                slug: products.slug,
                avatarUrl: products.avatarUrl,
                deletedAt: products.deletedAt,
                orgSlug: organizations.slug,
              })
              .from(products)
              .leftJoin(organizations, eq(organizations.id, products.orgId))
              .where(inArray(products.id, chunk))
              .all() as Promise<ProductRow[]>,
        )
      : Promise.resolve<ProductRow[]>([]),
  ]);

  const orgById = new Map<string, FollowTargetEntity>();
  for (const r of orgRows) {
    if (r.deletedAt) continue;
    orgById.set(r.id, { name: r.name, slug: r.slug, avatarUrl: r.avatarUrl, orgSlug: null });
  }

  const productById = new Map<string, FollowTargetEntity>();
  for (const r of productRows) {
    if (r.deletedAt) continue;
    productById.set(r.id, {
      name: r.name,
      slug: r.slug,
      avatarUrl: r.avatarUrl,
      orgSlug: r.orgSlug ?? null,
    });
  }

  // Re-walk the original newest-first rows; drop orphans (map misses).
  const out: EnrichedFollow[] = [];
  for (const r of rows) {
    const entity = r.targetType === "org" ? orgById.get(r.targetId) : productById.get(r.targetId);
    if (!entity) continue;
    out.push({
      targetType: r.targetType,
      targetId: r.targetId,
      name: entity.name,
      slug: entity.slug,
      avatarUrl: entity.avatarUrl,
      orgSlug: entity.orgSlug,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return out;
}

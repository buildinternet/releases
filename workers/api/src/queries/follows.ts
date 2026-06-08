import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { userFollows, type FollowTargetType } from "../db/schema-follows.js";

// oxlint-disable-next-line no-explicit-any -- matches D1Db in prod, BunSQLite in tests
type AnyDb = BaseSQLiteDatabase<any, any, any, any>;

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
  id: string;
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
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        avatarUrl: organizations.avatarUrl,
        deletedAt: organizations.deletedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, targetId))
      .get();
    if (!row || row.deletedAt) return null;
    return { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl, orgSlug: null };
  }
  const row = await db
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
    .where(eq(products.id, targetId))
    .get();
  if (!row || row.deletedAt) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    avatarUrl: row.avatarUrl,
    orgSlug: row.orgSlug ?? null,
  };
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

/**
 * List a user's follows, enriched with each target's display fields, newest
 * first. Orphaned follows (target soft-deleted/removed) are dropped — a follow
 * whose org/product no longer resolves is omitted. Two-pass: read the follow
 * rows, then resolve each target; a user's follow count is small.
 */
export async function listFollows(db: AnyDb, userId: string): Promise<EnrichedFollow[]> {
  const rows = await db
    .select({
      targetType: userFollows.targetType,
      targetId: userFollows.targetId,
      createdAt: userFollows.createdAt,
    })
    .from(userFollows)
    .where(eq(userFollows.userId, userId))
    .all();

  const resolved = await Promise.all(
    rows.map(async (r: (typeof rows)[number]) => {
      const entity = await resolveFollowTarget(db, r.targetType, r.targetId);
      if (!entity) return null;
      return {
        targetType: r.targetType,
        targetId: r.targetId,
        name: entity.name,
        slug: entity.slug,
        avatarUrl: entity.avatarUrl,
        orgSlug: r.targetType === "product" ? entity.orgSlug : null,
        createdAt: r.createdAt.toISOString(),
      } satisfies EnrichedFollow;
    }),
  );
  const out = resolved.filter((x): x is EnrichedFollow => x !== null);
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

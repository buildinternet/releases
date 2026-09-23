import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { organizations, products } from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";
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

/**
 * List a user's follows, enriched with each target's display fields, newest
 * first. Orphaned follows (target soft-deleted/removed) are dropped — a follow
 * whose org/product no longer resolves is omitted.
 *
 * Single ordered query: LEFT JOIN the polymorphic `(target_type, target_id)`
 * against both `organizations` and `products` (the join predicate carries the
 * type discriminator, so at most one side matches per row), plus a second
 * aliased `organizations` join for a product's owning-org slug. SQL does the
 * `ORDER BY created_at DESC`, so there's no id-partition / batched-`IN` /
 * re-walk machinery and no D1 100-bind chunking to worry about — the only bound
 * param is `user_id`. A row whose matched side is NULL (target removed) or
 * soft-deleted is an orphan and is skipped.
 */
export async function listFollows(db: AnyDb, userId: string): Promise<EnrichedFollow[]> {
  // Owning-org of a followed product. A second reference to `organizations`
  // needs an alias so it doesn't collide with the org-target join above.
  const productOrg = alias(organizations, "product_org");

  const rows = (await db
    .select({
      targetType: userFollows.targetType,
      targetId: userFollows.targetId,
      createdAt: userFollows.createdAt,
      // org-target side (orgSlug is always null — matches resolveFollowTarget;
      // hidden orgs stay followable, only soft-deleted ones are dropped).
      orgName: organizations.name,
      orgSlug: organizations.slug,
      orgAvatarUrl: organizations.avatarUrl,
      orgDeletedAt: organizations.deletedAt,
      // product-target side, with its owning-org slug from the aliased join.
      productName: products.name,
      productSlug: products.slug,
      productAvatarUrl: products.avatarUrl,
      productDeletedAt: products.deletedAt,
      productOrgSlug: productOrg.slug,
    })
    .from(userFollows)
    .leftJoin(
      organizations,
      and(eq(userFollows.targetType, "org"), eq(organizations.id, userFollows.targetId)),
    )
    .leftJoin(
      products,
      and(eq(userFollows.targetType, "product"), eq(products.id, userFollows.targetId)),
    )
    .leftJoin(productOrg, eq(productOrg.id, products.orgId))
    .where(eq(userFollows.userId, userId))
    .orderBy(desc(userFollows.createdAt))
    .all()) as Array<{
    targetType: FollowTargetType;
    targetId: string;
    createdAt: Date;
    orgName: string | null;
    orgSlug: string | null;
    orgAvatarUrl: string | null;
    orgDeletedAt: string | null;
    productName: string | null;
    productSlug: string | null;
    productAvatarUrl: string | null;
    productDeletedAt: string | null;
    productOrgSlug: string | null;
  }>;

  const out: EnrichedFollow[] = [];
  for (const r of rows) {
    const entity: FollowTargetEntity | null =
      r.targetType === "org"
        ? r.orgName !== null && !r.orgDeletedAt
          ? { name: r.orgName, slug: r.orgSlug!, avatarUrl: r.orgAvatarUrl, orgSlug: null }
          : null
        : r.productName !== null && !r.productDeletedAt
          ? {
              name: r.productName,
              slug: r.productSlug!,
              avatarUrl: r.productAvatarUrl,
              orgSlug: r.productOrgSlug ?? null,
            }
          : null;
    if (!entity) continue; // orphan: target removed or soft-deleted
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

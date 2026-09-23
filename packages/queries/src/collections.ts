/**
 * Collection reads: the row, its visible members, and the two search paths.
 *
 * Visibility follows the API: org members join through `organizations_public`
 * (active, not on_demand) and product members through `products_active` plus
 * a visible parent org, so a soft-deleted or on_demand org never leaks through
 * a collection, and neither does a product attached to one.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import {
  collections,
  collectionMembers,
  organizationsPublic,
  productsActive,
} from "@buildinternet/releases-core/schema";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import type {
  CollectionListItem,
  CollectionMember,
  CollectionMemberOrg,
  CollectionMemberProduct,
  ProductParentOrg,
  SearchCollectionHit,
} from "@buildinternet/releases-api-types";
import type { AnyDb } from "@releases/lib/db";

/** Row shape of the `collections` table. */
export type CollectionRow = typeof collections.$inferSelect;

/** One collection by slug, or null. */
export async function findCollectionBySlug(db: AnyDb, slug: string): Promise<CollectionRow | null> {
  const [row] = await db.select().from(collections).where(eq(collections.slug, slug)).limit(1);
  return row ?? null;
}

/** Number of collection rows. Pairs with a paged `listCollectionsWhere`. */
export async function countCollections(db: AnyDb): Promise<number> {
  const rows: { n: number }[] = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM ${collections}`,
  );
  return Number(rows[0]?.n ?? 0);
}

export interface CollectionPage {
  limit: number;
  offset: number;
}

/**
 * Collections matching `where` (a predicate over the `collections c` alias;
 * omit for every collection), each with its visible member count (orgs via
 * `organizations_public` + products via `products_active`, the latter gated
 * through a visible parent org so an on_demand org's product can't inflate the
 * total). Ordered alphabetically by name. `page` adds a LIMIT/OFFSET window.
 *
 * Shared by `GET /v1/orgs/:slug/collections`, `GET /v1/products/:slug/collections`
 * (the "Featured in" sidebar counts the same way at both levels), and MCP
 * `list_collections`.
 *
 * Raw SQL (not the Drizzle query builder) because the relational `${collections.id}`
 * reference mis-binds against the inner `id` aliases (`op.id`, `pa.id`) and
 * silently yields 0.
 */
export async function listCollectionsWhere(
  db: AnyDb,
  where?: SQL,
  page?: CollectionPage,
): Promise<CollectionListItem[]> {
  const whereClause = where ? sql`WHERE ${where}` : sql``;
  const pageClause = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  type Row = {
    slug: string;
    name: string;
    description: string | null;
    isFeatured: number;
    orgCount: number;
    productCount: number;
  };
  const rows: Row[] = await db.all<Row>(sql`
    SELECT c.slug, c.name, c.description, c.is_featured AS isFeatured,
      (SELECT COUNT(*) FROM ${collectionMembers} cm
         INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
         WHERE cm.collection_id = c.id) AS orgCount,
      (SELECT COUNT(*) FROM ${collectionMembers} cm
         INNER JOIN ${productsActive} pa ON pa.id = cm.product_id
         INNER JOIN ${organizationsPublic} op ON op.id = pa.org_id
         WHERE cm.collection_id = c.id) AS productCount
    FROM ${collections} c
    ${whereClause}
    ORDER BY c.name
    ${pageClause}
  `);

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    isFeatured: Boolean(r.isFeatured),
    memberCount: Number(r.orgCount) + Number(r.productCount),
  }));
}

export interface CollectionMemberIds {
  orgs: { orgId: string; slug: string }[];
  products: { productId: string; slug: string }[];
}

/**
 * Visible member IDs for a collection's release feed. Orgs resolve through
 * `organizations_public`; products through `products_active` AND a visible
 * parent org, so a product attached to an on_demand or soft-deleted org
 * doesn't surface releases. Same universe as `getCollectionFullMembers`.
 */
export async function listCollectionMemberIds(
  db: AnyDb,
  collectionId: string,
): Promise<CollectionMemberIds> {
  const [orgs, products] = await Promise.all([
    db
      .select({ orgId: organizationsPublic.id, slug: organizationsPublic.slug })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collectionId)),
    db
      .select({ productId: productsActive.id, slug: productsActive.slug })
      .from(collectionMembers)
      .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
      .where(eq(collectionMembers.collectionId, collectionId)),
  ]);
  return { orgs, products };
}

// ── Members ──────────────────────────────────────────────────────────────

export type OrgMemberRow = {
  position: number;
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  description: string | null;
  githubHandle: string | null;
};

export type ProductMemberRow = {
  position: number;
  productSlug: string;
  productName: string;
  productDescription: string | null;
  parentOrgSlug: string;
  parentOrgName: string;
  parentOrgDomain: string | null;
  parentOrgAvatarUrl: string | null;
  parentOrgGithubHandle: string | null;
};

function orgRowToWire(r: OrgMemberRow): CollectionMemberOrg & { kind: "org" } {
  return {
    kind: "org",
    slug: r.slug,
    name: r.name,
    domain: r.domain,
    avatarUrl: r.avatarUrl,
    githubHandle: r.githubHandle,
    description: r.description,
  };
}

function productRowToWire(r: ProductMemberRow): CollectionMemberProduct & { kind: "product" } {
  const org: ProductParentOrg = {
    slug: r.parentOrgSlug,
    name: r.parentOrgName,
    domain: r.parentOrgDomain,
    avatarUrl: r.parentOrgAvatarUrl,
    githubHandle: r.parentOrgGithubHandle,
  };
  return {
    kind: "product",
    slug: r.productSlug,
    name: r.productName,
    description: r.productDescription,
    org,
  };
}

/** Byte-wise (code-unit) compare — matches SQLite's default BINARY collation,
 *  unlike `localeCompare`, so the JS merge order agrees with the windowed SQL
 *  `ORDER BY position, name, slug`. See `interleaveMembers`. */
function binCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge org and product member rows into one wire list ordered by
 * (position, name, slug). The order MUST match the SQL window order with the
 * same collation (BINARY, via `binCompare`) and the same stable slug tiebreak,
 * so a windowed per-kind preview fetch provably contains the global top-N
 * after the merge. The slug tiebreak also makes same-(position, name) members
 * deterministic (org names aren't unique).
 */
export function interleaveMembers(
  orgs: OrgMemberRow[],
  productsRows: ProductMemberRow[],
): CollectionMember[] {
  type Item = { position: number; sort: string; tie: string; value: CollectionMember };
  const items: Item[] = [];
  for (const r of orgs) {
    items.push({ position: r.position, sort: r.name, tie: r.slug, value: orgRowToWire(r) });
  }
  for (const r of productsRows) {
    items.push({
      position: r.position,
      sort: r.productName,
      tie: r.productSlug,
      value: productRowToWire(r),
    });
  }
  items.sort(
    (a, b) => a.position - b.position || binCompare(a.sort, b.sort) || binCompare(a.tie, b.tie),
  );
  return items.map((i) => i.value);
}

/**
 * Full ordered member list for a collection detail page: orgs via
 * `organizations_public`, products via `products_active` + visible parent org,
 * interleaved by (position, name, slug). GitHub handles are picked
 * deterministically from `org_accounts` so multi-handle orgs don't fan out the
 * row. Shared by `GET /v1/collections/:slug`, GraphQL `Collection.members`,
 * and MCP `get_collection`.
 */
export async function getCollectionFullMembers(
  db: AnyDb,
  collectionId: string,
): Promise<CollectionMember[]> {
  const [orgsList, productsList] = await Promise.all([
    db.all<OrgMemberRow>(sql`
      SELECT cm.position AS position,
             op.slug AS slug, op.name AS name, op.domain AS domain,
             op.avatar_url AS avatarUrl, op.description AS description,
             (SELECT handle FROM org_accounts
                WHERE org_id = op.id AND platform = 'github'
                ORDER BY created_at, id LIMIT 1) AS githubHandle
      FROM ${collectionMembers} cm
      INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
      WHERE cm.collection_id = ${collectionId}
      ORDER BY cm.position, op.name, op.slug
    `),
    db.all<ProductMemberRow>(sql`
      SELECT cm.position AS position,
             pa.slug AS productSlug, pa.name AS productName,
             pa.description AS productDescription,
             op.slug AS parentOrgSlug, op.name AS parentOrgName,
             op.domain AS parentOrgDomain, op.avatar_url AS parentOrgAvatarUrl,
             (SELECT handle FROM org_accounts
                WHERE org_id = op.id AND platform = 'github'
                ORDER BY created_at, id LIMIT 1) AS parentOrgGithubHandle
      FROM ${collectionMembers} cm
      INNER JOIN ${productsActive} pa ON pa.id = cm.product_id
      INNER JOIN ${organizationsPublic} op ON op.id = pa.org_id
      WHERE cm.collection_id = ${collectionId}
      ORDER BY cm.position, pa.name, pa.slug
    `),
  ]);
  return interleaveMembers(orgsList, productsList);
}

// ── Search ───────────────────────────────────────────────────────────────
//
// Two complementary paths surface collections on `/v1/search` and the MCP
// `search` tool:
//
//  - `searchCollectionsDirect`     LIKE on the collection's own name, slug, and
//                                  description. Cheap; runs in every mode so a
//                                  user typing the name doesn't need vectors.
//  - `findCollectionsByMemberOrgs` joins through `collection_members` so a
//                                  collection containing a hit org rolls up.
//                                  Driven by the org-hit set the caller
//                                  already computed, not the query string.
//
// Both count members through `organizations_public`, so soft-deleted and
// on_demand orgs never inflate `memberCount` or leak via a collection.

/**
 * LIKE-based collection match. `memberCount` is computed in the same query via
 * a correlated subquery so the wire row is final without a second round-trip.
 */
export async function searchCollectionsDirect(
  db: AnyDb,
  query: string,
  limit: number,
): Promise<SearchCollectionHit[]> {
  const memberCountSql = sql<number>`(
    SELECT COUNT(*)
    FROM ${collectionMembers} cm
    INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
    WHERE cm.collection_id = ${collections.id}
  )`;
  type Row = { slug: string; name: string; description: string | null; memberCount: number };
  const rows: Row[] = await db.all<Row>(sql`
    SELECT ${collections.slug} as slug,
           ${collections.name} as name,
           ${collections.description} as description,
           ${memberCountSql} as memberCount
    FROM ${collections}
    WHERE ${likeContains(sql`${collections.name}`, query)}
       OR ${likeContains(sql`${collections.slug}`, query)}
       OR ${likeContains(sql`${collections.description}`, query)}
    ORDER BY ${collections.name}
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    memberCount: Number(r.memberCount),
    via: "direct" as const,
  }));
}

/**
 * Roll up: given the org-hit set the caller already computed, find every
 * collection containing one of those orgs and return it with the subset of org
 * slugs that triggered the rollup ("shown because Vercel is in this
 * collection"). Returns `[]` when `orgSlugs` is empty.
 */
export async function findCollectionsByMemberOrgs(
  db: AnyDb,
  orgSlugs: string[],
  limit: number,
): Promise<SearchCollectionHit[]> {
  if (orgSlugs.length === 0) return [];
  const memberCountSql = sql<number>`(
    SELECT COUNT(*)
    FROM ${collectionMembers} cm2
    INNER JOIN ${organizationsPublic} op2 ON op2.id = cm2.org_id
    WHERE cm2.collection_id = ${collections.id}
  )`;
  type Row = {
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
    matchedOrgSlug: string;
  };
  const rows: Row[] = await db.all<Row>(sql`
    SELECT ${collections.slug} as slug,
           ${collections.name} as name,
           ${collections.description} as description,
           ${memberCountSql} as memberCount,
           ${organizationsPublic.slug} as matchedOrgSlug
    FROM ${collections}
    INNER JOIN ${collectionMembers} cm ON cm.collection_id = ${collections.id}
    INNER JOIN ${organizationsPublic} ON ${organizationsPublic.id} = cm.org_id
    WHERE ${organizationsPublic.slug} IN (${sql.join(
      orgSlugs.map((s) => sql`${s}`),
      sql`, `,
    )})
    ORDER BY ${collections.name}, ${organizationsPublic.slug}
  `);
  // SQLite has no array_agg; the row-by-row fold is cheap at our scale
  // (typical collection sizes are <10 orgs, total collections <100).
  const byCollection = new Map<string, SearchCollectionHit>();
  for (const r of rows) {
    const existing = byCollection.get(r.slug);
    if (existing) {
      existing.matchedOrgSlugs!.push(r.matchedOrgSlug);
    } else {
      byCollection.set(r.slug, {
        slug: r.slug,
        name: r.name,
        description: r.description,
        memberCount: Number(r.memberCount),
        via: "member",
        matchedOrgSlugs: [r.matchedOrgSlug],
      });
    }
  }
  return [...byCollection.values()].slice(0, limit);
}

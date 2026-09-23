import { eq, sql, type SQL } from "drizzle-orm";
import {
  collections,
  collectionMembers,
  organizationsPublic,
  productsActive,
} from "@buildinternet/releases-core/schema";
import type {
  CollectionListItem,
  CollectionMember,
  CollectionMemberOrg,
  CollectionMemberProduct,
  ProductParentOrg,
} from "@buildinternet/releases-api-types";
import type { D1Db } from "../db.js";

/** Row shape of the `collections` table (subset used by GraphQL detail). */
export type CollectionRow = typeof collections.$inferSelect;

/**
 * Collections matching `where` (a predicate over the `collections c` alias),
 * each with its visible member count (orgs via `organizations_public` + products
 * via `products_active`, the latter gated through a visible parent org so an
 * on_demand org's product can't inflate the total). Ordered alphabetically by
 * name. Shared by `GET /v1/orgs/:slug/collections` and
 * `GET /v1/products/:slug/collections` so the "Featured in" sidebar counts the
 * same way at both levels.
 *
 * Raw SQL (not the Drizzle query builder) because the relational `${collections.id}`
 * reference mis-binds against the inner `id` aliases (`op.id`, `pa.id`) and
 * silently yields 0 — the same reason `GET /v1/collections` hand-writes its count.
 */
export async function listCollectionsWhere(db: D1Db, where: SQL): Promise<CollectionListItem[]> {
  const rows = await db.all<{
    slug: string;
    name: string;
    description: string | null;
    isFeatured: number;
    orgCount: number;
    productCount: number;
  }>(sql`
    SELECT c.slug, c.name, c.description, c.is_featured AS isFeatured,
      (SELECT COUNT(*) FROM collection_members cm
         INNER JOIN organizations_public op ON op.id = cm.org_id
         WHERE cm.collection_id = c.id) AS orgCount,
      (SELECT COUNT(*) FROM collection_members cm
         INNER JOIN products_active pa ON pa.id = cm.product_id
         INNER JOIN organizations_public op ON op.id = pa.org_id
         WHERE cm.collection_id = c.id) AS productCount
    FROM collections c
    WHERE ${where}
    ORDER BY c.name
  `);

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    isFeatured: Boolean(r.isFeatured),
    memberCount: Number(r.orgCount) + Number(r.productCount),
  }));
}

// ── Full list with preview members (GET /v1/collections + GraphQL) ─────────
// Shared by `GET /v1/collections` and the GraphQL `collections` query — one
// SQL + interleave implementation so the two surfaces can't drift.

type OrgMemberRow = {
  position: number;
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  description: string | null;
  githubHandle: string | null;
};

type ProductMemberRow = {
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

function interleaveMembers(
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
  // Order MUST match the SQL window order (position, name, slug) — same
  // collation (BINARY, via binCompare) and the same stable slug tiebreak — so
  // the windowed preview fetch (top-PREVIEW_FETCH per kind) provably contains
  // the global top-PREVIEW_LIMIT after the merge. The slug tiebreak also makes
  // same-(position,name) members deterministic (org names aren't unique).
  items.sort(
    (a, b) => a.position - b.position || binCompare(a.sort, b.sort) || binCompare(a.tie, b.tie),
  );
  return items.map((i) => i.value);
}

// Per-collection preview cap. The list returns only the top PREVIEW_LIMIT (3)
// interleaved members; the SQL fetches the top PREVIEW_FETCH per kind
// (windowed via ROW_NUMBER) instead of every member (#1800 finding 6). Exact,
// not a heuristic margin: `interleaveMembers` orders by the SAME (position,
// name, slug) key with the SAME BINARY collation as the SQL window, so any
// global top-3 member is within the top-3 of its own kind's window.
const PREVIEW_FETCH = 12;
const PREVIEW_LIMIT = 3;

/**
 * Returns every collection with a member count and a small `previewMembers`
 * array (capped at `PREVIEW_LIMIT`), ordered by name. `?featured` narrows to
 * homepage-promoted collections. Shared by the REST `GET /v1/collections`
 * route and the GraphQL `collections` query.
 */
export async function getCollectionsList(
  db: D1Db,
  opts: { featured?: boolean } = {},
): Promise<CollectionListItem[]> {
  const featuredFilter = opts.featured ? sql`WHERE c.is_featured = 1` : sql``;

  const [countRows, orgMemberRows, productMemberRows] = await Promise.all([
    // Raw correlated subqueries (Drizzle's relational `${collections.id}` gets
    // confused by `id` columns on multiple aliases in the inner scope). Both
    // kinds gate through `organizations_public` — products joined via
    // `productsActive` must also have a visible parent org so an on_demand
    // org's product doesn't inflate the count.
    db.all<{
      slug: string;
      name: string;
      description: string | null;
      isFeatured: number;
      orgCount: number;
      productCount: number;
    }>(sql`
      SELECT c.slug, c.name, c.description, c.is_featured AS isFeatured,
        (SELECT COUNT(*) FROM ${collectionMembers} cm
           INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
           WHERE cm.collection_id = c.id) AS orgCount,
        (SELECT COUNT(*) FROM ${collectionMembers} cm
           INNER JOIN ${productsActive} pa ON pa.id = cm.product_id
           INNER JOIN ${organizationsPublic} op ON op.id = pa.org_id
           WHERE cm.collection_id = c.id) AS productCount
      FROM ${collections} c
      ${featuredFilter}
      ORDER BY c.name
    `),

    // Top-PREVIEW_FETCH org members per collection, windowed so the scan
    // returns a handful of rows per collection instead of every member
    // (#1800 finding 6). Same (position, name) order the interleave expects.
    db.all<{
      collectionSlug: string;
      position: number;
      slug: string;
      name: string;
      domain: string | null;
      avatarUrl: string | null;
      description: string | null;
      githubHandle: string | null;
    }>(sql`
      SELECT collectionSlug, position, slug, name, domain, avatarUrl, description, githubHandle
      FROM (
        SELECT c.slug AS collectionSlug, cm.position AS position,
               op.slug AS slug, op.name AS name, op.domain AS domain,
               op.avatar_url AS avatarUrl, op.description AS description,
               (SELECT handle FROM org_accounts
                  WHERE org_id = op.id AND platform = 'github'
                  ORDER BY created_at, id LIMIT 1) AS githubHandle,
               ROW_NUMBER() OVER (
                 PARTITION BY cm.collection_id ORDER BY cm.position, op.name, op.slug
               ) AS rn
        FROM ${collectionMembers} cm
        INNER JOIN ${collections} c ON c.id = cm.collection_id
        INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
        ${featuredFilter}
      ) WHERE rn <= ${PREVIEW_FETCH}
    `),

    // Top-PREVIEW_FETCH product members per collection, same windowing.
    db.all<{
      collectionSlug: string;
      position: number;
      productSlug: string;
      productName: string;
      productDescription: string | null;
      parentOrgSlug: string;
      parentOrgName: string;
      parentOrgDomain: string | null;
      parentOrgAvatarUrl: string | null;
      parentOrgGithubHandle: string | null;
    }>(sql`
      SELECT collectionSlug, position, productSlug, productName, productDescription,
             parentOrgSlug, parentOrgName, parentOrgDomain, parentOrgAvatarUrl,
             parentOrgGithubHandle
      FROM (
        SELECT c.slug AS collectionSlug, cm.position AS position,
               pa.slug AS productSlug, pa.name AS productName,
               pa.description AS productDescription,
               op.slug AS parentOrgSlug, op.name AS parentOrgName,
               op.domain AS parentOrgDomain, op.avatar_url AS parentOrgAvatarUrl,
               (SELECT handle FROM org_accounts
                  WHERE org_id = op.id AND platform = 'github'
                  ORDER BY created_at, id LIMIT 1) AS parentOrgGithubHandle,
               ROW_NUMBER() OVER (
                 PARTITION BY cm.collection_id ORDER BY cm.position, pa.name, pa.slug
               ) AS rn
        FROM ${collectionMembers} cm
        INNER JOIN ${collections} c ON c.id = cm.collection_id
        INNER JOIN ${productsActive} pa ON pa.id = cm.product_id
        INNER JOIN ${organizationsPublic} op ON op.id = pa.org_id
        ${featuredFilter}
      ) WHERE rn <= ${PREVIEW_FETCH}
    `),
  ]);

  const orgsBySlug = new Map<string, OrgMemberRow[]>();
  for (const r of orgMemberRows) {
    const arr = orgsBySlug.get(r.collectionSlug) ?? [];
    arr.push({
      position: r.position,
      slug: r.slug,
      name: r.name,
      domain: r.domain,
      avatarUrl: r.avatarUrl,
      description: r.description,
      githubHandle: r.githubHandle,
    });
    orgsBySlug.set(r.collectionSlug, arr);
  }
  const productsBySlug = new Map<string, ProductMemberRow[]>();
  for (const r of productMemberRows) {
    const arr = productsBySlug.get(r.collectionSlug) ?? [];
    arr.push({
      position: r.position,
      productSlug: r.productSlug,
      productName: r.productName,
      productDescription: r.productDescription,
      parentOrgSlug: r.parentOrgSlug,
      parentOrgName: r.parentOrgName,
      parentOrgDomain: r.parentOrgDomain,
      parentOrgAvatarUrl: r.parentOrgAvatarUrl,
      parentOrgGithubHandle: r.parentOrgGithubHandle,
    });
    productsBySlug.set(r.collectionSlug, arr);
  }

  return countRows.map((r) => {
    const orgsList = orgsBySlug.get(r.slug) ?? [];
    const productsList = productsBySlug.get(r.slug) ?? [];
    const mixed = interleaveMembers(orgsList, productsList);
    const previewMembers = mixed.slice(0, PREVIEW_LIMIT);
    // Legacy `previewOrgs` — org-kind subset, no `kind` discriminator.
    const previewOrgs = previewMembers
      .filter((m): m is CollectionMember & { kind: "org" } => m.kind === "org")
      .map(({ kind: _k, ...rest }) => rest);
    const memberCount = Number(r.orgCount) + Number(r.productCount);
    return {
      slug: r.slug,
      name: r.name,
      description: r.description,
      memberCount,
      isFeatured: Boolean(r.isFeatured),
      previewMembers,
      previewOrgs,
    };
  });
}

/** Lookup a collection by slug. Shared by GraphQL `Query.collection` and REST. */
export async function getCollectionBySlug(db: D1Db, slug: string): Promise<CollectionRow | null> {
  const [row] = await db.select().from(collections).where(eq(collections.slug, slug)).limit(1);
  return row ?? null;
}

/**
 * Full ordered member list for a collection detail page. Same joins / interleave
 * as REST `GET /v1/collections/:slug` (orgs via `organizations_public`, products
 * via `products_active` + visible parent org). Shared with GraphQL
 * `Collection.members` (#2047).
 */
export async function getCollectionFullMembers(
  db: D1Db,
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

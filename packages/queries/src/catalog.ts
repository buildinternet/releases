/**
 * Catalog reads: products and the sources under them.
 *
 * Visibility follows the API: soft-deleted products (`products_active`) and
 * hidden or soft-deleted sources (`sources_visible`) never appear, and
 * neither do children of a soft-deleted org (`organizations_active`).
 */
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { sourcesVisible } from "@buildinternet/releases-core/schema";
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import type { AnyDb } from "@releases/lib/db";

/**
 * Visible sources bound to a product, by name. Backs the `GET /v1/products/:id`
 * source list and MCP product detail.
 */
export function listProductSources(db: AnyDb, productId: string) {
  return db
    .select({
      id: sourcesVisible.id,
      slug: sourcesVisible.slug,
      name: sourcesVisible.name,
      type: sourcesVisible.type,
      url: sourcesVisible.url,
      metadata: sourcesVisible.metadata,
      kind: sourcesVisible.kind,
      lastFetchedAt: sourcesVisible.lastFetchedAt,
    })
    .from(sourcesVisible)
    .where(eq(sourcesVisible.productId, productId))
    .orderBy(asc(sourcesVisible.name));
}

export interface CatalogFilter {
  orgId?: string;
  /** Direct match on the row's own kind (no source → product inheritance). */
  kind?: string;
}

export interface CatalogProductRow {
  slug: string;
  name: string;
  url: string | null;
  description: string | null;
  category: string | null;
  orgSlug: string;
  orgName: string;
}

export interface CatalogStandaloneSourceRow {
  slug: string;
  name: string;
  type: SourceType;
  url: string | null;
  lastFetchedAt: string | null;
  orgSlug: string;
  orgName: string;
}

/** Active products, optionally scoped to one org and filtered by kind. */
export function listCatalogProducts(
  db: AnyDb,
  f: CatalogFilter = {},
): Promise<CatalogProductRow[]> {
  const conds: SQL[] = [];
  if (f.orgId) conds.push(sql`p.org_id = ${f.orgId}`);
  if (f.kind) conds.push(sql`p.kind = ${f.kind}`);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
  return db.all<CatalogProductRow>(sql`
    SELECT p.slug, p.name, p.url, p.description, p.category,
           o.slug AS orgSlug, o.name AS orgName
    FROM products_active p
    JOIN organizations_active o ON o.id = p.org_id
    ${where}
    ORDER BY p.name, p.slug
  `);
}

/**
 * Visible sources not listed under an active product: no `product_id`, or a
 * `product_id` that points at a soft-deleted product (so the source stays
 * discoverable once its product is tombstoned).
 */
export function listCatalogStandaloneSources(
  db: AnyDb,
  f: CatalogFilter = {},
): Promise<CatalogStandaloneSourceRow[]> {
  return db.all<CatalogStandaloneSourceRow>(sql`
    SELECT s.slug, s.name, s.type, s.url, s.last_fetched_at AS lastFetchedAt,
           o.slug AS orgSlug, o.name AS orgName
    FROM sources_visible s
    JOIN organizations_active o ON o.id = s.org_id
    WHERE (s.product_id IS NULL OR s.product_id NOT IN (SELECT id FROM products_active))
      ${f.orgId ? sql`AND s.org_id = ${f.orgId}` : sql``}
      ${f.kind ? sql`AND s.kind = ${f.kind}` : sql``}
    ORDER BY s.name, s.slug
  `);
}

/**
 * IDs of a product's visible sources, for product-scoped reads
 * (`/v1/search?product=`, MCP `search` and `get_latest_releases`). Deleted
 * and hidden sources are left out: every downstream read drops them anyway,
 * and the scope list is capped at `IN_ARRAY_CHUNK_SIZE`, so dead IDs could
 * crowd out live ones.
 */
export async function listVisibleSourceIdsForProduct(
  db: AnyDb,
  productId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: sourcesVisible.id })
    .from(sourcesVisible)
    .where(eq(sourcesVisible.productId, productId));
  return rows.map((r) => r.id);
}

/** Sibling of `listVisibleSourceIdsForProduct` for an org scope. */
export async function listVisibleSourceIdsForOrg(db: AnyDb, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sourcesVisible.id })
    .from(sourcesVisible)
    .where(eq(sourcesVisible.orgId, orgId));
  return rows.map((r) => r.id);
}

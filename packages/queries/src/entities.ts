/**
 * Entity resolution for orgs, sources, and products — the typed-ID and
 * org-scoped (`org/slug`) lookup paths shared by the API and MCP workers.
 *
 * Every predicate excludes soft-deleted rows by default (#666). Pass
 * `{ includeDeleted: true }` only for admin paths that need tombstones
 * (hard-purge DELETE, restore). The MCP resolvers use the default.
 *
 * Bare-slug resolution policy is NOT here: the API rejects bare slugs on
 * legacy paths (`BareSlugRejected`, #698) and the MCP throws on cross-org
 * ambiguity (#1324). Only the enumeration query the MCP policy runs on
 * (`listSourcesBySlug` / `listProductsBySlug`) lives here.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  organizations,
  organizationsActive,
  products,
  productsActive,
  sources,
} from "@buildinternet/releases-core/schema";
import type { AnyDb } from "@releases/lib/db";

export interface IncludeDeletedOpts {
  includeDeleted?: boolean;
}

export type SourceRow = typeof sources.$inferSelect;
export type ProductRow = typeof products.$inferSelect;

/** True if the string looks like a `src_…` source ID. */
export function isSourceId(s: string): boolean {
  return s.startsWith("src_");
}

/** True if the string looks like a `prod_…` product ID. */
export function isProductId(s: string): boolean {
  return s.startsWith("prod_");
}

/**
 * Match a source by ID (`src_` prefix). Id-only — the slug branch lives in
 * `sourceMatchByIdOrSlug` (legacy fallback) or `findSourceForOrgSlug`
 * (org-scoped).
 */
export function sourceById(id: string, opts?: IncludeDeletedOpts) {
  const match = eq(sources.id, id);
  return opts?.includeDeleted ? match : and(match, isNull(sources.deletedAt));
}

/**
 * Match an org by ID (`org_` prefix) or slug. Orgs stay globally addressable
 * by slug — `organizations.slug` keeps its global UNIQUE (only sources and
 * products were demoted to per-org uniqueness in #690 Phase C).
 */
export function orgWhere(identifier: string, opts?: IncludeDeletedOpts) {
  const match = identifier.startsWith("org_")
    ? eq(organizations.id, identifier)
    : eq(organizations.slug, identifier);
  return opts?.includeDeleted ? match : and(match, isNull(organizations.deletedAt));
}

/** Match a product by ID (`prod_` prefix). Id-only — see `sourceById`. */
export function productById(id: string, opts?: IncludeDeletedOpts) {
  const match = eq(products.id, id);
  return opts?.includeDeleted ? match : and(match, isNull(products.deletedAt));
}

/**
 * Legacy "either id or slug" matcher for internal callers that admin tooling
 * and worker triggers still depend on. Prefer `sourceById` plus
 * `findSourceForOrgSlug` in new code — the slug branch degrades to "first row
 * wins by rowid" if cross-org slug collisions appear.
 */
export function sourceMatchByIdOrSlug(idOrSlug: string, opts?: IncludeDeletedOpts) {
  const match = isSourceId(idOrSlug) ? eq(sources.id, idOrSlug) : eq(sources.slug, idOrSlug);
  return opts?.includeDeleted ? match : and(match, isNull(sources.deletedAt));
}

/** Sibling of `sourceMatchByIdOrSlug` for products. */
export function productMatchByIdOrSlug(idOrSlug: string, opts?: IncludeDeletedOpts) {
  const match = isProductId(idOrSlug) ? eq(products.id, idOrSlug) : eq(products.slug, idOrSlug);
  return opts?.includeDeleted ? match : and(match, isNull(products.deletedAt));
}

/** Fetch one source row by typed `src_` ID, or null. */
export async function findSourceById(
  db: AnyDb,
  id: string,
  opts?: IncludeDeletedOpts,
): Promise<SourceRow | null> {
  const [row] = await db.select().from(sources).where(sourceById(id, opts)).limit(1);
  return row ?? null;
}

/** Fetch one product row by typed `prod_` ID, or null. */
export async function findProductById(
  db: AnyDb,
  id: string,
  opts?: IncludeDeletedOpts,
): Promise<ProductRow | null> {
  const [row] = await db.select().from(products).where(productById(id, opts)).limit(1);
  return row ?? null;
}

/**
 * Resolve a source within an org (#690). The org segment accepts an ID
 * (`org_…`) or a slug; the source segment accepts an ID (`src_…`) or a slug.
 * Per-org slug uniqueness is what makes the slug branch unambiguous here.
 */
export async function findSourceForOrgSlug(
  db: AnyDb,
  orgIdOrSlug: string,
  sourceIdOrSlug: string,
  opts?: IncludeDeletedOpts,
): Promise<SourceRow | null> {
  const rows = await db
    .select({ source: sources })
    .from(sources)
    .innerJoin(organizations, eq(sources.orgId, organizations.id))
    .where(and(orgWhere(orgIdOrSlug, opts), sourceMatchByIdOrSlug(sourceIdOrSlug, opts)))
    .limit(1);
  return rows[0]?.source ?? null;
}

/** Sibling of `findSourceForOrgSlug` for products. */
export async function findProductForOrgSlug(
  db: AnyDb,
  orgIdOrSlug: string,
  productIdOrSlug: string,
  opts?: IncludeDeletedOpts,
): Promise<ProductRow | null> {
  const rows = await db
    .select({ product: products })
    .from(products)
    .innerJoin(organizations, eq(products.orgId, organizations.id))
    .where(and(orgWhere(orgIdOrSlug, opts), productMatchByIdOrSlug(productIdOrSlug, opts)))
    .limit(1);
  return rows[0]?.product ?? null;
}

/** One bare-slug match, with its org's slug for ambiguity candidates. */
export interface SlugMatch<Row> {
  row: Row;
  orgSlug: string;
}

/**
 * Every live source with this slug, across live orgs. Source slugs are unique
 * per org, not globally (#690), so a bare slug can match several rows; the
 * caller decides what ambiguity means. Joins `organizations_active` like the
 * API's `/v1/lookups/source-by-slug`, so a deleted org's sources don't match.
 */
export async function listSourcesBySlug(db: AnyDb, slug: string): Promise<SlugMatch<SourceRow>[]> {
  return db
    .select({ row: sources, orgSlug: organizationsActive.slug })
    .from(sources)
    .innerJoin(organizationsActive, eq(sources.orgId, organizationsActive.id))
    .where(and(eq(sources.slug, slug), isNull(sources.deletedAt)));
}

/** Sibling of `listSourcesBySlug` for products. */
export async function listProductsBySlug(
  db: AnyDb,
  slug: string,
): Promise<SlugMatch<ProductRow>[]> {
  return db
    .select({ row: products, orgSlug: organizationsActive.slug })
    .from(products)
    .innerJoin(organizationsActive, eq(products.orgId, organizationsActive.id))
    .where(and(eq(products.slug, slug), isNull(products.deletedAt)));
}

/** A source's (or product's) parents as detail reads name them. */
export interface LiveParents {
  org: { id: string; slug: string; name: string } | null;
  product: { id: string; slug: string; name: string } | null;
}

/**
 * Look up the org and product a detail read attributes a row to. Reads
 * `organizations_active` / `products_active`, so a soft-deleted parent comes
 * back null instead of being named by its tombstoned slug — the same rule
 * `findVisibleReleaseDetail` applies to release parents.
 */
export async function findLiveParents(
  db: AnyDb,
  ids: { orgId: string | null; productId: string | null },
): Promise<LiveParents> {
  const [orgRows, productRows] = await Promise.all([
    ids.orgId
      ? db
          .select({
            id: organizationsActive.id,
            slug: organizationsActive.slug,
            name: organizationsActive.name,
          })
          .from(organizationsActive)
          .where(eq(organizationsActive.id, ids.orgId))
          .limit(1)
      : Promise.resolve([]),
    ids.productId
      ? db
          .select({ id: productsActive.id, slug: productsActive.slug, name: productsActive.name })
          .from(productsActive)
          .where(eq(productsActive.id, ids.productId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  return { org: orgRows[0] ?? null, product: productRows[0] ?? null };
}

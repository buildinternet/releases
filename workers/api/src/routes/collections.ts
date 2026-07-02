import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, and, inArray, isNull, sql, asc } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  collections,
  collectionMembers,
  organizations,
  organizationsPublic,
  products,
  productsActive,
} from "@buildinternet/releases-core/schema";
import { embedAndUpsertEntities } from "@releases/search/embed-entities.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { newCollectionId } from "@buildinternet/releases-core/id";
import { toSlug } from "@buildinternet/releases-core/slug";
import {
  buildFeedCursor,
  formatAggregateReleaseRow,
  parseLimitParam,
  parseBoolParam,
  isConflictError,
  orgWhere,
  isProductId,
  productById,
  findProductForOrgSlug,
} from "../utils.js";
import { etDayKey, addDaysToDateKey, isDateKey } from "@buildinternet/releases-core/dates";
import { getCollectionReleasesFeed } from "../queries/orgs.js";
import { listCollectionDailySummaries } from "../queries/collection-summaries.js";
import { parseSourceTypesLenient } from "../lib/source-types.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { collectionReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import type { Env } from "../index.js";
import {
  CollectionListResponseSchema,
  CollectionDetailSchema,
  CollectionReleasesResponseSchema,
  CollectionDailySummariesResponseSchema,
  CollectionRowSchema,
  CreateCollectionRequestSchema,
  UpdateCollectionRequestSchema,
  AddCollectionMemberRequestSchema,
  AddCollectionMemberResponseSchema,
  ReplaceCollectionMembersRequestSchema,
  ReplaceCollectionMembersResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import type {
  CollectionDetail,
  CollectionListItem,
  CollectionMember,
  CollectionMemberOrg,
  CollectionMemberProduct,
  CollectionReleaseItem,
  CollectionRow,
  CollectionMemberInput,
  ProductParentOrg,
  ResolvedCollectionMember,
} from "@buildinternet/releases-api-types";
import { validateJson } from "../lib/validate.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError, NotFoundError, ConflictError } from "@releases/lib/releases-error";

export const collectionRoutes = new Hono<Env>();

// Slug shape for collections — top-level resource path /collections/<slug>, so
// only the `/collections/...` namespace matters. Lowercased alphanumeric +
// hyphens, must start with an alnum, 2–64 chars.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SLUG_HINT = "Use lowercase letters, digits, and hyphens (2–64 chars, alnum start).";

function rowToWire(row: typeof collections.$inferSelect): CollectionRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    isFeatured: row.isFeatured,
    dailySummaryEnabled: row.dailySummaryEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findCollectionBySlug(db: ReturnType<typeof createDb>, slug: string) {
  const [row] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.slug, slug));
  return row ?? null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// D1 caps each prepared statement at 100 bound parameters. `inArray` lookups
// chunk at 90 to leave headroom for the `deletedAt IS NULL` guard; bulk
// inserts chunk at 20 (5 binds × 20 = 100 — `collection_id`, `org_id`,
// `product_id`, `position`, `created_at`).
const IN_LOOKUP_CHUNK = 90;
const INSERT_CHUNK = 20;

// ── Member input resolution ──────────────────────────────────────────────

type ResolvedOrg = { kind: "org"; orgId: string };
type ResolvedProduct = { kind: "product"; productId: string };
type ResolvedRef = ResolvedOrg | ResolvedProduct;

type ResolutionError = { ok: false; status: 400 | 404; message: string };
type ResolutionOk<T> = { ok: true; value: T };
type Resolution<T> = ResolutionOk<T> | ResolutionError;

/** Categorize a single input into the kind it targets, or fail early. */
function classifyMemberInput(
  m: CollectionMemberInput,
): Resolution<{ kind: "org" | "product"; m: CollectionMemberInput }> {
  const hasOrgRef = m.orgId !== undefined || m.orgSlug !== undefined;
  const hasProductRef = m.productId !== undefined || m.productSlug !== undefined;
  // productSlug requires an org context to disambiguate (post-#690 product
  // slugs are per-org). productId alone is fine — `prod_…` is globally unique.
  const productSlugWithoutContext =
    m.productSlug !== undefined && m.productId === undefined && !hasOrgRef;
  if (productSlugWithoutContext) {
    return {
      ok: false,
      status: 400,
      message:
        "productSlug requires an org context — supply productId, or pair productSlug with orgSlug/orgId.",
    };
  }
  // Reject mixed refs except the legitimate "productSlug + org context" case
  // — otherwise an `{ orgSlug, productId }` payload would silently drop the
  // org ref and resolve as a product.
  const isProductSlugWithContext =
    m.productSlug !== undefined && m.productId === undefined && hasOrgRef;
  if (hasOrgRef && hasProductRef && !isProductSlugWithContext) {
    return {
      ok: false,
      status: 400,
      message:
        "Provide either an org ref or a product ref, or pair productSlug with orgSlug/orgId — not both.",
    };
  }
  if (hasProductRef) return { ok: true, value: { kind: "product", m } };
  if (hasOrgRef) return { ok: true, value: { kind: "org", m } };
  return { ok: false, status: 400, message: "Each member requires orgId, orgSlug, or productId." };
}

async function resolveMemberRef(
  db: ReturnType<typeof createDb>,
  m: CollectionMemberInput,
): Promise<Resolution<ResolvedRef>> {
  const classified = classifyMemberInput(m);
  if (!classified.ok) return classified;
  if (classified.value.kind === "org") {
    const ref = m.orgId ?? m.orgSlug!;
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(ref));
    if (!row) return { ok: false, status: 404, message: `Org not found: ${ref}` };
    return { ok: true, value: { kind: "org", orgId: row.id } };
  }
  if (m.productId) {
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(productById(m.productId));
    if (!row) return { ok: false, status: 404, message: `Product not found: ${m.productId}` };
    return { ok: true, value: { kind: "product", productId: row.id } };
  }
  const orgRef = (m.orgId ?? m.orgSlug)!;
  const product = await findProductForOrgSlug(db, orgRef, m.productSlug!);
  if (!product) {
    return { ok: false, status: 404, message: `Product not found: ${orgRef}/${m.productSlug}` };
  }
  return { ok: true, value: { kind: "product", productId: product.id } };
}

/**
 * Batched variant for PUT: resolves every member with at most a handful of
 * IN-queries (one per shape: org ids, org slugs, product ids, product
 * slugs-with-context). Membership lists are bounded — D1's 100-bind cap
 * leaves plenty of headroom for any realistic collection.
 */
async function resolveMembersBatch(
  db: ReturnType<typeof createDb>,
  members: CollectionMemberInput[],
): Promise<Resolution<Array<{ ref: ResolvedRef; position: number }>>> {
  const classified: Array<{ kind: "org" | "product"; m: CollectionMemberInput }> = [];
  for (const m of members) {
    const r = classifyMemberInput(m);
    if (!r.ok) return r;
    classified.push(r.value);
  }

  const orgIds = new Set<string>();
  const orgSlugs = new Set<string>();
  const productIds = new Set<string>();
  // (orgRef, productSlug) pairs deduped by `${orgRef}::${productSlug}`.
  const productSlugWithContext = new Map<string, { orgRef: string; productSlug: string }>();

  for (const { kind, m } of classified) {
    if (kind === "org") {
      if (m.orgId) orgIds.add(m.orgId);
      else orgSlugs.add(m.orgSlug!);
    } else if (m.productId) {
      productIds.add(m.productId);
    } else {
      const orgRef = (m.orgId ?? m.orgSlug)!;
      const key = `${orgRef}::${m.productSlug!}`;
      productSlugWithContext.set(key, { orgRef, productSlug: m.productSlug! });
    }
  }

  const orgIdMap = new Map<string, string>();
  const orgSlugMap = new Map<string, string>();
  const productIdMap = new Map<string, string>();
  const productSlugContextMap = new Map<string, string>();

  const lookups: Promise<void>[] = [];
  for (const idChunk of chunk([...orgIds], IN_LOOKUP_CHUNK)) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(inArray(organizations.id, idChunk), isNull(organizations.deletedAt)));
        for (const r of rows) orgIdMap.set(r.id, r.id);
      })(),
    );
  }
  for (const slugChunk of chunk([...orgSlugs], IN_LOOKUP_CHUNK)) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: organizations.id, slug: organizations.slug })
          .from(organizations)
          .where(and(inArray(organizations.slug, slugChunk), isNull(organizations.deletedAt)));
        for (const r of rows) orgSlugMap.set(r.slug, r.id);
      })(),
    );
  }
  for (const idChunk of chunk([...productIds], IN_LOOKUP_CHUNK)) {
    lookups.push(
      (async () => {
        const rows = await db
          .select({ id: products.id })
          .from(products)
          .where(and(inArray(products.id, idChunk), isNull(products.deletedAt)));
        for (const r of rows) productIdMap.set(r.id, r.id);
      })(),
    );
  }
  // (orgRef, productSlug) pairs need both fields per row, so a single IN
  // would over-match. Membership lists are bounded (<~20 in practice) and
  // admin writes are low-frequency — the N+1 here is intentional.
  if (productSlugWithContext.size > 0) {
    for (const [key, { orgRef, productSlug }] of productSlugWithContext) {
      lookups.push(
        (async () => {
          const product = await findProductForOrgSlug(db, orgRef, productSlug);
          if (product) productSlugContextMap.set(key, product.id);
        })(),
      );
    }
  }
  await Promise.all(lookups);

  const resolved: Array<{ ref: ResolvedRef; position: number }> = [];
  const seenKey = new Set<string>();
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    const kind = classified[i]!.kind;
    let ref: ResolvedRef | null = null;
    if (kind === "org") {
      const orgRef = (m.orgId ?? m.orgSlug)!;
      const orgId = m.orgId ? orgIdMap.get(orgRef) : orgSlugMap.get(orgRef);
      if (!orgId) return { ok: false, status: 404, message: `Org not found: ${orgRef}` };
      ref = { kind: "org", orgId };
    } else if (m.productId) {
      const productId = productIdMap.get(m.productId);
      if (!productId) {
        return { ok: false, status: 404, message: `Product not found: ${m.productId}` };
      }
      ref = { kind: "product", productId };
    } else {
      const orgRef = (m.orgId ?? m.orgSlug)!;
      const key = `${orgRef}::${m.productSlug!}`;
      const productId = productSlugContextMap.get(key);
      if (!productId) {
        return {
          ok: false,
          status: 404,
          message: `Product not found: ${orgRef}/${m.productSlug}`,
        };
      }
      ref = { kind: "product", productId };
    }
    const dedupKey = ref.kind === "org" ? `org:${ref.orgId}` : `product:${ref.productId}`;
    if (seenKey.has(dedupKey)) {
      return {
        ok: false,
        status: 400,
        message: `Duplicate member in list: ${dedupKey}`,
      };
    }
    seenKey.add(dedupKey);
    resolved.push({ ref, position: m.position ?? i });
  }
  return { ok: true, value: resolved };
}

function resolvedToWire(r: ResolvedRef, position: number): ResolvedCollectionMember {
  if (r.kind === "org") return { kind: "org", orgId: r.orgId, position };
  return { kind: "product", productId: r.productId, position };
}

// ── Read-side shaping ────────────────────────────────────────────────────

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

// Correlated subquery used to pick a single deterministic github handle per
// org so a multi-handle org doesn't fan out the JOIN. `org_accounts` only
// enforces UNIQUE(platform, handle) globally — not per (org, platform).
function parseSlugSet(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function githubHandleSubquery(orgIdExpr: ReturnType<typeof sql>) {
  return sql<string | null>`(
    SELECT handle FROM org_accounts
    WHERE org_id = ${orgIdExpr} AND platform = 'github'
    ORDER BY created_at, id LIMIT 1
  )`;
}

collectionRoutes.get(
  "/collections",
  describeRoute({
    tags: ["Collections"],
    summary: "List curated collections",
    description:
      "Returns every collection with a member count and a small `previewMembers` array (capped at 3) so the list page can render inline avatars without a second round trip. `previewMembers` is the mixed-kind preview (orgs and products); `previewOrgs` is the legacy org-only preview retained for back-compat. Member counts and previews are joined through `organizations_public` (for orgs) and `products_active` (for products), so soft-deleted / on_demand rows never inflate the totals. Pass `?featured=1` to return only homepage-featured collections.",
    parameters: [
      {
        name: "featured",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["1", "true"] },
        description: "When `1` (or `true`), return only homepage-featured collections.",
      },
    ],
    responses: {
      200: {
        description: "Collections, ordered by name (optionally filtered to featured).",
        content: { "application/json": { schema: resolver(CollectionListResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);

    // `?featured=1` (or `featured=true`) narrows the list to homepage-promoted
    // collections; absent/other values return everything.
    const featuredParam = c.req.query("featured");
    const featuredOnly = featuredParam === "1" || featuredParam === "true";
    const featuredFilter = featuredOnly ? sql`WHERE c.is_featured = 1` : sql``;
    // Per-collection preview cap. The list renders only the top PREVIEW_LIMIT
    // (3) interleaved members; the SQL fetches the top PREVIEW_FETCH per kind
    // (windowed via ROW_NUMBER) instead of every member (#1800 finding 6). This
    // is exact, not a heuristic margin: `interleaveMembers` orders by the SAME
    // (position, name, slug) key with the SAME BINARY collation as the SQL
    // window (see binCompare), so any global top-3 member is within the top-3
    // of its own kind's window — PREVIEW_FETCH > 3 is just headroom.
    const PREVIEW_FETCH = 12;

    const [countRows, orgMemberRows, productMemberRows] = await Promise.all([
      // Raw correlated subqueries (Drizzle's relational `${collections.id}`
      // gets confused by `id` columns on multiple aliases in the inner scope).
      // Both kinds gate through `organizations_public` — products joined via
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

    const PREVIEW_LIMIT = 3;
    const body: CollectionListItem[] = countRows.map((r) => {
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
    return c.json(body);
  },
);

collectionRoutes.get(
  "/collections/:slug",
  describeRoute({
    tags: ["Collections"],
    summary: "Get a collection's detail page payload",
    description:
      "Returns the collection's name/description plus its ordered members. `members` is the canonical mixed-kind list (orgs + products); `orgs` is the legacy org-only subset retained for back-compat. Orgs join through `organizations_public` and products through `products_active`, so soft-deleted / on_demand rows never leak via a collection. GitHub handles are picked deterministically from `org_accounts` so multi-handle orgs don't fan out the row.",
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
    ],
    responses: {
      200: {
        description: "Collection detail with ordered members.",
        content: { "application/json": { schema: resolver(CollectionDetailSchema) } },
      },
      404: {
        description: "No collection with that slug.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);

    const [collection] = await db.select().from(collections).where(eq(collections.slug, slug));
    if (!collection) {
      return respondError(c, new NotFoundError("Collection not found"));
    }

    const [orgsList, productsList] = await Promise.all([
      db
        .select({
          position: collectionMembers.position,
          slug: organizationsPublic.slug,
          name: organizationsPublic.name,
          domain: organizationsPublic.domain,
          avatarUrl: organizationsPublic.avatarUrl,
          description: organizationsPublic.description,
          githubHandle: githubHandleSubquery(sql`${organizationsPublic.id}`),
        })
        .from(collectionMembers)
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
        .where(eq(collectionMembers.collectionId, collection.id))
        .orderBy(collectionMembers.position, organizationsPublic.name),
      db
        .select({
          position: collectionMembers.position,
          productSlug: productsActive.slug,
          productName: productsActive.name,
          productDescription: productsActive.description,
          parentOrgSlug: organizationsPublic.slug,
          parentOrgName: organizationsPublic.name,
          parentOrgDomain: organizationsPublic.domain,
          parentOrgAvatarUrl: organizationsPublic.avatarUrl,
          parentOrgGithubHandle: githubHandleSubquery(sql`${organizationsPublic.id}`),
        })
        .from(collectionMembers)
        .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
        .where(eq(collectionMembers.collectionId, collection.id))
        .orderBy(collectionMembers.position, productsActive.name),
    ]);

    const members = interleaveMembers(orgsList, productsList);
    // Legacy `orgs` field — org-kind members only, without the `kind` discriminator.
    const orgs: CollectionMemberOrg[] = members
      .filter((m): m is CollectionMember & { kind: "org" } => m.kind === "org")
      .map(({ kind: _k, ...rest }) => rest);

    const body: CollectionDetail = {
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
      isFeatured: collection.isFeatured,
      dailySummaryEnabled: collection.dailySummaryEnabled,
      members,
      orgs,
    };
    return c.json(body);
  },
);

// Cursor model and ordering match /v1/orgs/:slug/releases so the same web
// cursor parser works on both surfaces.
collectionRoutes.get(
  "/collections/:slug/releases",
  describeRoute({
    tags: ["Collections"],
    summary: "Interleaved release feed across a collection's members",
    description:
      "Cursor-paginated cross-member feed for the collection. Cursor shape and ordering match `/v1/orgs/:slug/releases`, so the same web parser works on both surfaces. Org members are resolved through `organizations_public`, product members through `products_active`, so soft-deleted / on_demand rows never contribute releases. Empty membership returns `releases: []` rather than an error.\n\n`orgs` and `products` query params each accept a comma-separated list of slugs and narrow the feed to that subset of the collection's members. Unknown slugs are silently dropped; passing values that resolve to an empty member set returns `releases: []`. Omit both to include every member.\n\nSupports `Accept: text/markdown` for an LLM-friendly rendering.",
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        description: "Page size. Clamped to 1–100.",
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Opaque pagination cursor returned by a prior call.",
      },
      {
        name: "include_prereleases",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description: "Include rows flagged as prereleases. Defaults to false.",
      },
      {
        name: "orgs",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Comma-separated org slugs to narrow the feed to a subset of the collection's org members.",
      },
      {
        name: "products",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Comma-separated product slugs to narrow the feed to a subset of the collection's product members. Product slugs are per-org; ambiguity is resolved by the membership of this specific collection.",
      },
      {
        name: "source_type",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Comma-separated source types (`github`, `feed`, `scrape`, `agent`) to narrow the feed by ingest channel — typically used by the web UI to split GitHub tag drops from marketing posts. Unknown tokens are silently dropped. Omit to include all source types.",
      },
    ],
    responses: {
      200: {
        description: "Cursor-paginated release feed.",
        content: { "application/json": { schema: resolver(CollectionReleasesResponseSchema) } },
      },
      404: {
        description: "No collection with that slug.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const cursorParam = c.req.query("cursor") ?? null;
    const limit = parseLimitParam(c.req.query("limit"), 20, 100);
    const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));
    // `source_type` accepts CSV or repeated query params; unknown values are
    // dropped silently to match the org release-feed convention. `undefined`
    // = no filter; an empty array = caller narrowed to nothing (return []).
    const rawSourceType = c.req.query("source_type");
    const sourceTypes =
      rawSourceType === undefined ? undefined : parseSourceTypesLenient(rawSourceType);

    // `null` here = no narrowing requested; empty Set = caller narrowed to
    // nothing usable (short-circuits to `releases: []` downstream).
    const requestedOrgSlugs = parseSlugSet(c.req.query("orgs"));
    const requestedProductSlugs = parseSlugSet(c.req.query("products"));

    const db = createDb(c.env.DB);

    const [collection] = await db
      .select({ id: collections.id, name: collections.name })
      .from(collections)
      .where(eq(collections.slug, slug));
    if (!collection) {
      return respondError(c, new NotFoundError("Collection not found"));
    }

    // Resolve org + product members through their visible-row views so the
    // feed agrees with the detail page on visible membership.
    const [orgRows, productRows] = await Promise.all([
      db
        .select({ orgId: organizationsPublic.id, slug: organizationsPublic.slug })
        .from(collectionMembers)
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
        .where(eq(collectionMembers.collectionId, collection.id)),
      // Inner-join through organizationsPublic on the parent org so a product
      // attached to an on_demand / soft-deleted org doesn't surface releases.
      db
        .select({ productId: productsActive.id, slug: productsActive.slug })
        .from(collectionMembers)
        .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
        .where(eq(collectionMembers.collectionId, collection.id)),
    ]);

    // Apply optional subset filters. `null` = no narrowing, full member set.
    // When a filter is set on one kind but not the other, narrowing applies
    // only to the named kind — the unset kind still passes through entirely.
    // This keeps the UI behavior "filter chips for what the user toggled" and
    // doesn't accidentally suppress half the feed when a request omits one
    // param.
    const orgIds = (
      requestedOrgSlugs === null ? orgRows : orgRows.filter((m) => requestedOrgSlugs.has(m.slug))
    ).map((m) => m.orgId);
    const productIds = (
      requestedProductSlugs === null
        ? productRows
        : productRows.filter((m) => requestedProductSlugs.has(m.slug))
    ).map((m) => m.productId);

    // `getCollectionReleasesFeed` short-circuits on empty inputs, so an
    // empty-membership collection flows through the same response path as a
    // populated one and honors `Accept: text/markdown` via wantsMarkdown below.
    const results = await getCollectionReleasesFeed(db, orgIds, cursorParam, limit + 1, {
      includePrereleases,
      sourceTypes,
      productIds,
    });

    const hasMore = results.length > limit;
    const pageRows = hasMore ? results.slice(0, limit) : results;

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      nextCursor = buildFeedCursor(pageRows[pageRows.length - 1]);
    }

    const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
    const releasesFormatted: CollectionReleaseItem[] = pageRows.map((r) =>
      formatAggregateReleaseRow(r, mediaOrigin),
    );

    const pagination = { nextCursor, limit };

    if (wantsMarkdown(c)) {
      return markdownResponse(
        c,
        collectionReleaseFeedToMarkdown(slug, collection.name, releasesFormatted, pagination),
      );
    }

    return c.json({ releases: releasesFormatted, pagination });
  },
);

collectionRoutes.get(
  "/collections/:slug/daily-summaries",
  describeRoute({
    tags: ["Collections"],
    summary: "Daily AI summaries for a collection",
    description:
      "Returns AI-generated daily summaries for the collection within the given date window (ET calendar days, inclusive). Defaults to the last 30 days. Rows are ordered newest-first. Summaries are generated nightly by the collection-summaries cron and only exist for days where the collection had at least one visible release.",
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
      {
        name: "from",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Inclusive start date (YYYY-MM-DD, ET). Defaults to 30 days ago.",
      },
      {
        name: "to",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Inclusive end date (YYYY-MM-DD, ET). Defaults to today.",
      },
    ],
    responses: {
      200: {
        description: "Daily summaries for the collection.",
        content: {
          "application/json": { schema: resolver(CollectionDailySummariesResponseSchema) },
        },
      },
      400: {
        description: "Malformed `from`/`to` date (must be YYYY-MM-DD).",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "No collection with that slug.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);

    const collection = await findCollectionBySlug(db, slug);
    if (!collection) return respondError(c, new NotFoundError("Collection not found"));

    const now = new Date();
    const fromParam = c.req.query("from");
    const toParam = c.req.query("to");
    if ((fromParam && !isDateKey(fromParam)) || (toParam && !isDateKey(toParam))) {
      return respondError(
        c,
        new ValidationError("from/to must be YYYY-MM-DD calendar dates", { code: "bad_request" }),
      );
    }
    const from = fromParam ?? addDaysToDateKey(etDayKey(now), -30);
    const to = toParam ?? etDayKey(now);

    const summaries = await listCollectionDailySummaries(db, collection.id, from, to);
    return c.json({ summaries });
  },
);

// ── Admin writes ──────────────────────────────────────────────────────────
// All non-GET methods on /v1/collections inherit auth from
// `publicReadAuthMiddleware` (SAFE_METHODS check) — same model as products and
// sources. No per-route auth call needed here.

collectionRoutes.post(
  "/collections",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Create a collection",
    description:
      "Slug derives from `name` via `toSlug()` when omitted. Slug must match `^[a-z0-9][a-z0-9-]{1,63}$` (lowercased alnum + hyphens, alnum-start, 2–64 chars). Name max 200 chars; description max 2000 chars.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "Collection created.",
        content: { "application/json": { schema: resolver(CollectionRowSchema) } },
      },
      400: {
        description: "Missing/invalid name, slug, or description.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "A collection with that slug already exists.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(CreateCollectionRequestSchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");

    // Trim + post-trim length check stay in the handler — Zod's `.min(1)`
    // doesn't catch all-whitespace strings, and the slug regex check
    // happens after toSlug normalization.
    const name = body.name.trim();
    if (name.length === 0) {
      return respondError(
        c,
        new ValidationError("Missing required field: name", { code: "bad_request" }),
      );
    }
    if (name.length > 200) {
      return respondError(
        c,
        new ValidationError("Name must be 200 characters or fewer", { code: "bad_request" }),
      );
    }

    const slug = (body.slug ?? toSlug(name)).trim();
    if (!SLUG_RE.test(slug)) {
      return respondError(
        c,
        new ValidationError(`Invalid slug "${slug}". ${SLUG_HINT}`, { code: "bad_request" }),
      );
    }

    if (body.description != null && body.description.length > 2000) {
      return respondError(
        c,
        new ValidationError("Description must be 2000 characters or fewer", {
          code: "bad_request",
        }),
      );
    }

    try {
      const now = new Date().toISOString();
      const [created] = await db
        .insert(collections)
        .values({
          id: newCollectionId(),
          slug,
          name,
          description: body.description ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, created.id));
      return c.json(rowToWire(created), 201);
    } catch (err) {
      if (isConflictError(err)) {
        return respondError(
          c,
          new ConflictError(`Collection with slug "${slug}" already exists`, {
            details: { slug },
          }),
        );
      }
      throw err;
    }
  },
);

collectionRoutes.patch(
  "/collections/:slug",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Update a collection's name, slug, or description",
    description:
      "All fields optional; sending none returns the row unchanged. Slug renames are allowed and validated against the same `^[a-z0-9][a-z0-9-]{1,63}$` pattern.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Existing collection slug.",
      },
    ],
    responses: {
      200: {
        description: "Updated collection row.",
        content: { "application/json": { schema: resolver(CollectionRowSchema) } },
      },
      400: {
        description: "Invalid name, slug, or description.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "No collection with that slug.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Slug rename collides with another collection.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(UpdateCollectionRequestSchema),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");

    const [existing] = await db.select().from(collections).where(eq(collections.slug, slug));
    if (!existing) return respondError(c, new NotFoundError("Collection not found"));

    const updates: Partial<typeof collections.$inferInsert> = {};
    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      if (trimmed.length === 0 || trimmed.length > 200) {
        return respondError(
          c,
          new ValidationError("Name must be 1–200 characters", { code: "bad_request" }),
        );
      }
      updates.name = trimmed;
    }
    if (body.description !== undefined) {
      if (body.description != null && body.description.length > 2000) {
        return respondError(
          c,
          new ValidationError("Description must be 2000 characters or fewer", {
            code: "bad_request",
          }),
        );
      }
      updates.description = body.description;
    }
    if (body.slug !== undefined && body.slug !== existing.slug) {
      const next = body.slug.trim();
      if (!SLUG_RE.test(next)) {
        return respondError(
          c,
          new ValidationError(`Invalid slug "${next}". ${SLUG_HINT}`, { code: "bad_request" }),
        );
      }
      updates.slug = next;
    }
    if (body.isFeatured !== undefined) {
      updates.isFeatured = body.isFeatured;
    }
    if (body.dailySummaryEnabled !== undefined) {
      updates.dailySummaryEnabled = body.dailySummaryEnabled;
    }

    if (Object.keys(updates).length === 0) {
      return c.json(rowToWire(existing));
    }
    updates.updatedAt = new Date().toISOString();

    try {
      const [updated] = await db
        .update(collections)
        .set(updates)
        .where(eq(collections.id, existing.id))
        .returning();
      // Re-embed only when name or description changed — slug renames don't
      // affect the embedded text. The check keeps slug-only renames from
      // burning an embed call.
      if (updates.name !== undefined || updates.description !== undefined) {
        c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, updated.id));
      }
      return c.json(rowToWire(updated));
    } catch (err) {
      if (isConflictError(err)) {
        return respondError(
          c,
          new ConflictError(`Collection with slug "${updates.slug}" already exists`, {
            details: { slug: updates.slug },
          }),
        );
      }
      throw err;
    }
  },
);

collectionRoutes.delete(
  "/collections/:slug",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Delete a collection",
    description:
      "Hard delete. `ON DELETE CASCADE` on `collection_members.collection_id` removes the membership rows automatically; the orgs and products themselves are untouched.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
    ],
    responses: {
      204: { description: "Collection deleted." },
      404: {
        description: "No collection with that slug.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);

    const existing = await findCollectionBySlug(db, slug);
    if (!existing) return respondError(c, new NotFoundError("Collection not found"));

    // ON DELETE CASCADE on collection_members.collection_id handles membership.
    await db.delete(collections).where(eq(collections.id, existing.id));
    return c.body(null, 204);
  },
);

// Replace full membership atomically. Position defaults to the array index, so
// the caller can express ordering without numbering.
collectionRoutes.put(
  "/collections/:slug/members",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Replace a collection's full membership atomically",
    description:
      "The request body field is named `orgs` for back-compat but accepts any `CollectionMemberInput` — either an org reference (`orgId` or `orgSlug`) or a product reference (`productId`, or `productSlug` paired with `orgId`/`orgSlug`). Exactly one of those four refs must be set per entry. Position defaults to the array index, so callers can express ordering implicitly by ordering the array.\n\nMembers are resolved in a small number of IN-queries (one per shape) before the write. The replace is delete + insert without a D1 transaction; that's acceptable because membership writes are admin-only and low-frequency. Duplicate orgs or products in the input are rejected before the delete fires.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
    ],
    responses: {
      200: {
        description: "Resolved member list (kind + id + position) after the replace.",
        content: {
          "application/json": { schema: resolver(ReplaceCollectionMembersResponseSchema) },
        },
      },
      400: {
        description: "Missing `orgs` array, entry without a usable ref, or duplicate in the list.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Collection not found, or one of the members didn't resolve.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(ReplaceCollectionMembersRequestSchema),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");

    const existing = await findCollectionBySlug(db, slug);
    if (!existing) return respondError(c, new NotFoundError("Collection not found"));

    const r = await resolveMembersBatch(db, body.orgs);
    if (!r.ok) {
      return respondError(
        c,
        r.status === 404
          ? new NotFoundError(r.message)
          : new ValidationError(r.message, { code: "bad_request" }),
      );
    }
    const resolved = r.value;

    // No D1 transaction primitive — delete + insert is acceptable here because
    // membership writes are admin-only and low-frequency.
    const now = new Date().toISOString();
    await db.delete(collectionMembers).where(eq(collectionMembers.collectionId, existing.id));
    const rows = resolved.map(({ ref, position }) => ({
      collectionId: existing.id,
      orgId: ref.kind === "org" ? ref.orgId : null,
      productId: ref.kind === "product" ? ref.productId : null,
      position,
      createdAt: now,
    }));
    await Promise.all(
      chunk(rows, INSERT_CHUNK).map((rowChunk) => db.insert(collectionMembers).values(rowChunk)),
    );
    await db.update(collections).set({ updatedAt: now }).where(eq(collections.id, existing.id));

    // Membership feeds the embedded "Members:" line — re-embed after replace.
    c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, existing.id));

    return c.json({
      collectionSlug: slug,
      members: resolved.map(({ ref, position }) => resolvedToWire(ref, position)),
    });
  },
);

collectionRoutes.post(
  "/collections/:slug/members",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Add a single member (org or product) to a collection",
    description:
      "`AddCollectionMemberRequest` is one `CollectionMemberInput`. Exactly one of `orgId` / `orgSlug` / `productId` / `productSlug` must be set; `productSlug` requires an org context (`orgId` or `orgSlug`) to disambiguate post-#690 per-org product slugs. Position defaults to 0.\n\nIdempotent at the SQL level via partial-unique indexes on `(collection_id, org_id)` and `(collection_id, product_id)` — re-adding an existing member returns `409 conflict`. Use `PUT /collections/:slug/members` for the atomic replace path.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
    ],
    responses: {
      201: {
        description: "Member added.",
        content: { "application/json": { schema: resolver(AddCollectionMemberResponseSchema) } },
      },
      400: {
        description: "Member entry missing a usable ref, or productSlug without an org context.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Collection not found, or the referenced org/product doesn't exist.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Member is already in the collection.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(AddCollectionMemberRequestSchema),
  async (c) => {
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");

    const existing = await findCollectionBySlug(db, slug);
    if (!existing) return respondError(c, new NotFoundError("Collection not found"));

    const r = await resolveMemberRef(db, body);
    if (!r.ok) {
      return respondError(
        c,
        r.status === 404
          ? new NotFoundError(r.message)
          : new ValidationError(r.message, { code: "bad_request" }),
      );
    }
    const ref = r.value;

    const position = body.position ?? 0;
    const now = new Date().toISOString();
    try {
      await db.insert(collectionMembers).values({
        collectionId: existing.id,
        orgId: ref.kind === "org" ? ref.orgId : null,
        productId: ref.kind === "product" ? ref.productId : null,
        position,
        createdAt: now,
      });
      await db.update(collections).set({ updatedAt: now }).where(eq(collections.id, existing.id));
      c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, existing.id));
      const wire = resolvedToWire(ref, position);
      return c.json({ collectionSlug: slug, ...wire }, 201);
    } catch (err) {
      if (isConflictError(err)) {
        const idText = ref.kind === "org" ? ref.orgId : ref.productId;
        return respondError(
          c,
          new ConflictError(
            `${ref.kind === "org" ? "Org" : "Product"} ${idText} is already a member of collection "${slug}"`,
          ),
        );
      }
      throw err;
    }
  },
);

// `:org` accepts an org id (`org_…`) or slug, mirroring orgWhere(). Kept for
// back-compat — new code can use `DELETE /v1/collections/:slug/members/products/:product`
// for the product side.
collectionRoutes.delete(
  "/collections/:slug/members/:org",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Remove one org from a collection",
    description:
      "`:org` accepts either an `org_…` id or a bare slug, mirroring `orgWhere()`. Only org-kind members are removed via this path; use `DELETE /v1/collections/:slug/members/products/:product` to remove a product member. Returns 404 if the org doesn't exist or isn't a member of the collection — the two cases share a status but carry distinct error messages.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
      {
        name: "org",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Org id (`org_…`) or slug.",
      },
    ],
    responses: {
      204: { description: "Membership removed." },
      404: {
        description: "Collection not found, org not found, or org isn't a member.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c, next) => {
    const orgRef = c.req.param("org");
    // The route prefix `/members/products` is the product-delete path below;
    // Hono's matcher would also match `/members/:org` with org="products"
    // (because "products" isn't an `org_…` ID, just a 8-char slug). Hand off
    // explicitly so `/members/products/:product` always wins.
    if (orgRef === "products") return next();
    const slug = c.req.param("slug");
    const db = createDb(c.env.DB);

    const existing = await findCollectionBySlug(db, slug);
    if (!existing) return respondError(c, new NotFoundError("Collection not found"));

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(orgRef));
    if (!org) return respondError(c, new NotFoundError(`Org not found: ${orgRef}`));

    const result = await db
      .delete(collectionMembers)
      .where(
        and(eq(collectionMembers.collectionId, existing.id), eq(collectionMembers.orgId, org.id)),
      )
      .returning({ orgId: collectionMembers.orgId });
    if (result.length === 0) {
      return respondError(
        c,
        new NotFoundError(`Org ${org.id} is not a member of collection "${slug}"`),
      );
    }
    await db
      .update(collections)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(collections.id, existing.id));
    c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, existing.id));
    return c.body(null, 204);
  },
);

collectionRoutes.delete(
  "/collections/:slug/members/products/:product",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Remove one product from a collection",
    description:
      "`:product` accepts a `prod_…` id. To remove a product by slug, resolve it first via `/v1/orgs/:orgSlug/products/:productSlug` to get the `prod_…` id, then call this endpoint. Returns 404 if the product doesn't exist or isn't a member of the collection.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Collection slug.",
      },
      {
        name: "product",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Product id (`prod_…`).",
      },
    ],
    responses: {
      204: { description: "Membership removed." },
      400: {
        description: "Product ref is not a typed `prod_…` id.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Collection not found, product not found, or product isn't a member.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.param("slug");
    const productRef = c.req.param("product");
    if (!isProductId(productRef)) {
      return respondError(
        c,
        new ValidationError(
          "Product ref must be a typed `prod_…` id; resolve bare slugs first via /v1/orgs/:orgSlug/products/:productSlug.",
          { code: "bad_request" },
        ),
      );
    }
    const db = createDb(c.env.DB);

    const existing = await findCollectionBySlug(db, slug);
    if (!existing) return respondError(c, new NotFoundError("Collection not found"));

    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, productRef), isNull(products.deletedAt)));
    if (!product) {
      return respondError(c, new NotFoundError(`Product not found: ${productRef}`));
    }

    const result = await db
      .delete(collectionMembers)
      .where(
        and(
          eq(collectionMembers.collectionId, existing.id),
          eq(collectionMembers.productId, product.id),
        ),
      )
      .returning({ productId: collectionMembers.productId });
    if (result.length === 0) {
      return respondError(
        c,
        new NotFoundError(`Product ${product.id} is not a member of collection "${slug}"`),
      );
    }
    await db
      .update(collections)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(collections.id, existing.id));
    c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, existing.id));
    return c.body(null, 204);
  },
);

// ── Embed side effect ─────────────────────────────────────────────────
//
// Collections embed cross-org by design — no `orgId` metadata. The text
// payload includes member names (orgs + products) so a topical query
// ("coding agents") can find a collection whose member organizations and
// product picks cover the topic even when the collection's own
// name/description doesn't mention it. Called via
// `c.executionCtx.waitUntil` on every write that could change the embedded
// text: create, update (name/description rename), member add/replace/remove.
// Hard-delete leaves the vector orphaned; the next hydration query won't
// resolve it and it'll fall out of results naturally — same posture as the
// cluster cleanup path in #951.

async function embedCollectionSideEffect(
  env: Env["Bindings"],
  db: ReturnType<typeof createDb>,
  collectionId: string,
  opts?: { throwOnError?: boolean },
): Promise<void> {
  try {
    const embedConfig = await buildEmbedConfig(env);
    if (!embedConfig) return;
    if (!env.ENTITIES_INDEX) return;

    const [col] = await db.select().from(collections).where(eq(collections.id, collectionId));
    if (!col) return;

    // 32 of each then trim after merge — matches the cap in `buildEntityText`
    // so a many-member collection doesn't have one kind monopolize the slot.
    const [orgMembers, productMembers] = await Promise.all([
      db
        .select({ name: organizationsPublic.name, position: collectionMembers.position })
        .from(collectionMembers)
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
        .where(eq(collectionMembers.collectionId, col.id))
        .orderBy(asc(collectionMembers.position), asc(organizationsPublic.name))
        .limit(32),
      db
        .select({
          name: productsActive.name,
          orgName: organizationsPublic.name,
          position: collectionMembers.position,
        })
        .from(collectionMembers)
        .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
        .where(eq(collectionMembers.collectionId, col.id))
        .orderBy(asc(collectionMembers.position), asc(productsActive.name))
        .limit(32),
    ]);
    // Product entries get a `Name · OrgName` label so the embedded "Members:"
    // line carries the parent-org signal too (a topical query for the org's
    // name still matches a collection that only pins one product).
    const memberNames = [
      ...orgMembers.map((r) => ({ position: r.position, name: r.name })),
      ...productMembers.map((r) => ({
        position: r.position,
        name: `${r.name} · ${r.orgName}`,
      })),
    ]
      .toSorted((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((r) => r.name);

    await embedAndUpsertEntities({
      entities: [
        {
          id: col.id,
          kind: "collection",
          name: col.name,
          description: col.description,
          memberNames,
        },
      ],
      // Same cast as orgs/products/sources — see embedSourceSideEffect.
      vectorIndex:
        env.ENTITIES_INDEX as unknown as import("@releases/search/vector-search.js").VectorizeIndex,
      embedConfig,
      onPersisted: async () => {
        await db
          .update(collections)
          .set({ embeddedAt: new Date().toISOString() })
          .where(eq(collections.id, col.id));
      },
      throwOnError: opts?.throwOnError,
    });
  } catch (err) {
    if (opts?.throwOnError) throw err;
    logEvent("warn", {
      component: "collections",
      event: "embed-side-effect-failed",
      err: err instanceof Error ? err : String(err),
      ...dbErrorLogFields(err),
    });
  }
}

import { eq, inArray, and, isNull } from "drizzle-orm";
import {
  tags,
  sources,
  organizations,
  products,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import { resolveDateParam } from "@buildinternet/releases-core/dates";
import { hydrateMediaUrls, resolveR2Url } from "@releases/rendering/media-url.js";
import type { CollectionReleaseItem, MediaItem } from "@buildinternet/releases-api-types";
import type { AggregateReleaseRow } from "@releases/core-internal/feed-cursor";
import type { createDb } from "./db.js";
export { hydrateMediaUrls, resolveR2Url } from "@releases/rendering/media-url.js";

/**
 * Shape a cross-org feed row into the wire-format `CollectionReleaseItem`
 * (also satisfies `CategoryReleaseItem`, which is a structural alias).
 * Centralized so collection and category routes never drift on field
 * truncation / media hydration / source-type narrowing.
 */
export function formatAggregateReleaseRow(
  r: AggregateReleaseRow,
  mediaOrigin: string,
): CollectionReleaseItem {
  return {
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary: r.summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    titleGenerated: r.title_generated,
    titleShort: r.title_short,
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
    prerelease: r.prerelease === 1,
    source: { slug: r.source_slug, name: r.source_name, type: r.source_type },
    org: { slug: r.org_slug, name: r.org_name },
    product:
      r.product_slug && r.product_name ? { slug: r.product_slug, name: r.product_name } : null,
    coverageCount: r.coverage_count,
  };
}

type RawMediaRow = MediaItem & { r2Key?: string | null };

/**
 * Parse a `releases.media` JSON blob and resolve each entry's `r2Key` into a
 * signed `r2Url` so the web never sees raw R2 keys. Malformed JSON collapses
 * to an empty list rather than throwing — one bad row shouldn't blank a page.
 */
export function parseReleaseMedia(raw: string | null, mediaOrigin: string): MediaItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((m: RawMediaRow) =>
    Object.assign({}, m, { r2Url: resolveR2Url(m.r2Key, mediaOrigin) }),
  );
}

/**
 * Resolve a source by ID (`src_` prefix). Id-only — the slug branch lives
 * in `sourceMatchByIdOrSlug` (legacy fallback) or `findSourceForOrgSlug`
 * (org-scoped). Excludes soft-deleted rows by default (#666); pass
 * `{ includeDeleted: true }` for admin paths that need to see tombstones
 * (hard-purge DELETE, restore).
 */
export function sourceById(id: string, opts?: { includeDeleted?: boolean }) {
  const match = eq(sources.id, id);
  return opts?.includeDeleted ? match : and(match, isNull(sources.deletedAt));
}

/**
 * Resolve an org by ID (`org_` prefix) or slug. Orgs stay globally addressable
 * by slug — `organizations.slug` keeps its global UNIQUE (only sources and
 * products were demoted to per-org uniqueness in #690 Phase C).
 */
export function orgWhere(identifier: string, opts?: { includeDeleted?: boolean }) {
  const match = identifier.startsWith("org_")
    ? eq(organizations.id, identifier)
    : eq(organizations.slug, identifier);
  return opts?.includeDeleted ? match : and(match, isNull(organizations.deletedAt));
}

/** Resolve a product by ID (`prod_` prefix). Id-only — see `sourceById`. */
export function productById(id: string, opts?: { includeDeleted?: boolean }) {
  const match = eq(products.id, id);
  return opts?.includeDeleted ? match : and(match, isNull(products.deletedAt));
}

/** True if the string looks like a `src_…` source ID. */
export function isSourceId(s: string): boolean {
  return s.startsWith("src_");
}

/** True if the string looks like a `prod_…` product ID. */
export function isProductId(s: string): boolean {
  return s.startsWith("prod_");
}

/**
 * Legacy "either id or slug" matcher for internal callers that admin
 * tooling and worker triggers still depend on. Prefer `sourceById` plus
 * `findSourceForOrgSlug` in new code — the slug branch is unambiguous
 * today (no cross-org collisions on prod) but degrades to "first row
 * wins by rowid" if collisions ever appear. Passing through here is a
 * deliberate carve-out documented at each call site.
 */
export function sourceMatchByIdOrSlug(idOrSlug: string, opts?: { includeDeleted?: boolean }) {
  const match = isSourceId(idOrSlug) ? eq(sources.id, idOrSlug) : eq(sources.slug, idOrSlug);
  return opts?.includeDeleted ? match : and(match, isNull(sources.deletedAt));
}

/** Sibling of `sourceMatchByIdOrSlug` for products. */
export function productMatchByIdOrSlug(idOrSlug: string, opts?: { includeDeleted?: boolean }) {
  const match = isProductId(idOrSlug) ? eq(products.id, idOrSlug) : eq(products.slug, idOrSlug);
  return opts?.includeDeleted ? match : and(match, isNull(products.deletedAt));
}

/**
 * Resolve a source within an org (#690). The org segment accepts an ID
 * (`org_…`) or a slug (orgs stay globally addressable). The source segment
 * accepts an ID (`src_…`) or a slug; per-org slug uniqueness from #690
 * Phase C is what makes the slug branch unambiguous here.
 */
export async function findSourceForOrgSlug(
  db: ReturnType<typeof createDb>,
  orgIdOrSlug: string,
  sourceIdOrSlug: string,
  opts?: { includeDeleted?: boolean },
) {
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
  db: ReturnType<typeof createDb>,
  orgIdOrSlug: string,
  productIdOrSlug: string,
  opts?: { includeDeleted?: boolean },
) {
  const rows = await db
    .select({ product: products })
    .from(products)
    .innerJoin(organizations, eq(products.orgId, organizations.id))
    .where(and(orgWhere(orgIdOrSlug, opts), productMatchByIdOrSlug(productIdOrSlug, opts)))
    .limit(1);
  return rows[0]?.product ?? null;
}

/**
 * Thrown by `resolveSourceFromContext` / `resolveProductFromContext` when a
 * bare-path route matches a slug instead of a typed `src_…`/`prod_…` ID.
 * The global Hono `onError` in `index.ts` translates this to a 400 with a
 * pointer at the org-scoped path and the `/v1/lookups/*-by-slug` resolver.
 *
 * Why throw instead of returning null: handlers already translate `null` to
 * 404 ("not found"); slug-on-bare-path is a different failure mode (the
 * client used a deprecated input shape) that deserves a distinct status and
 * message. Throwing keeps every route handler on the existing two-line
 * resolver pattern without bolting on a third return state.
 */
export class BareSlugRejected extends Error {
  constructor(
    public readonly entity: "source" | "product",
    public readonly slug: string,
  ) {
    super(
      `Bare slug "${slug}" cannot be used on the legacy /${entity}s/:slug path — slugs are org-scoped (#690). ` +
        `Use /v1/orgs/{orgSlug}/${entity}s/{${entity}Slug} or pass a typed ID (${entity === "source" ? "src_" : "prod_"}…). ` +
        `If you only have a bare slug, resolve it first via GET /v1/lookups/${entity}-by-slug?slug={slug}.`,
    );
    this.name = "BareSlugRejected";
  }
}

/**
 * Pick the right source resolver based on which params Hono matched.
 * Org-scoped paths route through `findSourceForOrgSlug` (id-or-slug in
 * either segment); bare paths now require a typed `src_…` ID and reject
 * raw slugs with `BareSlugRejected` (#698). Per-org slug uniqueness from
 * #690 made bare slugs ambiguous — typed IDs are still globally unique
 * and stay safe on the legacy path so admin tooling can adopt at its own
 * pace.
 */
export async function resolveSourceFromContext(
  c: { req: { param: (name: string) => string | undefined } },
  db: ReturnType<typeof createDb>,
  opts?: { includeDeleted?: boolean },
) {
  const orgSeg = c.req.param("orgSlug");
  const sourceSeg = c.req.param("sourceSlug");
  if (orgSeg && sourceSeg) {
    return findSourceForOrgSlug(db, orgSeg, sourceSeg, opts);
  }
  const bare = c.req.param("slug") ?? c.req.param("identifier");
  if (!bare) return null;
  if (!isSourceId(bare)) {
    throw new BareSlugRejected("source", bare);
  }
  const [row] = await db.select().from(sources).where(sourceMatchByIdOrSlug(bare, opts)).limit(1);
  return row ?? null;
}

/** Sibling of `resolveSourceFromContext` for products. Same flip applies. */
export async function resolveProductFromContext(
  c: { req: { param: (name: string) => string | undefined } },
  db: ReturnType<typeof createDb>,
  opts?: { includeDeleted?: boolean },
) {
  const orgSeg = c.req.param("orgSlug");
  const productSeg = c.req.param("productSlug");
  if (orgSeg && productSeg) {
    return findProductForOrgSlug(db, orgSeg, productSeg, opts);
  }
  const bare = c.req.param("identifier") ?? c.req.param("slug");
  if (!bare) return null;
  if (!isProductId(bare)) {
    throw new BareSlugRejected("product", bare);
  }
  const [row] = await db.select().from(products).where(productMatchByIdOrSlug(bare, opts)).limit(1);
  return row ?? null;
}

/**
 * D1 wraps SQLite errors as "Failed query: ..." without preserving the
 * original constraint violation message. We detect conflicts by checking
 * if the insert query failed — for endpoints that use UNIQUE columns,
 * a failed insert is almost certainly a constraint violation.
 */
export function isConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("constraint")) return true;
  if (msg.includes("Failed query") && msg.includes("insert into")) return true;
  return false;
}

type AliasTarget =
  | { orgId: string; productId?: undefined }
  | { productId: string; orgId?: undefined };

/**
 * Replace the owner's alias set with `aliases`. Returns the first domain that
 * collides with a different owner, or null on success — domain_aliases is
 * globally unique.
 */
export async function replaceAliases(
  db: ReturnType<typeof createDb>,
  opts: AliasTarget & { aliases: string[] },
): Promise<{ conflict: string | null }> {
  const isOrg = "orgId" in opts && !!opts.orgId;
  const ownerCol = isOrg ? domainAliases.orgId : domainAliases.productId;
  const ownerId = isOrg ? opts.orgId! : opts.productId!;

  const deduped = Array.from(new Set(opts.aliases.map((d) => d.trim()).filter(Boolean)));

  const existing = await db
    .select({ domain: domainAliases.domain })
    .from(domainAliases)
    .where(eq(ownerCol, ownerId));
  const existingSet = new Set(existing.map((r) => r.domain));
  const nextSet = new Set(deduped);

  const toDelete = [...existingSet].filter((d) => !nextSet.has(d));
  const toInsert = deduped.filter((d) => !existingSet.has(d));

  if (toInsert.length > 0) {
    const conflicts = await db
      .select({ domain: domainAliases.domain })
      .from(domainAliases)
      .where(inArray(domainAliases.domain, toInsert));
    const foreign = conflicts.find((c) => !existingSet.has(c.domain));
    if (foreign) return { conflict: foreign.domain };
  }

  if (toDelete.length > 0) {
    await db
      .delete(domainAliases)
      .where(and(eq(ownerCol, ownerId), inArray(domainAliases.domain, toDelete)));
  }

  if (toInsert.length > 0) {
    const now = new Date().toISOString();
    await db.insert(domainAliases).values(
      toInsert.map((domain) => ({
        domain,
        orgId: isOrg ? opts.orgId! : null,
        productId: isOrg ? null : opts.productId!,
        createdAt: now,
      })),
    );
  }

  return { conflict: null };
}

export function getStatusHub(env: { STATUS_HUB: DurableObjectNamespace }) {
  return env.STATUS_HUB.get(env.STATUS_HUB.idFromName("global"));
}

export function getReleaseHub(env: { RELEASE_HUB: DurableObjectNamespace }) {
  return env.RELEASE_HUB.get(env.RELEASE_HUB.idFromName("global"));
}

/** Get-or-create a tag by name. Shared across org and product routes. */
export async function getOrCreateTagD1(
  db: ReturnType<typeof import("./db.js").createDb>,
  name: string,
) {
  const slug = toSlug(name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (existing) return existing;
  const [created] = await db
    .insert(tags)
    .values({ name, slug, createdAt: new Date().toISOString() })
    .returning();
  return created;
}

/**
 * Get-or-create a batch of tags by name in a constant number of roundtrips.
 * Returns resolved tag rows for the given names (deduped by slug).
 */
export async function getOrCreateTagsD1(
  db: ReturnType<typeof import("./db.js").createDb>,
  names: string[],
): Promise<{ id: string; name: string; slug: string }[]> {
  if (names.length === 0) return [];
  const bySlug = new Map<string, string>();
  for (const name of names) {
    const slug = toSlug(name);
    if (!bySlug.has(slug)) bySlug.set(slug, name);
  }
  const now = new Date().toISOString();
  const rows = Array.from(bySlug.entries()).map(([slug, name]) => ({ name, slug, createdAt: now }));
  await db.insert(tags).values(rows).onConflictDoNothing();
  return db
    .select({ id: tags.id, name: tags.name, slug: tags.slug })
    .from(tags)
    .where(inArray(tags.slug, Array.from(bySlug.keys())));
}

const ROLLING_WINDOW_DAYS = 90;

/** Avg releases/week over a rolling 90-day window, or the actual span if shorter. */
export function computeAvgPerWeek(
  releasesInWindow: number,
  oldestPublishedAt: string | null,
): number {
  if (releasesInWindow === 0 || !oldestPublishedAt) return 0;
  const ageMs = Date.now() - new Date(oldestPublishedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const effectiveDays = Math.min(ROLLING_WINDOW_DAYS, ageDays);
  const weeks = effectiveDays / 7;
  if (weeks < 1) return releasesInWindow;
  return Math.round((releasesInWindow / weeks) * 10) / 10;
}

/** Generate a knowledge page ID. Shared by route handlers and playbook-regen. */
export function newKnowledgePageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  return "kp_" + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Compute the 52-week date range used for heatmap endpoints. */
/** Parse a `?flag=true` query param. Any other value (including "1", missing) is false. */
export function parseBoolParam(raw: string | undefined): boolean {
  return raw === "true";
}

/** Narrow an untrusted query string to one of a known-good set, falling back on mismatch. */
export function parseEnumParam<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
}

export function parseSortDir(
  raw: string | undefined,
  fallback: "asc" | "desc" = "desc",
): "asc" | "desc" {
  if (raw === "asc" || raw === "desc") return raw;
  return fallback;
}

/** Clamp a `?limit=` query param to [1, max], falling back to `defaultVal`. */
export function parseLimitParam(raw: string | undefined, defaultVal: number, max: number): number {
  const n = parseInt(raw ?? String(defaultVal), 10);
  if (isNaN(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

/** Human-readable hint for the accepted `since`/`until` formats — reused in 400 messages and OpenAPI docs. */
export const TIME_WINDOW_HINT =
  "must be an ISO date/datetime or relative shorthand (e.g. `90d`, `4w`, `6m`, `2y`)";

export type TimeWindowResult =
  | { ok: true; since?: string; until?: string }
  | { ok: false; invalid: "since" | "until" };

/**
 * Resolve optional `since`/`until` query params to canonical ISO bounds on
 * `published_at`. Each accepts an ISO date/datetime or a relative shorthand
 * (`90d`/`4w`/`6m`/`2y`); empty/missing values are passed through as
 * undefined. Returns `{ ok: false, invalid }` naming the first unparseable
 * bound so the caller can emit a 400. Filtering on a NULL `published_at` is
 * handled at the query layer (the `>=`/`<=` comparisons drop undated rows).
 */
export function parseTimeWindow(
  sinceRaw: string | undefined,
  untilRaw: string | undefined,
): TimeWindowResult {
  let since: string | undefined;
  let until: string | undefined;
  if (sinceRaw !== undefined && sinceRaw !== "") {
    const resolved = resolveDateParam(sinceRaw);
    if (resolved === null) return { ok: false, invalid: "since" };
    since = resolved;
  }
  if (untilRaw !== undefined && untilRaw !== "") {
    const resolved = resolveDateParam(untilRaw);
    if (resolved === null) return { ok: false, invalid: "until" };
    until = resolved;
  }
  return { ok: true, since, until };
}

// Re-exported so existing api callers (collections.ts, sources.ts, …) keep
// importing from `../utils.js`. The encoder lives in `@releases/core-internal/
// collection-feed` so MCP and REST emit byte-identical cursor strings.
export { buildFeedCursor } from "@releases/core-internal/collection-feed";

/**
 * Parse a release-feed cursor and return the SQL `WHERE` fragment plus its
 * bind values, scoped to alias `r` on the releases table. Used by
 * `getOrgReleasesFeed` / `getSourceReleasesFeed` (raw D1) and mirrored by
 * `feedCursorSql` (Drizzle) for `getCollectionReleasesFeed`.
 *
 * Wire format: `publishedAt|fetchedAt|id` — always 3 parts, with
 * `publishedAt` empty when null. Encodes the full sort key so
 * same-`publishedAt` ties tie-break on `fetched_at` then `id`, matching the
 * ORDER BY. Legacy 2-part `publishedAt|id` cursors from in-flight paginators
 * still parse (degrade to the prior tie-break-on-id shape).
 *
 * The ORDER BY puts non-null `published_at` rows before nulls, so:
 * - Dated cursor: also matches `r.published_at IS NULL` (otherwise
 *   pagination silently drops every undated release once it crosses the
 *   dated boundary).
 * - Null-tail cursor: scoped to `r.published_at IS NULL` (non-null rows
 *   already came before this cursor in the ORDER BY).
 */
export function parseFeedCursor(cursorParam: string | null): {
  cursorWhere: string;
  cursorBindings: string[];
} {
  if (!cursorParam) return { cursorWhere: "", cursorBindings: [] };
  const parts = cursorParam.split("|");

  if (parts.length === 3) {
    const [pub, fet, id] = parts;
    if (pub && fet && id) {
      return {
        cursorWhere:
          "AND (r.published_at IS NULL OR " +
          "(r.published_at < ?) OR " +
          "(r.published_at = ? AND r.fetched_at < ?) OR " +
          "(r.published_at = ? AND r.fetched_at = ? AND r.id < ?))",
        cursorBindings: [pub, pub, fet, pub, fet, id],
      };
    }
    if (!pub && fet && id) {
      return {
        cursorWhere:
          "AND (r.published_at IS NULL AND " +
          "((r.fetched_at < ?) OR (r.fetched_at = ? AND r.id < ?)))",
        cursorBindings: [fet, fet, id],
      };
    }
  }

  if (parts.length === 2) {
    const [pub, id] = parts;
    if (pub && id) {
      return {
        cursorWhere:
          "AND (r.published_at IS NULL OR " +
          "(r.published_at < ?) OR (r.published_at = ? AND r.id < ?))",
        cursorBindings: [pub, pub, id],
      };
    }
    // Legacy `|id` shape — no fetched_at to tie-break on; only reachable
    // from in-flight pre-#806 cursors.
    if (!pub && id) {
      return {
        cursorWhere: "AND (r.published_at IS NULL AND r.id < ?)",
        cursorBindings: [id],
      };
    }
  }

  if (parts.length === 1 && parts[0]) {
    return {
      cursorWhere: "AND (r.published_at IS NULL OR r.published_at < ?)",
      cursorBindings: [parts[0]],
    };
  }

  return { cursorWhere: "", cursorBindings: [] };
}

export function heatmapDateRange(): { from: string; to: string; toExclusive: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const toExclusiveDate = new Date(today);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toExclusive = toExclusiveDate.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - 52 * 7);
  const from = fromDate.toISOString().slice(0, 10);
  return { from, to, toExclusive };
}

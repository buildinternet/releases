import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, and, inArray, isNull, count, sql, asc } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  collections,
  collectionMembers,
  organizations,
  organizationsPublic,
} from "@buildinternet/releases-core/schema";
import { embedAndUpsertEntities } from "@releases/search/embed-entities.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
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
} from "../utils.js";
import { getCollectionReleasesFeed } from "../queries/orgs.js";
import { parseSourceTypesLenient } from "../lib/source-types.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { collectionReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import type { Env } from "../index.js";
import {
  CollectionListResponseSchema,
  CollectionDetailSchema,
  CollectionReleasesResponseSchema,
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
  CollectionReleaseItem,
  CollectionRow,
  CollectionMemberInput,
} from "@buildinternet/releases-api-types";
import { validateJson } from "../lib/validate.js";

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

async function resolveOrgIdForMember(
  db: ReturnType<typeof createDb>,
  m: CollectionMemberInput,
): Promise<{ ok: true; orgId: string } | { ok: false; status: 400 | 404; message: string }> {
  const ref = m.orgId ?? m.orgSlug;
  if (!ref) {
    return { ok: false, status: 400, message: "Each member requires orgId or orgSlug" };
  }
  const [row] = await db.select({ id: organizations.id }).from(organizations).where(orgWhere(ref));
  if (!row) return { ok: false, status: 404, message: `Org not found: ${ref}` };
  return { ok: true, orgId: row.id };
}

// Batched variant for PUT: resolves every member in at most two IN-queries
// (one for `org_…` ids, one for slugs) instead of N round-trips. Membership
// lists are bounded — D1's 100-bind cap leaves plenty of headroom for any
// realistic collection.
async function resolveOrgIdsBatch(
  db: ReturnType<typeof createDb>,
  members: CollectionMemberInput[],
): Promise<
  | { ok: true; resolved: { orgId: string; position: number }[] }
  | { ok: false; status: 400 | 404; message: string }
> {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const m of members) {
    const ref = m.orgId ?? m.orgSlug;
    if (!ref) return { ok: false, status: 400, message: "Each member requires orgId or orgSlug" };
    if (m.orgId) ids.add(m.orgId);
    else slugs.add(m.orgSlug!);
  }

  const map = new Map<string, string>();
  if (ids.size > 0) {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(inArray(organizations.id, [...ids]), isNull(organizations.deletedAt)));
    for (const r of rows) map.set(r.id, r.id);
  }
  if (slugs.size > 0) {
    const rows = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(and(inArray(organizations.slug, [...slugs]), isNull(organizations.deletedAt)));
    for (const r of rows) map.set(r.slug, r.id);
  }

  const resolved: { orgId: string; position: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const ref = (m.orgId ?? m.orgSlug)!;
    const orgId = map.get(ref);
    if (!orgId) return { ok: false, status: 404, message: `Org not found: ${ref}` };
    if (seen.has(orgId)) {
      return { ok: false, status: 400, message: `Duplicate org in members list: ${orgId}` };
    }
    seen.add(orgId);
    resolved.push({ orgId, position: m.position ?? i });
  }
  return { ok: true, resolved };
}

collectionRoutes.get(
  "/collections",
  describeRoute({
    tags: ["Collections"],
    summary: "List curated collections",
    description:
      "Returns every collection with a member count and a small `previewMembers` array (capped at 3) so the list page can render inline avatars without a second round trip. Member counts and preview avatars are joined through `organizations_public`, so soft-deleted and `on_demand` orgs never inflate the totals or leak onto the preview chips.",
    responses: {
      200: {
        description: "All collections, ordered by name.",
        content: { "application/json": { schema: resolver(CollectionListResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);

    // Pick a single deterministic github handle per org via correlated subquery
    // so a multi-handle org doesn't fan out the JOIN. `org_accounts` only
    // enforces UNIQUE(platform, handle) globally — not per (org, platform).
    const githubHandleSql = sql<string | null>`(
    SELECT handle FROM org_accounts
    WHERE org_id = ${organizationsPublic.id} AND platform = 'github'
    ORDER BY created_at, id LIMIT 1
  )`;

    const [countRows, memberRows] = await Promise.all([
      // memberCount counts publicly visible members only — joining through
      // organizations_public hides on_demand / soft-deleted orgs from the
      // tally, matching what GET /v1/collections/:slug returns.
      db
        .select({
          slug: collections.slug,
          name: collections.name,
          description: collections.description,
          memberCount: count(organizationsPublic.id),
        })
        .from(collections)
        .leftJoin(collectionMembers, eq(collectionMembers.collectionId, collections.id))
        .leftJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
        .groupBy(collections.id)
        .orderBy(collections.name),

      // Members joined with org + github handle. Collections are small (<10 orgs
      // typical), so grouping client-side is cheaper than a window-function query.
      db
        .select({
          collectionSlug: collections.slug,
          position: collectionMembers.position,
          slug: organizationsPublic.slug,
          name: organizationsPublic.name,
          domain: organizationsPublic.domain,
          avatarUrl: organizationsPublic.avatarUrl,
          description: organizationsPublic.description,
          githubHandle: githubHandleSql,
        })
        .from(collectionMembers)
        .innerJoin(collections, eq(collections.id, collectionMembers.collectionId))
        .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
        .orderBy(collectionMembers.position, organizationsPublic.name),
    ]);

    const previewBySlug = new Map<string, CollectionListItem["previewMembers"]>();
    const PREVIEW_LIMIT = 3;
    for (const m of memberRows) {
      const arr = previewBySlug.get(m.collectionSlug) ?? [];
      if (arr.length < PREVIEW_LIMIT) {
        arr.push({
          slug: m.slug,
          name: m.name,
          domain: m.domain,
          avatarUrl: m.avatarUrl,
          githubHandle: m.githubHandle,
          description: m.description,
        });
        previewBySlug.set(m.collectionSlug, arr);
      }
    }

    const body: CollectionListItem[] = countRows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      memberCount: Number(r.memberCount),
      previewMembers: previewBySlug.get(r.slug) ?? [],
    }));
    return c.json(body);
  },
);

collectionRoutes.get(
  "/collections/:slug",
  describeRoute({
    tags: ["Collections"],
    summary: "Get a collection's detail page payload",
    description:
      "Returns the collection's name/description plus its ordered member orgs. Members are joined through `organizations_public`, so soft-deleted / `on_demand` orgs never leak via a collection (curators cannot use a collection to surface a hidden org). The GitHub handle on each member is picked deterministically from `org_accounts` so multi-handle orgs don't fan out the row.",
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
        description: "Collection detail with ordered member orgs.",
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
      return c.json({ error: "not_found", message: "Collection not found" }, 404);
    }

    // Join to organizations_public so soft-deleted / on_demand orgs never leak
    // through a collection (curators shouldn't be able to surface a hidden org
    // by adding it to one). The github handle is pulled via correlated subquery
    // — a LEFT JOIN on org_accounts would fan out members for orgs with multiple
    // github rows, since the table only enforces UNIQUE(platform, handle).
    const orgs = await db
      .select({
        slug: organizationsPublic.slug,
        name: organizationsPublic.name,
        domain: organizationsPublic.domain,
        avatarUrl: organizationsPublic.avatarUrl,
        description: organizationsPublic.description,
        githubHandle: sql<string | null>`(
        SELECT handle FROM org_accounts
        WHERE org_id = ${organizationsPublic.id} AND platform = 'github'
        ORDER BY created_at, id LIMIT 1
      )`,
      })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collection.id))
      .orderBy(collectionMembers.position, organizationsPublic.name);

    const body: CollectionDetail = {
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
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
      "Cursor-paginated cross-org feed for the collection. Cursor shape and ordering match `/v1/orgs/:slug/releases`, so the same web parser works on both surfaces. Member orgs are resolved through `organizations_public`, so soft-deleted / `on_demand` orgs never contribute releases. Empty membership returns `releases: []` rather than an error.\n\nSupports `Accept: text/markdown` for an LLM-friendly rendering.",
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
          "Comma-separated org slugs to narrow the feed to a subset of the collection's members. Unknown slugs are silently dropped; passing an `orgs=` value that resolves to an empty set returns `releases: []`. Omit to include all member orgs.",
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
    const orgsParam = c.req.query("orgs");
    // Parse `?orgs=` into a slug set; we don't error on unknowns because the
    // intersect-with-members step below naturally drops anything that isn't
    // a current collection member.
    const requestedOrgSlugs =
      orgsParam === undefined
        ? null
        : new Set(
            orgsParam
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter((s) => s.length > 0),
          );

    const db = createDb(c.env.DB);

    const [collection] = await db
      .select({ id: collections.id, name: collections.name })
      .from(collections)
      .where(eq(collections.slug, slug));
    if (!collection) {
      return c.json({ error: "not_found", message: "Collection not found" }, 404);
    }

    // Resolve members through organizations_public so the feed and the detail
    // page agree on visible membership.
    const memberRows = await db
      .select({ orgId: organizationsPublic.id, slug: organizationsPublic.slug })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collection.id));

    // Narrow to the requested org subset *before* hitting the feed helper so
    // an empty intersection short-circuits to `releases: []` instead of
    // running an unscoped query. `requestedOrgSlugs === null` means no
    // `?orgs=` was passed — use the full member set.
    const orgIds = (
      requestedOrgSlugs === null
        ? memberRows
        : memberRows.filter((m) => requestedOrgSlugs.has(m.slug))
    ).map((m) => m.orgId);

    // `getCollectionReleasesFeed` short-circuits on an empty orgIds list, so an
    // empty-membership collection flows through the same response path as a
    // populated one and honors `Accept: text/markdown` via wantsMarkdown below.
    const results = await getCollectionReleasesFeed(db, orgIds, cursorParam, limit + 1, {
      includePrereleases,
      sourceTypes,
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
      return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);
    }
    if (name.length > 200) {
      return c.json({ error: "bad_request", message: "Name must be 200 characters or fewer" }, 400);
    }

    const slug = (body.slug ?? toSlug(name)).trim();
    if (!SLUG_RE.test(slug)) {
      return c.json({ error: "bad_request", message: `Invalid slug "${slug}". ${SLUG_HINT}` }, 400);
    }

    if (body.description != null && body.description.length > 2000) {
      return c.json(
        { error: "bad_request", message: "Description must be 2000 characters or fewer" },
        400,
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
        return c.json(
          { error: "conflict", message: `Collection with slug "${slug}" already exists`, slug },
          409,
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
    if (!existing) return c.json({ error: "not_found", message: "Collection not found" }, 404);

    const updates: Partial<typeof collections.$inferInsert> = {};
    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      if (trimmed.length === 0 || trimmed.length > 200) {
        return c.json({ error: "bad_request", message: "Name must be 1–200 characters" }, 400);
      }
      updates.name = trimmed;
    }
    if (body.description !== undefined) {
      if (body.description != null && body.description.length > 2000) {
        return c.json(
          { error: "bad_request", message: "Description must be 2000 characters or fewer" },
          400,
        );
      }
      updates.description = body.description;
    }
    if (body.slug !== undefined && body.slug !== existing.slug) {
      const next = body.slug.trim();
      if (!SLUG_RE.test(next)) {
        return c.json(
          { error: "bad_request", message: `Invalid slug "${next}". ${SLUG_HINT}` },
          400,
        );
      }
      updates.slug = next;
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
        return c.json(
          {
            error: "conflict",
            message: `Collection with slug "${updates.slug}" already exists`,
            slug: updates.slug,
          },
          409,
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
      "Hard delete. `ON DELETE CASCADE` on `collection_members.collection_id` removes the membership rows automatically; the orgs themselves are untouched.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
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
    if (!existing) return c.json({ error: "not_found", message: "Collection not found" }, 404);

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
      "Each entry in `orgs` is a `CollectionMemberInput`: `{ orgId?, orgSlug?, position? }`. Either `orgId` (`org_…`) or `orgSlug` is required per entry; when both are given, `orgId` wins. Position defaults to the array index, so callers can express ordering implicitly by ordering the array.\n\nAll members are resolved in at most two `IN`-queries (one for `org_…` ids, one for slugs) before the write. The replace is delete + insert without a D1 transaction; that's acceptable because membership writes are admin-only and low-frequency. Duplicate orgs in the input are rejected before the delete fires.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
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
        description: "Resolved member list (orgIds + positions) after the replace.",
        content: {
          "application/json": { schema: resolver(ReplaceCollectionMembersResponseSchema) },
        },
      },
      400: {
        description:
          "Missing `orgs` array, member entry without `orgId`/`orgSlug`, or duplicate org in the list.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Collection not found, or one of the members didn't resolve to an org.",
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
    if (!existing) return c.json({ error: "not_found", message: "Collection not found" }, 404);

    const r = await resolveOrgIdsBatch(db, body.orgs);
    if (!r.ok) {
      return c.json(
        { error: r.status === 404 ? "not_found" : "bad_request", message: r.message },
        r.status,
      );
    }
    const { resolved } = r;

    // No D1 transaction primitive — delete + insert is acceptable here because
    // membership writes are admin-only and low-frequency.
    const now = new Date().toISOString();
    await db.delete(collectionMembers).where(eq(collectionMembers.collectionId, existing.id));
    if (resolved.length > 0) {
      await db.insert(collectionMembers).values(
        resolved.map((m) => ({
          collectionId: existing.id,
          orgId: m.orgId,
          position: m.position,
          createdAt: now,
        })),
      );
    }
    await db.update(collections).set({ updatedAt: now }).where(eq(collections.id, existing.id));

    // Membership feeds the embedded "Members:" line — re-embed after replace.
    c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, existing.id));

    return c.json({ collectionSlug: slug, members: resolved });
  },
);

collectionRoutes.post(
  "/collections/:slug/members",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Add a single org to a collection",
    description:
      "`AddCollectionMemberRequest` is one `CollectionMemberInput`: `{ orgId?, orgSlug?, position? }`. Either `orgId` (`org_…`) or `orgSlug` must be present; `orgId` wins when both are given. Position defaults to 0.\n\nIdempotent at the SQL level via `UNIQUE(collection_id, org_id)` — re-adding an existing member returns `409 conflict`. Use `PUT /collections/:slug/members` for the atomic replace path.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
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
        description: "Member entry missing `orgId` and `orgSlug`.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Collection not found, or the referenced org doesn't exist.",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Org is already a member of the collection.",
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
    if (!existing) return c.json({ error: "not_found", message: "Collection not found" }, 404);

    const r = await resolveOrgIdForMember(db, body);
    if (!r.ok) {
      return c.json(
        { error: r.status === 404 ? "not_found" : "bad_request", message: r.message },
        r.status,
      );
    }

    const position = body.position ?? 0;
    const now = new Date().toISOString();
    try {
      await db.insert(collectionMembers).values({
        collectionId: existing.id,
        orgId: r.orgId,
        position,
        createdAt: now,
      });
      await db.update(collections).set({ updatedAt: now }).where(eq(collections.id, existing.id));
      c.executionCtx.waitUntil(embedCollectionSideEffect(c.env, db, existing.id));
      return c.json({ collectionSlug: slug, orgId: r.orgId, position }, 201);
    } catch (err) {
      if (isConflictError(err)) {
        return c.json(
          {
            error: "conflict",
            message: `Org ${r.orgId} is already a member of collection "${slug}"`,
          },
          409,
        );
      }
      throw err;
    }
  },
);

// `:org` accepts an org id (`org_…`) or slug, mirroring orgWhere().
collectionRoutes.delete(
  "/collections/:slug/members/:org",
  describeRoute({
    hide: hideInProduction,
    tags: ["Collections"],
    summary: "Remove one org from a collection",
    description:
      "`:org` accepts either an `org_…` id or a bare slug, mirroring `orgWhere()`. Returns 404 if the org doesn't exist or isn't a member of the collection — the two cases share a status but carry distinct error messages.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch.",
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
  async (c) => {
    const slug = c.req.param("slug");
    const orgRef = c.req.param("org");
    const db = createDb(c.env.DB);

    const existing = await findCollectionBySlug(db, slug);
    if (!existing) return c.json({ error: "not_found", message: "Collection not found" }, 404);

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(orgRef));
    if (!org) return c.json({ error: "not_found", message: `Org not found: ${orgRef}` }, 404);

    const result = await db
      .delete(collectionMembers)
      .where(
        and(eq(collectionMembers.collectionId, existing.id), eq(collectionMembers.orgId, org.id)),
      )
      .returning({ orgId: collectionMembers.orgId });
    if (result.length === 0) {
      return c.json(
        { error: "not_found", message: `Org ${org.id} is not a member of collection "${slug}"` },
        404,
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
// payload includes member-org names so a topical query ("database stuff")
// can find a collection whose member orgs cover the topic even when the
// collection's own name/description doesn't mention it. Called via
// `c.executionCtx.waitUntil` on every write that could change the
// embedded text: create, update (name/description rename), member
// add/replace/remove. Hard-delete leaves the vector orphaned; the next
// hydration query won't resolve it and it'll fall out of results
// naturally — same posture as the cluster cleanup path in #951.

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

    // Matches the cap inside `buildEntityText` so we don't fetch rows the
    // embedder will throw away.
    const memberRows = await db
      .select({ name: organizationsPublic.name })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, col.id))
      .orderBy(asc(collectionMembers.position), asc(organizationsPublic.name))
      .limit(32);
    const memberOrgNames = memberRows.map((r) => r.name);

    await embedAndUpsertEntities({
      entities: [
        {
          id: col.id,
          kind: "collection",
          name: col.name,
          description: col.description,
          memberOrgNames,
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

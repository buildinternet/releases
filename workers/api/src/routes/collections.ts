import { Hono } from "hono";
import { eq, and, inArray, isNull, count } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  collections,
  collectionMembers,
  organizations,
  organizationsPublic,
} from "@buildinternet/releases-core/schema";
import { newCollectionId } from "@buildinternet/releases-core/id";
import { toSlug } from "@buildinternet/releases-core/slug";
import {
  parseLimitParam,
  parseBoolParam,
  parseReleaseMedia,
  isConflictError,
  orgWhere,
  hydrateMediaUrls,
} from "../utils.js";
import { getCollectionReleasesFeed } from "../queries/orgs.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { collectionReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import type { Env } from "../index.js";
import type {
  CollectionDetail,
  CollectionListItem,
  CollectionReleaseItem,
  CollectionRow,
  CreateCollectionRequest,
  UpdateCollectionRequest,
  AddCollectionMemberRequest,
  ReplaceCollectionMembersRequest,
  CollectionMemberInput,
} from "@buildinternet/releases-api-types";

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

collectionRoutes.get("/collections", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      slug: collections.slug,
      name: collections.name,
      description: collections.description,
      memberCount: count(collectionMembers.orgId),
    })
    .from(collections)
    .leftJoin(collectionMembers, eq(collectionMembers.collectionId, collections.id))
    .groupBy(collections.id)
    .orderBy(collections.name);

  const body: CollectionListItem[] = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    memberCount: Number(r.memberCount),
  }));
  return c.json(body);
});

collectionRoutes.get("/collections/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  const [collection] = await db.select().from(collections).where(eq(collections.slug, slug));
  if (!collection) {
    return c.json({ error: "not_found", message: "Collection not found" }, 404);
  }

  // Join to organizations_public so soft-deleted / on_demand orgs never leak
  // through a collection (curators shouldn't be able to surface a hidden org
  // by adding it to one).
  const orgs = await db
    .select({
      slug: organizationsPublic.slug,
      name: organizationsPublic.name,
      domain: organizationsPublic.domain,
      avatarUrl: organizationsPublic.avatarUrl,
      description: organizationsPublic.description,
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
});

// Cursor model and ordering match /v1/orgs/:slug/releases so the same web
// cursor parser works on both surfaces.
collectionRoutes.get("/collections/:slug/releases", async (c) => {
  const slug = c.req.param("slug");
  const cursorParam = c.req.query("cursor") ?? null;
  const limit = parseLimitParam(c.req.query("limit"), 20, 100);
  const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));

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
    .select({ orgId: organizationsPublic.id })
    .from(collectionMembers)
    .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
    .where(eq(collectionMembers.collectionId, collection.id));

  const orgIds = memberRows.map((m) => m.orgId);
  if (orgIds.length === 0) {
    return c.json({ releases: [], pagination: { nextCursor: null, limit } });
  }

  const results = await getCollectionReleasesFeed(db, orgIds, cursorParam, limit + 1, {
    includePrereleases,
  });

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = `${last.published_at ?? ""}|${last.id}`;
  }

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted: CollectionReleaseItem[] = pageRows.map((r) => ({
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary:
      r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.published_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
    prerelease: r.prerelease === 1,
    source: { slug: r.source_slug, name: r.source_name, type: r.source_type },
    org: { slug: r.org_slug, name: r.org_name },
  }));

  const pagination = { nextCursor, limit };

  if (wantsMarkdown(c)) {
    return markdownResponse(
      c,
      collectionReleaseFeedToMarkdown(slug, collection.name, releasesFormatted, pagination),
    );
  }

  return c.json({ releases: releasesFormatted, pagination });
});

// ── Admin writes ──────────────────────────────────────────────────────────
// All non-GET methods on /v1/collections inherit auth from
// `publicReadAuthMiddleware` (SAFE_METHODS check) — same model as products and
// sources. No per-route auth call needed here.

collectionRoutes.post("/collections", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<CreateCollectionRequest>();

  if (!body?.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return c.json({ error: "bad_request", message: "Missing required field: name" }, 400);
  }
  const name = body.name.trim();
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
});

collectionRoutes.patch("/collections/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const body = await c.req.json<UpdateCollectionRequest>();

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
      return c.json({ error: "bad_request", message: `Invalid slug "${next}". ${SLUG_HINT}` }, 400);
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
});

collectionRoutes.delete("/collections/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  const existing = await findCollectionBySlug(db, slug);
  if (!existing) return c.json({ error: "not_found", message: "Collection not found" }, 404);

  // ON DELETE CASCADE on collection_members.collection_id handles membership.
  await db.delete(collections).where(eq(collections.id, existing.id));
  return c.body(null, 204);
});

// Replace full membership atomically. Position defaults to the array index, so
// the caller can express ordering without numbering.
collectionRoutes.put("/collections/:slug/members", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const body = await c.req.json<ReplaceCollectionMembersRequest>();

  if (!body || !Array.isArray(body.orgs)) {
    return c.json({ error: "bad_request", message: "Body requires { orgs: [...] }" }, 400);
  }

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

  return c.json({ collectionSlug: slug, members: resolved });
});

collectionRoutes.post("/collections/:slug/members", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const body = await c.req.json<AddCollectionMemberRequest>();

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
});

// `:org` accepts an org id (`org_…`) or slug, mirroring orgWhere().
collectionRoutes.delete("/collections/:slug/members/:org", async (c) => {
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
  return c.body(null, 204);
});

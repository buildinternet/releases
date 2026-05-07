import { Hono } from "hono";
import { eq, count } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  collections,
  collectionMembers,
  organizationsPublic,
} from "@buildinternet/releases-core/schema";
import { parseLimitParam, parseBoolParam, parseReleaseMedia } from "../utils.js";
import { getCollectionReleasesFeed } from "../queries/orgs.js";
import type { Env } from "../index.js";
import type { CollectionDetail, CollectionListItem } from "@buildinternet/releases-api-types";

export const collectionRoutes = new Hono<Env>();

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
    .select({ id: collections.id })
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
  const releasesFormatted = pageRows.map((r) => ({
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary:
      r.content_summary ?? (r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content),
    publishedAt: r.published_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
    prerelease: r.prerelease === 1,
    source: { slug: r.source_slug, name: r.source_name, type: r.source_type },
    org: { slug: r.org_slug, name: r.org_name },
  }));

  return c.json({ releases: releasesFormatted, pagination: { nextCursor, limit } });
});

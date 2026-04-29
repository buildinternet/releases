import { Hono } from "hono";
import { and, desc, eq, gte, isNull, ne, or } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  knowledgePages,
  organizations,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import {
  OVERVIEW_RELEASE_LIMIT,
  OVERVIEW_WINDOW_DAYS,
  selectReleasesForOverview,
} from "@buildinternet/releases-core/overview";
import { authMiddleware } from "../middleware/auth.js";
import { hydrateMediaUrls, orgWhere, parseReleaseMedia } from "../utils.js";
import type { Env } from "../index.js";

/**
 * GET /v1/orgs/:slug/overview/inputs?window=<days>&limit=<n>
 *
 * Returns the payload an agent needs to (re)generate an org overview:
 * org metadata, active sources, the existing overview content (if any),
 * and the post-selection slice of recent releases. Pure data — no AI.
 * Release content + media URLs are hydrated to absolute CDN URLs so the
 * agent can paste them directly into generated markdown.
 *
 * Admin-only. Selection logic lives in `@buildinternet/releases-core/overview`
 * so worker and (eventually) other consumers share it.
 */
const app = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

// authMiddleware forces admin auth — the parent /orgs/* middleware would
// otherwise allow unauthenticated GETs through.
app.get("/orgs/:slug/overview/inputs", authMiddleware, async (c) => {
  const db = getDb(c);
  const slug = c.req.param("slug");

  const windowDays = parseInt(c.req.query("window") ?? String(OVERVIEW_WINDOW_DAYS), 10);
  const limit = parseInt(c.req.query("limit") ?? String(OVERVIEW_RELEASE_LIMIT), 10);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    return c.json({ error: "window must be a positive integer" }, 400);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return c.json({ error: "limit must be a positive integer" }, 400);
  }

  const [org] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      description: organizations.description,
      discovery: organizations.discovery,
    })
    .from(organizations)
    .where(
      and(
        orgWhere(slug),
        or(isNull(organizations.discovery), ne(organizations.discovery, "on_demand")),
      ),
    );
  if (!org) return c.json({ error: "not_found" }, 404);

  // Active sources only — skip hidden + paused.
  const activeSources = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      type: sources.type,
    })
    .from(sources)
    .where(
      and(
        eq(sources.orgId, org.id),
        eq(sources.isHidden, false),
        ne(sources.fetchPriority, "paused"),
      ),
    );

  const cutoff = daysAgoIso(windowDays);

  const releasesPerSource = await Promise.all(
    activeSources.map(async (s) => {
      const rows = await db
        .select()
        .from(releases)
        .where(
          and(
            eq(releases.sourceId, s.id),
            gte(releases.publishedAt, cutoff),
            eq(releases.suppressed, false),
          ),
        )
        .orderBy(desc(releases.publishedAt));
      return { type: s.type, releases: rows };
    }),
  );

  const { releases: selected, totalAvailable } = selectReleasesForOverview(
    releasesPerSource,
    limit,
  );

  const [existing] = await db
    .select({ content: knowledgePages.content })
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)));

  // Hydrate media so the agent sees absolute URLs it can paste directly into
  // the generated overview. Raw `/_media/{key}` prefixes would render broken
  // in the web because the overview read path doesn't re-hydrate.
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const selectedShaped = selected.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    content: hydrateMediaUrls(r.content, mediaOrigin),
    publishedAt: r.publishedAt,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
  }));

  return c.json({
    org,
    sources: activeSources,
    existingContent: existing?.content ?? null,
    selected: selectedShaped,
    totalAvailable,
    windowDays,
  });
});

export default app;

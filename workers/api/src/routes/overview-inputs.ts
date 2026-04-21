import { Hono } from "hono";
import { and, desc, eq, gte, ne } from "drizzle-orm";
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
import { orgWhere } from "../utils.js";
import type { Env } from "../index.js";

/**
 * GET /v1/overview-inputs?slug=<orgSlug>&window=<days>&limit=<n>
 *
 * Returns the payload an agent needs to (re)generate an org overview:
 * org metadata, active sources, the existing overview content (if any),
 * and the post-selection slice of recent releases. Pure data — no AI.
 *
 * The shape mirrors what the deleted `regenerateOrgOverview` used to assemble
 * server-side. Selection logic lives in `@buildinternet/releases-core/overview`
 * so worker and (eventually) other consumers share it.
 */
const app = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

app.get("/", async (c) => {
  const db = getDb(c);
  const slug = c.req.query("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);

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
    })
    .from(organizations)
    .where(orgWhere(slug));
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

  return c.json({
    org,
    sources: activeSources,
    existingContent: existing?.content ?? null,
    selected,
    totalAvailable,
    windowDays,
  });
});

export default app;

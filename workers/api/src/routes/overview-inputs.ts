import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { and, desc, eq, gte, isNull, ne, or } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  knowledgePages,
  organizationsPublic,
  releases,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import {
  OVERVIEW_RELEASE_LIMIT,
  OVERVIEW_WINDOW_DAYS,
  selectReleasesForOverview,
} from "@buildinternet/releases-core/overview";
import { authMiddleware } from "../middleware/auth.js";
import { hydrateMediaUrls, parseReleaseMedia } from "../utils.js";
import {
  OverviewInputsFullResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
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
app.get(
  "/orgs/:slug/overview/inputs",
  describeRoute({
    tags: ["Overviews"],
    summary: "Get overview inputs",
    description:
      "Returns the data an agent needs to (re)generate an org overview: org metadata, active sources, the existing overview content if any, and the post-selection slice of recent releases hydrated to absolute CDN URLs. Add `?check=true` for a lightweight pre-flight that skips content hydration — useful for orchestrators deciding whether to dispatch without paying for the full payload. `?window=<days>` (default: core constant) controls the lookback window; `?limit=<n>` caps selected releases. Admin-only — requires Bearer auth.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description:
          "Overview inputs payload (full) or pre-flight check payload (when `?check=true`)",
        content: {
          "application/json": {
            schema: resolver(OverviewInputsFullResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid `window` or `limit` query parameter",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Org not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  authMiddleware,
  async (c) => {
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

    const checkOnly = c.req.query("check") === "true";

    const orgIdMatch = slug.startsWith("org_")
      ? eq(organizationsPublic.id, slug)
      : eq(organizationsPublic.slug, slug);

    const [org] = await db
      .select({
        id: organizationsPublic.id,
        slug: organizationsPublic.slug,
        name: organizationsPublic.name,
        description: organizationsPublic.description,
        discovery: organizationsPublic.discovery,
      })
      .from(organizationsPublic)
      .where(orgIdMatch);
    if (!org) return c.json({ error: "not_found" }, 404);

    // Active sources only — skip hidden + paused.
    const activeSources = await db
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
      })
      .from(sourcesActive)
      .where(
        and(
          eq(sourcesActive.orgId, org.id),
          // is_hidden / fetch_priority are nullable — three-valued SQL logic
          // would drop legacy NULL rows from a bare eq/ne, so OR in the IS NULL
          // case so they count as visible / not-paused.
          or(eq(sourcesActive.isHidden, false), isNull(sourcesActive.isHidden)),
          or(ne(sourcesActive.fetchPriority, "paused"), isNull(sourcesActive.fetchPriority)),
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

    if (checkOnly) {
      // Pre-flight payload — orchestrators use this to decide whether to dispatch
      // a per-org sub-agent without paying for the full release-content + media
      // hydration. `wouldRegenerate` is true when there's something worth feeding
      // the model.
      return c.json({
        orgSlug: org.slug,
        selected: selected.length,
        totalAvailable,
        hasExistingContent: !!existing?.content,
        wouldRegenerate: selected.length > 0,
        windowDays,
      });
    }

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
  },
);

export default app;

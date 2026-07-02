import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizationsPublic } from "@buildinternet/releases-core/schema";
import {
  OVERVIEW_RELEASE_LIMIT,
  OVERVIEW_WINDOW_DAYS,
} from "@buildinternet/releases-core/overview";
import { fetchOverviewInputsForOrg } from "@releases/core-internal/overview-eligibility";
import { authMiddleware } from "../middleware/auth.js";
import { hydrateMediaUrls, parseReleaseMedia } from "../utils.js";
import {
  OverviewInputsResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, ValidationError } from "@releases/lib/releases-error";

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
    hide: hideInProduction,
    tags: ["Overviews"],
    summary: "Get overview inputs",
    description:
      "Returns the data an agent needs to (re)generate an org overview: org metadata, active sources, the existing overview content if any, and the post-selection slice of recent releases hydrated to absolute CDN URLs. Add `?check=true` for a lightweight pre-flight that skips content hydration — useful for orchestrators deciding whether to dispatch without paying for the full payload. `?window=<days>` (default: core constant) controls the lookback window; `?limit=<n>` caps selected releases. Admin-only — requires Bearer auth.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description:
          "Overview inputs payload (full) or pre-flight check payload (when `?check=true`). Modelled as a Zod `union([check, full])` so OpenAPI emits a single `200` entry whose schema enumerates both variants.",
        content: {
          "application/json": {
            schema: resolver(OverviewInputsResponseSchema),
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
      return respondError(
        c,
        new ValidationError("window must be a positive integer", { code: "bad_request" }),
      );
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      return respondError(
        c,
        new ValidationError("limit must be a positive integer", { code: "bad_request" }),
      );
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
    if (!org) return respondError(c, new NotFoundError());

    // Assemble sources + recent releases via the shared helper, which pulls
    // every active source's releases in one chunked IN-bound query instead of
    // a SELECT per source. Same selection + projection the batch-overview
    // workflow uses, so the route and the workflow stay aligned.
    const inputs = await fetchOverviewInputsForOrg(db, org.id, { windowDays, limit });
    // `org` was just resolved against the same view by id, so a null here is
    // unreachable — the guard only narrows the helper's `… | null` return.
    if (!inputs) return respondError(c, new NotFoundError());

    if (checkOnly) {
      // Pre-flight payload — orchestrators use this to decide whether to dispatch
      // a per-org sub-agent without paying for the full release-content + media
      // hydration. `wouldRegenerate` is true when there's something worth feeding
      // the model.
      return c.json({
        orgSlug: org.slug,
        selected: inputs.selected.length,
        totalAvailable: inputs.totalAvailable,
        hasExistingContent: !!inputs.existingContent,
        wouldRegenerate: inputs.selected.length > 0,
        windowDays: inputs.windowDays,
      });
    }

    // Hydrate media so the agent sees absolute URLs it can paste directly into
    // the generated overview. Raw `/_media/{key}` prefixes would render broken
    // in the web because the overview read path doesn't re-hydrate.
    const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
    const selectedShaped = inputs.selected.map((r) => ({
      id: r.id,
      version: r.version,
      title: r.title,
      content: hydrateMediaUrls(r.content, mediaOrigin),
      publishedAt: r.publishedAt,
      url: r.url,
      media: parseReleaseMedia(r.media, mediaOrigin),
    }));

    // `org` (not `inputs.org`) carries `discovery`, which the full response
    // schema requires; the helper's org projection omits it.
    return c.json({
      org,
      sources: inputs.sources,
      existingContent: inputs.existingContent,
      selected: selectedShaped,
      totalAvailable: inputs.totalAvailable,
      windowDays: inputs.windowDays,
    });
  },
);

export default app;

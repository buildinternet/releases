/**
 * Admin-only manifest of org overviews — designed for orchestrators planning
 * a maintenance sweep. Returns a paginated list with the freshness signal
 * that actually matters (`releasesSinceOverview`), not just date diff.
 *
 * Gated by `authMiddleware` via the `admin/overviews` entry in
 * workers/api/src/index.ts.
 *
 *   GET /v1/admin/overviews
 *
 * Query params (all optional, all filters combine):
 *   staleDays=<n>    Include `behind` rows whose overview is at least N days old.
 *   missing=true     Include rows where the org has no overview at all.
 *   hasActivity=true Limit to rows with recentReleaseCount > 0.
 *   format=plan      Add per-row `action` and `needsFetch` hints.
 *   page, limit      Standard pagination envelope.
 *
 * If neither `staleDays` nor `missing` is set, all rows are returned (subject
 * to `hasActivity` if present).
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { classifyOverviewStaleness } from "@buildinternet/releases-core/overview";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import type {
  OverviewManifestResponse,
  OverviewManifestRow,
} from "@buildinternet/releases-api-types";
import { createDb } from "../db.js";
import { buildListResponse, parseListPagination, slicePage } from "../lib/pagination.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError } from "@releases/lib/releases-error";

export const adminOverviewsRoutes = new Hono<Env>();

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Threshold beyond which we hint the orchestrator to refetch sources first. */
const NEEDS_FETCH_LAG_DAYS = 7;

interface ManifestQueryRow {
  id: string;
  slug: string;
  name: string;
  org_created_at: string;
  discovery: "curated" | "agent" | "on_demand";
  auto_generate_content: number;
  overview_updated_at: string | null;
  overview_generated_at: string | null;
  last_contributing_release_at: string | null;
  org_last_activity: string | null;
  releases_since_overview: number;
  recent_release_count: number;
  active_source_count: number;
}

adminOverviewsRoutes.get("/admin/overviews", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const pagination = parseListPagination(params, { defaultPageSize: 200, maxPageSize: 500 });

  const staleDaysRaw = params.get("staleDays");
  const staleDays = staleDaysRaw != null ? parseInt(staleDaysRaw, 10) : null;
  if (staleDaysRaw != null && (staleDays == null || !Number.isFinite(staleDays) || staleDays < 0)) {
    return respondError(
      c,
      new ValidationError("staleDays must be a non-negative integer", { code: "bad_request" }),
    );
  }

  const missingFlag = params.get("missing") === "true";
  const hasActivityFlag = params.get("hasActivity") === "true";
  const planMode = params.get("format") === "plan";

  const cutoff30d = daysAgoIso(30);

  // One pass to compute everything we need per-org. Total org count is in the
  // hundreds — small enough to paginate in memory after filtering.
  const db = getDb(c);
  const rows = await db.all<ManifestQueryRow>(sql`
    SELECT
      o.id,
      o.slug,
      o.name,
      o.created_at AS org_created_at,
      o.discovery,
      o.auto_generate_content,
      kp.updated_at AS overview_updated_at,
      kp.generated_at AS overview_generated_at,
      kp.last_contributing_release_at AS last_contributing_release_at,
      MAX(r.published_at) AS org_last_activity,
      COUNT(CASE
        WHEN r.published_at IS NOT NULL
          AND kp.updated_at IS NOT NULL
          AND r.published_at > kp.updated_at
        THEN 1
      END) AS releases_since_overview,
      COUNT(CASE WHEN r.published_at >= ${cutoff30d} THEN 1 END) AS recent_release_count,
      COUNT(DISTINCT s.id) AS active_source_count
    FROM organizations_public o
    LEFT JOIN knowledge_pages kp
      ON kp.org_id = o.id AND kp.scope = 'org'
    LEFT JOIN sources_active s
      ON s.org_id = o.id
    LEFT JOIN releases_visible r
      ON r.source_id = s.id
    GROUP BY o.id, o.slug, o.name, o.created_at, o.discovery, o.auto_generate_content,
             kp.updated_at, kp.generated_at, kp.last_contributing_release_at
    ORDER BY o.name, o.id
  `);

  const now = Date.now();
  const filterByStaleness = staleDays != null || missingFlag;

  const all: OverviewManifestRow[] = [];
  for (const row of rows) {
    const hasOverview = row.overview_updated_at != null;
    const autoGenerateContent = row.auto_generate_content === 1;
    const staleness = classifyOverviewStaleness(hasOverview, row.releases_since_overview);

    if (filterByStaleness) {
      const matchesMissing = missingFlag && staleness === "missing";
      const matchesBehind =
        staleDays != null &&
        staleness === "behind" &&
        row.overview_updated_at != null &&
        (now - new Date(row.overview_updated_at).getTime()) / DAY_MS >= staleDays;
      if (!matchesMissing && !matchesBehind) continue;
    }

    if (hasActivityFlag && row.recent_release_count <= 0) continue;

    const out: OverviewManifestRow = {
      orgSlug: row.slug,
      orgName: row.name,
      orgCreatedAt: row.org_created_at,
      discovery: row.discovery,
      overviewUpdatedAt: row.overview_updated_at,
      overviewGeneratedAt: row.overview_generated_at,
      lastContributingReleaseAt: row.last_contributing_release_at,
      orgLastActivity: row.org_last_activity,
      releasesSinceOverview: row.releases_since_overview,
      recentReleaseCount: row.recent_release_count,
      staleness,
      autoGenerateContent,
    };

    if (planMode) {
      // An opted-out org is invisible to the overview-regen eligibility filter,
      // so `missing`/`refresh` would be misleading here — the sweep would never
      // pick it up (#1795). Flag it explicitly instead.
      if (!autoGenerateContent) out.action = "opted_out";
      else if (staleness === "missing") out.action = "missing";
      else if (staleness === "behind") out.action = "refresh";
      else out.action = "skip";
      // Hint a poll-fetch first when an org has active sources but the most
      // recent release is older than the lag threshold — suggests ingest may
      // have stalled and the overview would be regenerated against stale data.
      const lastActivityMs = row.org_last_activity
        ? new Date(row.org_last_activity).getTime()
        : null;
      const lagged =
        lastActivityMs == null || (now - lastActivityMs) / DAY_MS >= NEEDS_FETCH_LAG_DAYS;
      out.needsFetch = row.active_source_count > 0 && lagged;
    }

    all.push(out);
  }

  const items = slicePage(all, pagination);
  const response: OverviewManifestResponse = buildListResponse(items, pagination, all.length);
  return c.json(response);
});

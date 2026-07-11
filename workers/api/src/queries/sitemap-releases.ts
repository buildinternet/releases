import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import {
  releasesVisible,
  sourcesActive,
  organizationsPublic,
} from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";
import { logEvent } from "@releases/lib/log-event";

/**
 * Editorial gate for `GET /v1/sitemap/releases` (#1181 scoped-down, WS2). A
 * single named constant so the experiment's threshold can move in a one-line
 * change — see the 6-week decision points in the tracking doc.
 */
export const RELEASE_SITEMAP_MIN_IMPORTANCE = 3;

/**
 * Hard cap on rows returned. Chosen to keep the sitemap curated (not a 40K
 * dump) while comfortably covering current monthly volume at the importance
 * gate (~300-350/mo). When the cap trims real matches, `getSitemapReleases`
 * logs it — see the no-silent-caps convention.
 */
export const SITEMAP_RELEASES_CAP = 5000;

export interface SitemapReleaseRow {
  id: string;
  title: string;
  titleShort: string | null;
  titleGenerated: string | null;
  version: string | null;
  publishedAt: string | null;
  fetchedAt: string;
}

/**
 * Releases eligible for the curated release sitemap.
 *
 * Visibility mirrors both `releases_visible` (excludes suppressed +
 * coverage-side rows) AND the noindex inputs `shouldNoIndexRelease` checks
 * on the release-detail page (web/src/lib/release-noindex.ts) — hidden
 * source, hidden org, on-demand-discovery org — so nothing sitemapped would
 * ever render `noindex`. `organizations_public` already excludes
 * `discovery = 'on_demand'` orgs (and soft-deleted ones); `sources_active`
 * does not filter hidden/discovery at all, so both `isHidden` checks are
 * explicit here. Fails closed: any of these joins/filters missing a match
 * excludes the row rather than including it.
 *
 * On top of visibility: a non-empty `summary` and `importance >=
 * RELEASE_SITEMAP_MIN_IMPORTANCE` are required — the editorial quality bar
 * for what we actively ask Google to index (see #2089 release-importance
 * scoring). Ordered `published_at DESC`, capped at `SITEMAP_RELEASES_CAP`.
 */
export async function getSitemapReleases(
  db: AnyDb,
  // Injectable so tests can exercise the cap without seeding 5001 rows.
  cap: number = SITEMAP_RELEASES_CAP,
): Promise<{
  rows: SitemapReleaseRow[];
  totalMatched: number;
  capped: boolean;
}> {
  const whereClause = and(
    sql`${releasesVisible.summary} IS NOT NULL AND length(trim(${releasesVisible.summary})) > 0`,
    gte(releasesVisible.importance, RELEASE_SITEMAP_MIN_IMPORTANCE),
    eq(sourcesActive.isHidden, false),
    // On-demand-discovery sources are lookup-materialized, not curated —
    // exclude them like the org-level on_demand rule (fail closed).
    ne(sourcesActive.discovery, "on_demand"),
    eq(organizationsPublic.isHidden, false),
  );

  const baseQuery = db
    .select({
      id: releasesVisible.id,
      titleShort: releasesVisible.titleShort,
      titleGenerated: releasesVisible.titleGenerated,
      title: releasesVisible.title,
      version: releasesVisible.version,
      fetchedAt: releasesVisible.fetchedAt,
      publishedAt: releasesVisible.publishedAt,
    })
    .from(releasesVisible)
    .innerJoin(sourcesActive, eq(sourcesActive.id, releasesVisible.sourceId))
    .innerJoin(organizationsPublic, eq(organizationsPublic.id, sourcesActive.orgId))
    .where(whereClause)
    .orderBy(desc(releasesVisible.publishedAt));

  // Fetch one row past the cap so we can tell whether the cap actually
  // trimmed anything, without a separate COUNT(*) round-trip.
  const rows = await baseQuery.limit(cap + 1);

  const capped = rows.length > cap;
  const trimmed = capped ? rows.slice(0, cap) : rows;

  if (capped) {
    logEvent("warn", {
      component: "sitemap-releases",
      event: "sitemap-releases-capped",
      cap,
      // At least this many matched (there may be more past the +1 probe row;
      // this is a lower bound, not an exact total, to avoid a COUNT(*) query).
      totalMatchedAtLeast: rows.length,
      dropped: rows.length - cap,
    });
  }

  return { rows: trimmed, totalMatched: rows.length, capped };
}

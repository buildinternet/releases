/**
 * Eligibility query for batch release-content generation.
 *
 * Extracted from the poll-and-fetch workflow's `generateContentForReleases`
 * helper (which uses an `inArray(insertedIds)` bound) so the batch workflow
 * can query across all orgs over a time window without duplicating the JOIN
 * shape.
 *
 * Used by:
 *   - `workers/api/src/workflows/batch-summarize.ts`
 *
 * NOT used by scripts/generate-release-content.ts — that file uses raw SQL
 * via wrangler subprocess and is a separate refactor.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
// Relative import to the root src/ so this resolves correctly in both
// production (workers/api workspace) and bun test runs. The @releases alias
// is a wrangler-only resolution; packages can't use it.
// Path: packages/core-internal/src/ → ../../.. → repo root → src/db/...
import { releaseCoverage } from "../../../src/db/schema-coverage.js";

export interface EligibilityOptions {
  /** ISO cutoff: only return releases with `published_at >= cutoffIso`. */
  cutoffIso: string;
  /** Optional org slug filter (lowercase); null = all opted-in orgs. */
  orgSlugs?: string[] | null;
  /** Hard row cap (defense against runaway selects). Default 500. */
  maxRows?: number;
}

export interface EligibleRow {
  id: string;
  title: string;
  version: string | null;
  content: string;
  url: string | null;
  orgSlug: string;
  sourceName: string;
  productName: string | null;
}

const DEFAULT_MAX_ROWS = 500;

/**
 * Fetch releases that are eligible for batch content generation:
 *   - Org has auto_generate_content = true
 *   - Release is not suppressed
 *   - published_at >= cutoffIso
 *   - title_short IS NULL (not yet summarized)
 *   - Not a coverage-side row (coverage_id IS NULL in the join)
 *   - Source is not hidden
 *
 * Matches the JOIN shape from generateContentForReleases in
 * workers/api/src/workflows/poll-and-fetch.ts (lines 152–192), but uses a
 * time-window predicate instead of inArray(insertedIds).
 *
 * When `orgSlugs` is provided the filter is applied as
 * LOWER(organizations.slug) IN (...) so callers can pass un-normalized slugs.
 *
 * D1 bind-param cap: the IN clause for orgSlugs is chunked at 90 to stay
 * under the 100-bind cap. The main SELECT itself binds at most 4 top-level
 * params regardless of orgSlugs length, so the chunk window is the right
 * place to enforce the cap.
 */
export async function fetchEligibleReleases(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same pattern as poll-and-fetch.ts
  db: DrizzleD1Database<any>,
  options: EligibilityOptions,
): Promise<EligibleRow[]> {
  const { cutoffIso, orgSlugs, maxRows = DEFAULT_MAX_ROWS } = options;

  // Clamp maxRows: reject 0, negative, NaN, Infinity, or above the default cap.
  const safeMax = Math.max(
    1,
    Math.min(DEFAULT_MAX_ROWS, Math.floor(Number(maxRows) || DEFAULT_MAX_ROWS)),
  );

  // When orgSlugs is null (no filter), run a single query.
  if (!orgSlugs || orgSlugs.length === 0) {
    const rows: EligibleRow[] = await db
      .select({
        id: releases.id,
        title: releases.title,
        version: releases.version,
        content: releases.content,
        url: releases.url,
        orgSlug: organizations.slug,
        sourceName: sources.name,
        productName: products.name,
      })
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .leftJoin(products, eq(products.id, sources.productId))
      .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
      .where(
        and(
          eq(organizations.autoGenerateContent, true),
          eq(releases.suppressed, false),
          eq(sources.isHidden, false),
          gte(releases.publishedAt, cutoffIso),
          sql`${releases.titleGenerated} IS NULL`,
          sql`${releaseCoverage.coverageId} IS NULL`,
        ),
      )
      .orderBy(desc(releases.publishedAt))
      .limit(safeMax);
    return rows;
  }

  // Org-filter path: chunk at 90 to stay under D1's 100 bind-param cap.
  // Each chunk is sorted by publishedAt DESC and capped at safeMax. This is
  // safe because the global top-N is always a subset of ⋃(chunk_i_top_N):
  // any row in the final slice must be in at least one chunk's top-safeMax.
  // All chunks are merged, deduped, globally sorted, then sliced to safeMax.
  //
  // publishedAt is fetched for sorting only and is stripped from the output.
  type ChunkRow = EligibleRow & { publishedAt: string | null };
  const CHUNK_SIZE = 90;
  const seen = new Set<string>();
  const all: ChunkRow[] = [];

  for (let i = 0; i < orgSlugs.length; i += CHUNK_SIZE) {
    const chunk = orgSlugs.slice(i, i + CHUNK_SIZE).map((s) => s.toLowerCase());
    // eslint-disable-next-line no-await-in-loop -- D1 chunked SELECT (100 bind param limit)
    const chunkRows: ChunkRow[] = await db
      .select({
        id: releases.id,
        title: releases.title,
        version: releases.version,
        content: releases.content,
        url: releases.url,
        orgSlug: organizations.slug,
        sourceName: sources.name,
        productName: products.name,
        publishedAt: releases.publishedAt,
      })
      .from(releases)
      .innerJoin(sources, eq(sources.id, releases.sourceId))
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .leftJoin(products, eq(products.id, sources.productId))
      .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
      .where(
        and(
          eq(organizations.autoGenerateContent, true),
          eq(releases.suppressed, false),
          eq(sources.isHidden, false),
          gte(releases.publishedAt, cutoffIso),
          sql`${releases.titleGenerated} IS NULL`,
          sql`${releaseCoverage.coverageId} IS NULL`,
          inArray(sql`LOWER(${organizations.slug})`, chunk),
        ),
      )
      .orderBy(desc(releases.publishedAt))
      .limit(safeMax);

    for (const row of chunkRows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        all.push(row);
      }
    }
  }

  // Global sort: newest publishedAt first, then id as tiebreaker.
  all.sort((a, b) => {
    const cmp = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    if (cmp !== 0) return cmp;
    return a.id.localeCompare(b.id);
  });

  // Strip the ephemeral publishedAt field and slice to the requested cap.
  return all.slice(0, safeMax).map(({ publishedAt: _pa, ...rest }) => rest);
}

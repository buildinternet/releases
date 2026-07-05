/**
 * Shared read-side loading for an overview page's citations (#1934).
 *
 * `GET /v1/orgs/:slug/overview` loads them by page id; the bare `/v1/orgs/:slug`
 * serializer loads them inside its parallel query wave keyed by scope+orgId. Both
 * want the same select + link-building, so the select shape and the row mapper
 * live here to keep them from drifting.
 *
 * Each citation is a *source* the overview drew on. Where the source resolved to
 * an on-registry release (`release_id` set at write time), we build a canonical
 * internal `releaseWebUrl` so the Sources footer can link inward (crawlable,
 * on-domain) instead of only out to the third-party `sourceUrl`. The legacy
 * body-offset / verbatim-quote columns are not read.
 */

import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { knowledgePageCitations, releases } from "@buildinternet/releases-core/schema";
import { releaseWebBase, releaseWebUrl } from "@buildinternet/releases-core/release-slug";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle generic
type AnyDb = DrizzleD1Database<any>;

export interface OverviewCitationRow {
  sourceUrl: string;
  title: string | null;
  releaseId: string | null;
  /** Canonical internal release URL when `releaseId` resolved, else null. */
  releaseWebUrl: string | null;
}

/**
 * Drizzle select shape for a citation row joined to its (optional) release, so
 * the caller can build a canonical `releaseWebUrl`. Pair with `.leftJoin(releases,
 * eq(knowledgePageCitations.releaseId, releases.id))` and `mapOverviewCitationRow`.
 */
export const OVERVIEW_CITATION_SELECT = {
  sourceUrl: knowledgePageCitations.sourceUrl,
  title: knowledgePageCitations.title,
  releaseId: knowledgePageCitations.releaseId,
  relId: releases.id,
  titleShort: releases.titleShort,
  titleGenerated: releases.titleGenerated,
  relTitle: releases.title,
  version: releases.version,
} as const;

interface RawCitationRow {
  sourceUrl: string;
  title: string | null;
  releaseId: string | null;
  relId: string | null;
  titleShort: string | null;
  titleGenerated: string | null;
  relTitle: string | null;
  version: string | null;
}

/** Map a joined citation row to the wire shape, building the internal release URL when resolved. */
export function mapOverviewCitationRow(base: string, r: RawCitationRow): OverviewCitationRow {
  return {
    sourceUrl: r.sourceUrl,
    title: r.title,
    releaseId: r.releaseId,
    releaseWebUrl: r.relId
      ? releaseWebUrl(base, {
          id: r.relId,
          titleShort: r.titleShort,
          titleGenerated: r.titleGenerated,
          title: r.relTitle,
          version: r.version,
        })
      : null,
  };
}

/**
 * SQLite insertion order = the model's citation order (rows are inserted in that
 * order; rowid increments monotonically). Deterministic and stable — unlike
 * ordering by `created_at` (identical for every row of one upsert) + the random
 * nanoid `id`. Qualified because the release join also exposes a `rowid`.
 */
export const CITATION_ORDER = sql`knowledge_page_citations.rowid`;

/**
 * Load an overview page's citations by page id, with a canonical `releaseWebUrl`
 * for every citation that resolved to a release, in the model's citation order.
 */
export async function fetchOverviewCitations(
  db: AnyDb,
  knowledgePageId: string,
  env: { WEB_BASE_URL?: string } | undefined,
): Promise<OverviewCitationRow[]> {
  const base = releaseWebBase(env ?? {});
  const rows = await db
    .select(OVERVIEW_CITATION_SELECT)
    .from(knowledgePageCitations)
    .leftJoin(releases, eq(knowledgePageCitations.releaseId, releases.id))
    .where(eq(knowledgePageCitations.knowledgePageId, knowledgePageId))
    .orderBy(CITATION_ORDER);

  return rows.map((r) => mapOverviewCitationRow(base, r));
}

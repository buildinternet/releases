/**
 * Eligibility + input assembly for batch overview generation.
 *
 * Two-pass shape so the workflow can do its own filtering between the two:
 *
 *   1. `fetchOverviewCandidates` — find orgs due for regen, light shape
 *      (id, slug, recentReleaseCount, hasOverview, overviewUpdatedAt).
 *   2. `fetchOverviewInputsForOrg` — full input payload for one org: org row,
 *      active sources, existing overview content, per-source release lists +
 *      post-`selectReleasesForOverview` slice with totalAvailable.
 *
 * The workflow walks candidates → hydrates inputs → filters out empty
 * `selected` rows → submits one batch request per remaining org.
 *
 * Used by:
 *   - `workers/api/src/workflows/overview-regen.ts`
 *
 * The 2026-04-28 overview-regen feedback called out that `OVERVIEW_STALE_DAYS`
 * (30) was the wrong signal — what matters is "releases since overview." The
 * default eligibility predicate encodes the routine rule, with a per-org
 * effective cadence (#1895):
 *
 *   missing overview                           → eligible
 *   recentReleaseCount > minNewReleases AND
 *     overview.updated_at older than the org's cadence → eligible
 *
 *   cadence = org.overview_cadence_days (manual override), else
 *             fastCadenceDays when recentReleaseCount ≥ fastMinReleases,
 *             else minOverviewAgeDays
 *
 * All thresholds are options so admin POST can override per-run.
 *
 * When `orgSlugs` is an explicit non-empty list the default age and
 * min-new-releases thresholds are bypassed entirely — the operator has
 * already decided which orgs to regenerate. The only remaining guard in
 * the explicit-org path is `recentReleaseCount > 0`: if an org genuinely
 * has zero new activity since its last overview there is nothing to say,
 * so re-running would produce an identical (or empty) result.
 */

import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  knowledgePages,
  organizationsPublic,
  products,
  releases,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
import type { Release, Source } from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { resolveSourceKind, type Kind } from "@buildinternet/releases-core/kinds";
import {
  OVERVIEW_MIN_WINDOW_RELEASES,
  OVERVIEW_RELEASE_LIMIT,
  OVERVIEW_WINDOW_DAYS,
  OVERVIEW_WINDOW_FALLBACK_DAYS,
  selectReleasesForOverview,
} from "@buildinternet/releases-core/overview";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same pattern as eligibility.ts
type AnyDb = DrizzleD1Database<any>;

// ── fetchOverviewCandidates ──────────────────────────────────────────────────

export interface OverviewCandidateOptions {
  /** Min releases shipped since the last overview's `updated_at`. Default 20. */
  minNewReleases?: number;
  /** Min age of the existing overview before it's considered eligible. Default 7 days (weekly). */
  minOverviewAgeDays?: number;
  /**
   * Velocity fast tier (#1895): orgs whose `recentReleaseCount` reaches
   * `fastMinReleases` qualify at `fastCadenceDays` instead of
   * `minOverviewAgeDays`. A per-org `overview_cadence_days` override beats
   * both tiers. Defaults: 2 days at ≥15 releases.
   */
  fastCadenceDays?: number;
  /** Release velocity that promotes an org to the fast tier. Default 15. */
  fastMinReleases?: number;
  /** Hard cap on candidate count. Default 100. */
  maxCandidates?: number;
  /** Optional org slug filter — restrict the candidate set. null = all. */
  orgSlugs?: string[] | null;
}

export interface OverviewCandidate {
  orgId: string;
  orgSlug: string;
  orgName: string;
  hasOverview: boolean;
  overviewUpdatedAt: string | null;
  recentReleaseCount: number;
  /** Per-org manual cadence override (days); null = automatic velocity tier. */
  overviewCadenceDays: number | null;
}

const DEFAULT_MIN_NEW_RELEASES = 20;
// Weekly cadence: an overview is "out of date" once it's a week old (and the org
// has shipped since). The OverviewRegenWorkflow cron runs weekly, so a 7-day gate
// refreshes each active org about once a week. Was 14 — that let an org refreshed
// one week sit out the next run, so the effective cadence was ~2 weeks and the
// high-traffic orgs visibly lagged. Quiet orgs still don't churn: the
// `recentReleaseCount > 0` guard means an org with no new releases is never picked.
const DEFAULT_MIN_OVERVIEW_AGE_DAYS = 7;
// Velocity fast tier (#1895): an org shipping fast enough to hit
// `fastMinReleases` since its last overview requalifies after only
// `fastCadenceDays`. The cron fires daily, so these gates — not the cron
// schedule — set each org's effective cadence. A per-org
// `overview_cadence_days` override beats both tiers in either direction.
const DEFAULT_FAST_CADENCE_DAYS = 2;
const DEFAULT_FAST_MIN_RELEASES = 15;
const DEFAULT_MAX_CANDIDATES = 100;

/** Per-statement IN-clause cap. D1 limits prepared statements to 100 binds. */
const IN_CLAUSE_CHUNK = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Find orgs eligible for overview regeneration. Returns a light per-org shape
 * the workflow can chunk through before paying the cost of per-org input
 * hydration. Filter chain:
 *
 *   - org.discovery != 'on_demand' (we don't regen for lookup-materialized orgs)
 *   - org.autoGenerateContent = true (opt-in gate, same as batch-summarize)
 *   - org.deletedAt IS NULL (organizations_public view enforces this)
 *   - org has ≥1 active source (joined via sources_active)
 *   - eligibility predicate:
 *       missing overview, OR
 *       (recentReleaseCount > minNewReleases AND overview older than minOverviewAgeDays)
 *
 * `recentReleaseCount` counts releases with `publishedAt > overview.updated_at`
 * (or all within OVERVIEW_WINDOW_FALLBACK_DAYS when no overview exists —
 * deliberately the wider window so a quiet org that last shipped 40+ days
 * ago still qualifies for its first overview), excluding suppressed rows.
 */
export async function fetchOverviewCandidates(
  db: AnyDb,
  options: OverviewCandidateOptions = {},
): Promise<OverviewCandidate[]> {
  const {
    minNewReleases = DEFAULT_MIN_NEW_RELEASES,
    minOverviewAgeDays = DEFAULT_MIN_OVERVIEW_AGE_DAYS,
    fastCadenceDays = DEFAULT_FAST_CADENCE_DAYS,
    fastMinReleases = DEFAULT_FAST_MIN_RELEASES,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    orgSlugs,
  } = options;

  const safeMax = Math.max(
    1,
    Math.min(500, Math.floor(Number(maxCandidates) || DEFAULT_MAX_CANDIDATES)),
  );
  const cutoffForCadence = (days: number): string =>
    daysAgoIso(Math.max(0, Math.floor(Number(days) || 0)));
  // Deliberately the wider fallback window (not the default 30-day window):
  // an org with no existing overview yet may have last shipped 40-90 days ago,
  // and using the tight 30-day cutoff here would make it look inactive and
  // never qualify for its FIRST overview.
  const windowCutoffIso = daysAgoIso(OVERVIEW_WINDOW_FALLBACK_DAYS);

  // Single query: for each org, left-join its overview row and count recent
  // releases. The HAVING clause encodes the eligibility predicate. The release
  // count uses `MAX(updated_at, windowCutoff)` so never-generated orgs are
  // measured against the fallback window instead of all-time.
  const conditions = [
    ne(organizationsPublic.discovery, "on_demand"),
    eq(organizationsPublic.autoGenerateContent, true),
  ];
  if (orgSlugs && orgSlugs.length > 0) {
    const lowered = orgSlugs.map((s) => s.toLowerCase());
    // OR together IN-clause chunks so a long admin POST org list doesn't
    // overflow D1's 100-bind limit on a single statement.
    const chunks = chunk(lowered, IN_CLAUSE_CHUNK).map(
      (c) => sql`LOWER(${organizationsPublic.slug}) IN ${c}`,
    );
    conditions.push(chunks.length === 1 ? chunks[0]! : or(...chunks)!);
  }

  const rows = await db
    .select({
      orgId: organizationsPublic.id,
      orgSlug: organizationsPublic.slug,
      orgName: organizationsPublic.name,
      overviewCadenceDays: organizationsPublic.overviewCadenceDays,
      overviewUpdatedAt: knowledgePages.updatedAt,
      recentReleaseCount: sql<number>`(
        SELECT COUNT(*) FROM releases r
        INNER JOIN sources s ON s.id = r.source_id
        WHERE s.org_id = ${organizationsPublic.id}
          AND r.suppressed = 0
          AND s.is_hidden = 0
          AND r.published_at > COALESCE(${knowledgePages.updatedAt}, ${windowCutoffIso})
      )`,
    })
    .from(organizationsPublic)
    .leftJoin(
      knowledgePages,
      and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, organizationsPublic.id)),
    )
    .innerJoin(
      sourcesActive,
      and(
        eq(sourcesActive.orgId, organizationsPublic.id),
        or(eq(sourcesActive.isHidden, false), isNull(sourcesActive.isHidden)),
        or(ne(sourcesActive.fetchPriority, "paused"), isNull(sourcesActive.fetchPriority)),
      ),
    )
    .where(and(...conditions))
    .groupBy(organizationsPublic.id);

  // Apply eligibility predicate in JS against the candidate set (≤ ~500 rows).
  // Could be pushed into SQL, but the predicate references the SELECT-projection
  // alias which SQLite only honors in HAVING/ORDER BY, and the candidate set is
  // already small enough that the in-process filter is negligible.
  //
  // When the caller supplied an explicit org allowlist the age and
  // min-new-releases thresholds are skipped — the operator is the gate.
  // We still require at least one new release so we don't regenerate an
  // overview that would say nothing has changed.
  const isExplicitOrgList = Array.isArray(orgSlugs) && orgSlugs.length > 0;
  const eligible = rows.filter((r) => {
    if (isExplicitOrgList || !r.overviewUpdatedAt) return r.recentReleaseCount > 0;
    // Per-org effective cadence: manual override beats the automatic velocity
    // tier (fast when the org shipped ≥ fastMinReleases since its overview).
    const cadenceDays =
      r.overviewCadenceDays ??
      (r.recentReleaseCount >= fastMinReleases ? fastCadenceDays : minOverviewAgeDays);
    if (r.overviewUpdatedAt > cutoffForCadence(cadenceDays)) return false; // overview too fresh
    return r.recentReleaseCount > minNewReleases;
  });

  // Most-stale first: orgs with the largest `recentReleaseCount` lead so a
  // truncated run still picks the highest-value targets.
  eligible.sort((a, b) => b.recentReleaseCount - a.recentReleaseCount);

  return eligible.slice(0, safeMax).map((r) => ({
    orgId: r.orgId,
    orgSlug: r.orgSlug,
    orgName: r.orgName,
    hasOverview: r.overviewUpdatedAt !== null,
    overviewUpdatedAt: r.overviewUpdatedAt,
    recentReleaseCount: r.recentReleaseCount,
    overviewCadenceDays: r.overviewCadenceDays ?? null,
  }));
}

// ── fetchOverviewInputsForOrg ────────────────────────────────────────────────

export interface OverviewInputsForOrg {
  org: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
  };
  sources: Array<{
    id: string;
    slug: string;
    name: string;
    type: Source["type"];
  }>;
  existingContent: string | null;
  selected: Release[];
  totalAvailable: number;
  windowDays: number;
}

export interface OverviewInputsOptions {
  /**
   * Lookback window in days. Default OVERVIEW_WINDOW_DAYS (30). When omitted
   * and the default-window slice yields fewer than OVERVIEW_MIN_WINDOW_RELEASES
   * releases, the widened OVERVIEW_WINDOW_FALLBACK_DAYS (90) is used instead —
   * an explicit windowDays always bypasses this fallback.
   */
  windowDays?: number;
  /** Cap on selected releases. Default OVERVIEW_RELEASE_LIMIT (50). */
  limit?: number;
}

/**
 * Hydrate the per-org overview-input payload. Mirrors the shape of
 * `GET /v1/orgs/:slug/overview/inputs` (workers/api/src/routes/overview-inputs.ts)
 * but without the HTTP layer or media-URL hydration — the workflow runs against
 * the same MEDIA_ORIGIN-aware hydration step in its own boundary.
 *
 * Returns null when the org doesn't exist.
 */
export async function fetchOverviewInputsForOrg(
  db: AnyDb,
  orgId: string,
  options: OverviewInputsOptions = {},
): Promise<OverviewInputsForOrg | null> {
  // Track whether the caller passed an explicit windowDays — only the default
  // (30-day) case is eligible for the quiet-org 90-day widen below; an explicit
  // caller-supplied window is respected as-is.
  const explicitWindowDays = options.windowDays != null;
  const windowDays = Math.max(1, Math.floor(Number(options.windowDays) || OVERVIEW_WINDOW_DAYS));
  const limit = Math.max(1, Math.floor(Number(options.limit) || OVERVIEW_RELEASE_LIMIT));

  const [org] = await db
    .select({
      id: organizationsPublic.id,
      slug: organizationsPublic.slug,
      name: organizationsPublic.name,
      description: organizationsPublic.description,
    })
    .from(organizationsPublic)
    .where(eq(organizationsPublic.id, orgId));
  if (!org) return null;

  const activeSources = await db
    .select({
      id: sourcesActive.id,
      slug: sourcesActive.slug,
      name: sourcesActive.name,
      type: sourcesActive.type,
      kind: sourcesActive.kind,
      productId: sourcesActive.productId,
    })
    .from(sourcesActive)
    .where(
      and(
        eq(sourcesActive.orgId, org.id),
        or(eq(sourcesActive.isHidden, false), isNull(sourcesActive.isHidden)),
        or(ne(sourcesActive.fetchPriority, "paused"), isNull(sourcesActive.fetchPriority)),
      ),
    );

  // Fetched before the empty-sources early return so the existing overview is
  // still reported for an org whose sources are all hidden/paused — matches the
  // route handler this helper mirrors. (The overview-regen workflow never hits
  // the empty-sources branch: candidates require ≥1 active source.)
  const [existing] = await db
    .select({ content: knowledgePages.content })
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)));

  if (activeSources.length === 0) {
    return {
      org,
      sources: [],
      existingContent: existing?.content ?? null,
      selected: [],
      totalAvailable: 0,
      windowDays,
    };
  }

  // One IN-bound SELECT instead of N per-source SELECTs. Up to ~20 sources per
  // org × 100 orgs = ~2,000 round-trips becomes ~100 — well under D1's per-
  // request statement budget. Caller groups by sourceId locally. The IN clause
  // is OR-chunked at 90 binds to defend against the rare orgs that exceed
  // D1's 100-bind cap on a single statement.
  const sourceIds = activeSources.map((s) => s.id);
  const sourceIdChunks = chunk(sourceIds, IN_CLAUSE_CHUNK).map((c) =>
    inArray(releases.sourceId, c),
  );
  const sourceCondition = sourceIdChunks.length === 1 ? sourceIdChunks[0]! : or(...sourceIdChunks)!;
  const orgProducts = await db
    .select({ id: products.id, kind: products.kind })
    .from(products)
    .where(eq(products.orgId, org.id));
  const productKindById = new Map(orgProducts.map((p) => [p.id, p.kind]));

  // Selects + runs selectReleasesForOverview for a given window, in days.
  const selectForWindow = async (
    days: number,
  ): Promise<{ releases: Release[]; totalAvailable: number }> => {
    const cutoff = daysAgoIso(days);
    const allRows = await db
      .select()
      .from(releases)
      .where(
        and(sourceCondition, gte(releases.publishedAt, cutoff), eq(releases.suppressed, false)),
      )
      .orderBy(desc(releases.publishedAt));

    const releasesBySource = new Map<string, Release[]>();
    for (const r of allRows) {
      const list = releasesBySource.get(r.sourceId) ?? [];
      list.push(r);
      releasesBySource.set(r.sourceId, list);
    }

    const releasesPerSource = activeSources.map((s) => ({
      type: s.type,
      kind: resolveSourceKind(
        { kind: s.kind as Kind | null },
        s.productId ? { kind: (productKindById.get(s.productId) ?? null) as Kind | null } : null,
      ),
      // Group key for the per-product budget step in selectReleasesForOverview.
      productId: s.productId,
      releases: releasesBySource.get(s.id) ?? [],
    }));

    return selectReleasesForOverview(releasesPerSource, limit);
  };

  let effectiveWindowDays = windowDays;
  let { releases: selected, totalAvailable } = await selectForWindow(windowDays);

  // Quiet-org fallback: only when the caller didn't pin an explicit window and
  // the default-window slice is too thin, re-run selection against the wider
  // fallback window so the org's overview keeps substance.
  if (
    !explicitWindowDays &&
    selected.length < OVERVIEW_MIN_WINDOW_RELEASES &&
    totalAvailable < OVERVIEW_MIN_WINDOW_RELEASES
  ) {
    effectiveWindowDays = OVERVIEW_WINDOW_FALLBACK_DAYS;
    ({ releases: selected, totalAvailable } = await selectForWindow(OVERVIEW_WINDOW_FALLBACK_DAYS));
  }

  return {
    org,
    // Project to the declared interface — `kind`/`productId` are selected only
    // to resolve each source's kind for overview selection, not part of the
    // returned contract.
    sources: activeSources.map(({ id, slug, name, type }) => ({ id, slug, name, type })),
    existingContent: existing?.content ?? null,
    selected,
    totalAvailable,
    windowDays: effectiveWindowDays,
  };
}

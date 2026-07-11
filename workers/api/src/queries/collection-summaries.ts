import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  collectionMembers,
  collectionDailySummaries,
  collectionWeeklyDigests,
  organizationsActive,
  organizationsPublic,
  productsActive,
  releasesVisible,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
import { addDaysToDateKey } from "@buildinternet/releases-core/dates";
import type { AnyDb } from "../db.js";
import type { CollectionDayRelease } from "@releases/ai-internal/collection-summary";
import type { WeeklyDigestRelease } from "@releases/ai-internal/collection-weekly-digest";

/** Visible org + product member ids for a collection (same views as the feed). */
export async function getCollectionMembers(
  db: AnyDb,
  collectionId: string,
): Promise<{ orgIds: string[]; productIds: string[] }> {
  const [orgRows, productRows] = await Promise.all([
    db
      .select({ orgId: organizationsPublic.id })
      .from(collectionMembers)
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
      .where(eq(collectionMembers.collectionId, collectionId)),
    // Inner-join through organizationsPublic on the parent org so a product
    // attached to an on_demand / soft-deleted org doesn't surface releases.
    db
      .select({ productId: productsActive.id })
      .from(collectionMembers)
      .innerJoin(productsActive, eq(productsActive.id, collectionMembers.productId))
      .innerJoin(organizationsPublic, eq(organizationsPublic.id, productsActive.orgId))
      .where(eq(collectionMembers.collectionId, collectionId)),
  ]);
  return {
    orgIds: orgRows.map((r) => r.orgId),
    productIds: productRows.map((r) => r.productId),
  };
}

/**
 * Releases for a collection's members published in `[startUtc, endUtc)`.
 *
 * Visibility mirrors the collection feed (`getCollectionReleasesFeed`): scan
 * `releases_visible` (excludes suppressed + coverage-side rows) joined through
 * `sources_active` / `organizations_active` (sheds soft-deleted sources/orgs),
 * so a release appears in the day summary iff it would appear in the feed for
 * that day. Product membership is resolved through `sourcesActive.productId` —
 * the releases table/view has no direct productId column. Member sets are small
 * (curated), so a single inArray each is within D1's 100-bind limit.
 *
 * Rows come back importance-first (`>= 4`), then published-desc, so the caller's
 * per-day cap and body-excerpt budget favor high-signal releases — see the
 * `orderBy` note below.
 */
export async function getCollectionDayReleases(
  db: AnyDb,
  members: { orgIds: string[]; productIds: string[] },
  window: { startUtc: string; endUtc: string },
): Promise<CollectionDayRelease[]> {
  const memberConds = [];
  if (members.orgIds.length) memberConds.push(inArray(sourcesActive.orgId, members.orgIds));
  if (members.productIds.length)
    memberConds.push(inArray(sourcesActive.productId, members.productIds));
  if (memberConds.length === 0) return [];

  const rows = await db
    .select({
      orgName: organizationsActive.name,
      productName: productsActive.name,
      sourceName: sourcesActive.name,
      title: releasesVisible.title,
      titleGenerated: releasesVisible.titleGenerated,
      summary: releasesVisible.summary,
      content: releasesVisible.content,
      publishedAt: releasesVisible.publishedAt,
    })
    .from(releasesVisible)
    .innerJoin(sourcesActive, eq(sourcesActive.id, releasesVisible.sourceId))
    .innerJoin(organizationsActive, eq(organizationsActive.id, sourcesActive.orgId))
    .leftJoin(productsActive, eq(productsActive.id, sourcesActive.productId))
    .where(
      and(
        gte(releasesVisible.publishedAt, window.startUtc),
        lt(releasesVisible.publishedAt, window.endUtc),
        or(...memberConds),
      ),
    )
    // High-signal releases (AI-scored importance >= 4, matching the web flame
    // threshold) lead, then chronology. The downstream summarizer caps the day at
    // MAX_RELEASES and allocates a shared body-excerpt budget first-come, so this
    // ordering is what guarantees a breaking change survives the cap and gets its
    // body excerpt instead of losing both to churn published later the same day.
    // NULL importance is `unknown`, not `unimportant`: `importance >= 4` is NULL
    // for unscored rows, so the CASE folds them into the same bucket as scored-low
    // releases — deprioritized for promotion, never sorted dead-last or dropped.
    .orderBy(
      sql`CASE WHEN ${releasesVisible.importance} >= 4 THEN 0 ELSE 1 END`,
      desc(releasesVisible.publishedAt),
    );

  return rows.map((r) => ({
    org: r.orgName,
    product: r.productName ?? r.sourceName ?? null,
    title: r.titleGenerated ?? r.title,
    summary: r.summary ?? null,
    body: r.content ?? null,
  }));
}

export interface DailySummaryRow {
  date: string;
  title: string;
  summary: string;
  takeaways: string[];
  releaseCount: number;
}

export async function listCollectionDailySummaries(
  db: AnyDb,
  collectionId: string,
  from: string,
  to: string,
): Promise<DailySummaryRow[]> {
  const rows = await db
    .select()
    .from(collectionDailySummaries)
    .where(
      and(
        eq(collectionDailySummaries.collectionId, collectionId),
        gte(collectionDailySummaries.summaryDate, from),
        // `to` is inclusive at the API; bump to an exclusive upper bound.
        lt(collectionDailySummaries.summaryDate, addDaysToDateKey(to, 1)),
      ),
    )
    .orderBy(desc(collectionDailySummaries.summaryDate));
  return rows.map((r) => ({
    date: r.summaryDate,
    title: r.title,
    summary: r.summary,
    takeaways: safeParseTakeaways(r.takeaways),
    releaseCount: r.releaseCount,
  }));
}

function safeParseTakeaways(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface UpsertSummaryInput {
  collectionId: string;
  summaryDate: string;
  title: string;
  summary: string;
  takeaways: string[];
  releaseCount: number;
  modelId: string | null;
}

export async function upsertCollectionDailySummary(
  db: AnyDb,
  input: UpsertSummaryInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(collectionDailySummaries)
    .values({
      collectionId: input.collectionId,
      summaryDate: input.summaryDate,
      title: input.title,
      summary: input.summary,
      takeaways: JSON.stringify(input.takeaways),
      releaseCount: input.releaseCount,
      modelId: input.modelId,
      generatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [collectionDailySummaries.collectionId, collectionDailySummaries.summaryDate],
      set: {
        title: input.title,
        summary: input.summary,
        takeaways: JSON.stringify(input.takeaways),
        releaseCount: input.releaseCount,
        modelId: input.modelId,
        updatedAt: now,
      },
    });
}

// ── Weekly digests ────────────────────────────────────────────────

/**
 * Releases for a collection's members published in `[startUtc, endUtc)`
 * (an ET week's bounds), including `id` and `importance` — needed for the
 * digest's importance-biased selection and link-placeholder resolution,
 * unlike the daily rollup which never links out. Visibility/join shape
 * mirrors `getCollectionDayReleases` above.
 */
export async function getCollectionWeekReleases(
  db: AnyDb,
  members: { orgIds: string[]; productIds: string[] },
  window: { startUtc: string; endUtc: string },
): Promise<WeeklyDigestRelease[]> {
  const memberConds = [];
  if (members.orgIds.length) memberConds.push(inArray(sourcesActive.orgId, members.orgIds));
  if (members.productIds.length)
    memberConds.push(inArray(sourcesActive.productId, members.productIds));
  if (memberConds.length === 0) return [];

  const rows = await db
    .select({
      id: releasesVisible.id,
      orgName: organizationsActive.name,
      productName: productsActive.name,
      sourceName: sourcesActive.name,
      title: releasesVisible.title,
      titleGenerated: releasesVisible.titleGenerated,
      summary: releasesVisible.summary,
      content: releasesVisible.content,
      publishedAt: releasesVisible.publishedAt,
      importance: releasesVisible.importance,
    })
    .from(releasesVisible)
    .innerJoin(sourcesActive, eq(sourcesActive.id, releasesVisible.sourceId))
    .innerJoin(organizationsActive, eq(organizationsActive.id, sourcesActive.orgId))
    .leftJoin(productsActive, eq(productsActive.id, sourcesActive.productId))
    .where(
      and(
        gte(releasesVisible.publishedAt, window.startUtc),
        lt(releasesVisible.publishedAt, window.endUtc),
        or(...memberConds),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${releasesVisible.importance} >= 4 THEN 0 ELSE 1 END`,
      desc(releasesVisible.publishedAt),
    );

  return rows.map((r) => ({
    id: r.id,
    org: r.orgName,
    product: r.productName ?? r.sourceName ?? null,
    title: r.titleGenerated ?? r.title,
    summary: r.summary ?? null,
    body: r.content ?? null,
    // The window filter guarantees a non-null publishedAt for every included
    // row; the `?? ""` is just to satisfy the (nullable at the type level)
    // view column.
    publishedAt: r.publishedAt ?? "",
    importance: r.importance ?? null,
  }));
}

/** Whether a weekly digest row already exists for (collectionId, weekStart). */
export async function hasCollectionWeeklyDigest(
  db: AnyDb,
  collectionId: string,
  weekStart: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: collectionWeeklyDigests.id })
    .from(collectionWeeklyDigests)
    .where(
      and(
        eq(collectionWeeklyDigests.collectionId, collectionId),
        eq(collectionWeeklyDigests.weekStart, weekStart),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface UpsertWeeklyDigestInput {
  collectionId: string;
  weekStart: string;
  title: string;
  intro: string;
  body: string;
  releaseIds: string[];
  releaseCount: number;
  modelId: string | null;
}

export async function upsertCollectionWeeklyDigest(
  db: AnyDb,
  input: UpsertWeeklyDigestInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(collectionWeeklyDigests)
    .values({
      collectionId: input.collectionId,
      weekStart: input.weekStart,
      title: input.title,
      intro: input.intro,
      body: input.body,
      releaseIds: JSON.stringify(input.releaseIds),
      releaseCount: input.releaseCount,
      modelId: input.modelId,
      generatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [collectionWeeklyDigests.collectionId, collectionWeeklyDigests.weekStart],
      set: {
        title: input.title,
        intro: input.intro,
        body: input.body,
        releaseIds: JSON.stringify(input.releaseIds),
        releaseCount: input.releaseCount,
        modelId: input.modelId,
        updatedAt: now,
      },
    });
}

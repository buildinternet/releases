import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import {
  collectionMembers,
  collectionDailySummaries,
  organizationsActive,
  organizationsPublic,
  productsActive,
  releasesVisible,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";
import type { CollectionDayRelease } from "@releases/ai-internal/collection-summary";

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
    .orderBy(desc(releasesVisible.publishedAt));

  return rows.map((r) => ({
    org: r.orgName,
    product: r.productName ?? r.sourceName ?? null,
    title: r.titleGenerated ?? r.title,
    summary: r.summary ?? null,
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
        lt(collectionDailySummaries.summaryDate, addExclusiveUpper(to)),
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

// `to` is inclusive at the API; bump to an exclusive upper bound on YYYY-MM-DD.
function addExclusiveUpper(to: string): string {
  const [y, m, d] = to.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
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

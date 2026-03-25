import { eq, desc, gte, and } from "drizzle-orm";
import { getDb } from "./connection.js";
import { sources, releases, type Source, type Release } from "./schema.js";

export async function findSourceBySlug(slug: string): Promise<Source | null> {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, slug));
  return source ?? null;
}

export async function getRecentReleases(
  sourceId: number,
  cutoffIso: string,
): Promise<Release[]> {
  const db = getDb();
  return db
    .select()
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoffIso)))
    .orderBy(desc(releases.publishedAt));
}

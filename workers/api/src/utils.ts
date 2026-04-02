import { eq } from "drizzle-orm";
import { tags } from "@released/db/schema.js";
import { toSlug } from "@released/lib/slug.js";

/**
 * D1 wraps SQLite errors as "Failed query: ..." without preserving the
 * original constraint violation message. We detect conflicts by checking
 * if the insert query failed — for endpoints that use UNIQUE columns,
 * a failed insert is almost certainly a constraint violation.
 */
export function isConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("constraint")) return true;
  if (msg.includes("Failed query") && msg.includes("insert into")) return true;
  return false;
}

export function getStatusHub(env: { STATUS_HUB: DurableObjectNamespace }) {
  return env.STATUS_HUB.get(env.STATUS_HUB.idFromName("global"));
}

/** Get-or-create a tag by name. Shared across org and product routes. */
export async function getOrCreateTagD1(
  db: ReturnType<typeof import("./db.js").createDb>,
  name: string,
) {
  const slug = toSlug(name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (existing) return existing;
  const [created] = await db.insert(tags).values({ name, slug, createdAt: new Date().toISOString() }).returning();
  return created;
}

export function computeAvgPerWeek(totalReleases: number, oldestPublishedAt: string | null): number {
  if (totalReleases === 0 || !oldestPublishedAt) return 0;
  const weeks = (Date.now() - new Date(oldestPublishedAt).getTime()) / (7 * 24 * 60 * 60 * 1000);
  if (weeks < 1) return totalReleases;
  return Math.round((totalReleases / weeks) * 10) / 10;
}

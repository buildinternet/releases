import { eq, inArray } from "drizzle-orm";
import { tags, sources, organizations, products } from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
export { hydrateMediaUrls, resolveR2Url } from "@releases/lib/media-url.js";

/** Resolve a source by ID (src_ prefix) or slug */
export function sourceWhere(identifier: string) {
  return identifier.startsWith("src_") ? eq(sources.id, identifier) : eq(sources.slug, identifier);
}

/** Resolve an org by ID (org_ prefix) or slug */
export function orgWhere(identifier: string) {
  return identifier.startsWith("org_")
    ? eq(organizations.id, identifier)
    : eq(organizations.slug, identifier);
}

/** Resolve a product by ID (prod_ prefix) or slug */
export function productWhere(identifier: string) {
  return identifier.startsWith("prod_")
    ? eq(products.id, identifier)
    : eq(products.slug, identifier);
}

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

export function getReleaseHub(env: { RELEASE_HUB: DurableObjectNamespace }) {
  return env.RELEASE_HUB.get(env.RELEASE_HUB.idFromName("global"));
}

/** Get-or-create a tag by name. Shared across org and product routes. */
export async function getOrCreateTagD1(
  db: ReturnType<typeof import("./db.js").createDb>,
  name: string,
) {
  const slug = toSlug(name);
  const [existing] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (existing) return existing;
  const [created] = await db
    .insert(tags)
    .values({ name, slug, createdAt: new Date().toISOString() })
    .returning();
  return created;
}

/**
 * Get-or-create a batch of tags by name in a constant number of roundtrips.
 * Returns resolved tag rows for the given names (deduped by slug).
 */
export async function getOrCreateTagsD1(
  db: ReturnType<typeof import("./db.js").createDb>,
  names: string[],
): Promise<{ id: string; name: string; slug: string }[]> {
  if (names.length === 0) return [];
  const bySlug = new Map<string, string>();
  for (const name of names) {
    const slug = toSlug(name);
    if (!bySlug.has(slug)) bySlug.set(slug, name);
  }
  const now = new Date().toISOString();
  const rows = Array.from(bySlug.entries()).map(([slug, name]) => ({ name, slug, createdAt: now }));
  await db.insert(tags).values(rows).onConflictDoNothing();
  return db
    .select({ id: tags.id, name: tags.name, slug: tags.slug })
    .from(tags)
    .where(inArray(tags.slug, Array.from(bySlug.keys())));
}

const ROLLING_WINDOW_DAYS = 90;

/** Avg releases/week over a rolling 90-day window, or the actual span if shorter. */
export function computeAvgPerWeek(
  releasesInWindow: number,
  oldestPublishedAt: string | null,
): number {
  if (releasesInWindow === 0 || !oldestPublishedAt) return 0;
  const ageMs = Date.now() - new Date(oldestPublishedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const effectiveDays = Math.min(ROLLING_WINDOW_DAYS, ageDays);
  const weeks = effectiveDays / 7;
  if (weeks < 1) return releasesInWindow;
  return Math.round((releasesInWindow / weeks) * 10) / 10;
}

/** Generate a knowledge page ID. Shared by route handlers and playbook-regen. */
export function newKnowledgePageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  return "kp_" + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Compute the 52-week date range used for heatmap endpoints. */
/** Parse a `?flag=true` query param. Any other value (including "1", missing) is false. */
export function parseBoolParam(raw: string | undefined): boolean {
  return raw === "true";
}

export function heatmapDateRange(): { from: string; to: string; toExclusive: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const toExclusiveDate = new Date(today);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toExclusive = toExclusiveDate.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - 52 * 7);
  const from = fromDate.toISOString().slice(0, 10);
  return { from, to, toExclusive };
}

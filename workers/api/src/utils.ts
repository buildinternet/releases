import { eq } from "drizzle-orm";
import { tags, sources, organizations, products } from "@releases/db/schema.js";
import { toSlug } from "@releases/lib/slug.js";

/** Resolve a source by ID (src_ prefix) or slug */
export function sourceWhere(identifier: string) {
  return identifier.startsWith("src_")
    ? eq(sources.id, identifier)
    : eq(sources.slug, identifier);
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

const ROLLING_WINDOW_DAYS = 90;

/** Avg releases/week over a rolling 90-day window, or the actual span if shorter. */
export function computeAvgPerWeek(releasesInWindow: number, oldestPublishedAt: string | null): number {
  if (releasesInWindow === 0 || !oldestPublishedAt) return 0;
  const ageMs = Date.now() - new Date(oldestPublishedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const effectiveDays = Math.min(ROLLING_WINDOW_DAYS, ageDays);
  const weeks = effectiveDays / 7;
  if (weeks < 1) return releasesInWindow;
  return Math.round((releasesInWindow / weeks) * 10) / 10;
}

/** Generate a knowledge page ID. Shared by route handlers and source-guide-regen. */
export function newKnowledgePageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  return "kp_" + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

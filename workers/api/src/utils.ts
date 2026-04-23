import { eq, inArray, and } from "drizzle-orm";
import {
  tags,
  sources,
  organizations,
  products,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import { resolveR2Url } from "@releases/lib/media-url.js";
import type { MediaItem } from "@releases/lib/api-types";
import type { createDb } from "./db.js";
export { hydrateMediaUrls, resolveR2Url } from "@releases/lib/media-url.js";

type RawMediaRow = MediaItem & { r2Key?: string | null };

/**
 * Parse a `releases.media` JSON blob and resolve each entry's `r2Key` into a
 * signed `r2Url` so the web never sees raw R2 keys. Malformed JSON collapses
 * to an empty list rather than throwing — one bad row shouldn't blank a page.
 */
export function parseReleaseMedia(raw: string | null, mediaOrigin: string): MediaItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((m: RawMediaRow) =>
    Object.assign({}, m, { r2Url: resolveR2Url(m.r2Key, mediaOrigin) }),
  );
}

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

type AliasTarget =
  | { orgId: string; productId?: undefined }
  | { productId: string; orgId?: undefined };

/**
 * Replace the owner's alias set with `aliases`. Returns the first domain that
 * collides with a different owner, or null on success — domain_aliases is
 * globally unique.
 */
export async function replaceAliases(
  db: ReturnType<typeof createDb>,
  opts: AliasTarget & { aliases: string[] },
): Promise<{ conflict: string | null }> {
  const isOrg = "orgId" in opts && !!opts.orgId;
  const ownerCol = isOrg ? domainAliases.orgId : domainAliases.productId;
  const ownerId = isOrg ? opts.orgId! : opts.productId!;

  const deduped = Array.from(new Set(opts.aliases.map((d) => d.trim()).filter(Boolean)));

  const existing = await db
    .select({ domain: domainAliases.domain })
    .from(domainAliases)
    .where(eq(ownerCol, ownerId));
  const existingSet = new Set(existing.map((r) => r.domain));
  const nextSet = new Set(deduped);

  const toDelete = [...existingSet].filter((d) => !nextSet.has(d));
  const toInsert = deduped.filter((d) => !existingSet.has(d));

  if (toInsert.length > 0) {
    const conflicts = await db
      .select({ domain: domainAliases.domain })
      .from(domainAliases)
      .where(inArray(domainAliases.domain, toInsert));
    const foreign = conflicts.find((c) => !existingSet.has(c.domain));
    if (foreign) return { conflict: foreign.domain };
  }

  if (toDelete.length > 0) {
    await db
      .delete(domainAliases)
      .where(and(eq(ownerCol, ownerId), inArray(domainAliases.domain, toDelete)));
  }

  if (toInsert.length > 0) {
    const now = new Date().toISOString();
    await db.insert(domainAliases).values(
      toInsert.map((domain) => ({
        domain,
        orgId: isOrg ? opts.orgId! : null,
        productId: isOrg ? null : opts.productId!,
        createdAt: now,
      })),
    );
  }

  return { conflict: null };
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

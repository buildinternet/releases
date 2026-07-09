/**
 * Denormalized category for category-feed seeks (#886).
 *
 * Wire semantics match getCategoryReleasesFeed / category-feed.test.ts:
 *   effective_category = COALESCE(product.category, org.category)
 *
 * Product category overrides org; no-product and NULL product category fall
 * through to the org. Null when neither is set.
 */
import { sql } from "drizzle-orm";
import { IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";

/** Pure COALESCE — product wins, then org, else null. */
export function resolveEffectiveCategory(
  productCategory: string | null | undefined,
  orgCategory: string | null | undefined,
): string | null {
  return productCategory ?? orgCategory ?? null;
}

/** Minimal runner for the recompute UPDATEs (drizzle + raw sql). */
export type EffectiveCategoryDb = {
  run(query: ReturnType<typeof sql>): Promise<unknown>;
  all<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]>;
};

/**
 * Load effective category for many sources in one (or chunked) query.
 * Missing / unknown source ids map to null.
 */
export async function fetchEffectiveCategoryBySourceIds(
  db: EffectiveCategoryDb,
  sourceIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (sourceIds.length === 0) return out;
  for (let i = 0; i < sourceIds.length; i += IN_ARRAY_CHUNK_SIZE) {
    const chunk = sourceIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
    const idList = sql`(${sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    )})`;
    // oxlint-disable-next-line no-await-in-loop -- D1 bind-chunked IN list
    const rows = await db.all<{ id: string; effective_category: string | null }>(sql`
      SELECT s.id AS id, COALESCE(p.category, o.category) AS effective_category
      FROM sources s
      INNER JOIN organizations o ON o.id = s.org_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE s.id IN ${idList}
    `);
    for (const r of rows) out.set(r.id, r.effective_category);
  }
  return out;
}

/** Stamp every release for a source from the live product/org join. */
export async function recomputeReleaseEffectiveCategoryForSource(
  db: EffectiveCategoryDb,
  sourceId: string,
): Promise<void> {
  await db.run(sql`
    UPDATE releases
    SET effective_category = (
      SELECT COALESCE(p.category, o.category)
      FROM sources s
      INNER JOIN organizations o ON o.id = s.org_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE s.id = ${sourceId}
    )
    WHERE source_id = ${sourceId}
  `);
}

/** Stamp every release whose source is bound to this product. */
export async function recomputeReleaseEffectiveCategoryForProduct(
  db: EffectiveCategoryDb,
  productId: string,
): Promise<void> {
  await db.run(sql`
    UPDATE releases
    SET effective_category = (
      SELECT COALESCE(p.category, o.category)
      FROM sources s
      INNER JOIN organizations o ON o.id = s.org_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE s.id = releases.source_id
    )
    WHERE source_id IN (SELECT id FROM sources WHERE product_id = ${productId})
  `);
}

/**
 * Stamp every release under this org's sources.
 * (Includes product-overridden rows — recompute is idempotent and cheaper than
 * filtering "only when product.category IS NULL".)
 */
export async function recomputeReleaseEffectiveCategoryForOrg(
  db: EffectiveCategoryDb,
  orgId: string,
): Promise<void> {
  await db.run(sql`
    UPDATE releases
    SET effective_category = (
      SELECT COALESCE(p.category, o.category)
      FROM sources s
      INNER JOIN organizations o ON o.id = s.org_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE s.id = releases.source_id
    )
    WHERE source_id IN (SELECT id FROM sources WHERE org_id = ${orgId})
  `);
}

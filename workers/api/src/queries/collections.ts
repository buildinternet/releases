import { sql, type SQL } from "drizzle-orm";
import type { CollectionListItem } from "@buildinternet/releases-api-types";
import type { D1Db } from "../db.js";

/**
 * Collections matching `where` (a predicate over the `collections c` alias),
 * each with its visible member count (orgs via `organizations_public` + products
 * via `products_active`, the latter gated through a visible parent org so an
 * on_demand org's product can't inflate the total). Ordered alphabetically by
 * name. Shared by `GET /v1/orgs/:slug/collections` and
 * `GET /v1/products/:slug/collections` so the "Featured in" sidebar counts the
 * same way at both levels.
 *
 * Raw SQL (not the Drizzle query builder) because the relational `${collections.id}`
 * reference mis-binds against the inner `id` aliases (`op.id`, `pa.id`) and
 * silently yields 0 — the same reason `GET /v1/collections` hand-writes its count.
 */
export async function listCollectionsWhere(db: D1Db, where: SQL): Promise<CollectionListItem[]> {
  const rows = await db.all<{
    slug: string;
    name: string;
    description: string | null;
    isFeatured: number;
    orgCount: number;
    productCount: number;
  }>(sql`
    SELECT c.slug, c.name, c.description, c.is_featured AS isFeatured,
      (SELECT COUNT(*) FROM collection_members cm
         INNER JOIN organizations_public op ON op.id = cm.org_id
         WHERE cm.collection_id = c.id) AS orgCount,
      (SELECT COUNT(*) FROM collection_members cm
         INNER JOIN products_active pa ON pa.id = cm.product_id
         INNER JOIN organizations_public op ON op.id = pa.org_id
         WHERE cm.collection_id = c.id) AS productCount
    FROM collections c
    WHERE ${where}
    ORDER BY c.name
  `);

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    isFeatured: Boolean(r.isFeatured),
    memberCount: Number(r.orgCount) + Number(r.productCount),
  }));
}

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { searchToMarkdown } from "@released/lib/formatters.js";
import type { Env } from "../index.js";
import type {
  SearchOrgHit,
  SearchProductHit,
  SearchSourceHit,
  SearchReleaseHit,
} from "../../../../src/api/types.js";

export const searchRoutes = new Hono<Env>();

searchRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.json(
      { error: "bad_request", message: "Missing required query parameter: q" },
      400,
    );
  }

  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const db = createDb(c.env.DB);
  const pattern = `%${q}%`;

  const [orgs, products, sources, ftsReleases] = await Promise.all([
    db.all<SearchOrgHit>(sql`
      SELECT slug, name, domain, NULL as avatarUrl, category
      FROM organizations
      WHERE name LIKE ${pattern} OR slug LIKE ${pattern} OR domain LIKE ${pattern}
      ORDER BY name LIMIT ${limit}
    `),

    db.all<SearchProductHit>(sql`
      SELECT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
      FROM products p
      LEFT JOIN organizations o ON o.id = p.org_id
      WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern}
      ORDER BY p.name LIMIT ${limit}
    `),

    db.all<SearchSourceHit>(sql`
      SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName,
             p.slug as productSlug
      FROM sources s
      LEFT JOIN organizations o ON o.id = s.org_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
        AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
      ORDER BY s.name LIMIT ${limit}
    `),

    (async () => {
      try {
        return await db.all<SearchReleaseHit>(sql`
          SELECT s.slug as sourceSlug, s.name as sourceName, o.slug as orgSlug,
                 r.version, r.title,
                 COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
                 r.published_at as publishedAt
          FROM releases_fts
          JOIN releases r ON r.rowid = releases_fts.rowid
          JOIN sources s ON s.id = r.source_id
          LEFT JOIN organizations o ON o.id = s.org_id
          WHERE releases_fts MATCH ${q}
            AND (r.suppressed IS NULL OR r.suppressed = 0)
            AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
          ORDER BY rank LIMIT ${limit} OFFSET ${offset}
        `);
      } catch {
        return [];
      }
    })(),
  ]);

  // Cascading enrichment: show recent releases from matched orgs/products
  let releases = ftsReleases;
  if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
    const orgSlugs = orgs.map((o) => o.slug);
    const productSlugs = products.map((p) => p.slug);
    const conditions = [];
    if (orgSlugs.length > 0) conditions.push(sql`o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})`);
    if (productSlugs.length > 0) conditions.push(sql`p.slug IN (${sql.join(productSlugs.map((s) => sql`${s}`), sql`, `)})`);
    if (conditions.length > 0) {
      releases = await db.all<SearchReleaseHit>(sql`
        SELECT s.slug as sourceSlug, s.name as sourceName, o.slug as orgSlug,
               r.version, r.title,
               COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
               r.published_at as publishedAt
        FROM releases r
        JOIN sources s ON s.id = r.source_id
        LEFT JOIN organizations o ON o.id = s.org_id
        LEFT JOIN products p ON p.id = s.product_id
        WHERE (r.suppressed IS NULL OR r.suppressed = 0)
          AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
          AND (${sql.join(conditions, sql` OR `)})
        ORDER BY r.published_at DESC LIMIT ${limit}
      `);
    }
  }

  const result = { query: q, orgs, products, sources, releases };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, searchToMarkdown(result));
  }

  return c.json(result);
});

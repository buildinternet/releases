import { Hono } from "hono";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { searchToMarkdown } from "@releases/lib/formatters.js";
import type { Env } from "../index.js";
import type { SearchReleaseHit } from "../../../../src/api/types.js";
import { createDb } from "../db.js";
import {
  searchOrgs,
  searchProducts,
  searchSources,
  searchReleasesFts,
  searchReleasesFromMatchedEntities,
} from "../queries/search.js";

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
    searchOrgs(db, pattern, limit),
    searchProducts(db, pattern, limit),
    searchSources(db, pattern, limit),
    searchReleasesFts(db, q, limit, offset).catch(() => [] as SearchReleaseHit[]),
  ]);

  let releases = ftsReleases;
  if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
    releases = await searchReleasesFromMatchedEntities(
      db,
      orgs.map((o) => o.slug),
      products.map((p) => p.slug),
      limit,
    );
  }

  const result = { query: q, orgs, products, sources, releases };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, searchToMarkdown(result));
  }

  return c.json(result);
});

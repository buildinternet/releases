import { Hono } from "hono";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { searchToMarkdown } from "@releases/lib/formatters.js";
import { foldSourcesIntoProducts } from "@releases/api/types.js";
import type { Env } from "../index.js";
import type { SearchReleaseHit } from "@releases/api/types.js";
import { createDb } from "../db.js";
import {
  searchOrgs,
  searchProducts,
  searchSources,
  searchReleasesFts,
  searchReleasesFromMatchedEntities,
} from "../queries/search.js";
import { runHybridSearch, type HybridMode } from "../lib/search-hybrid.js";

export const searchRoutes = new Hono<Env>();

function parseMode(raw: string | undefined): HybridMode {
  if (raw === "lexical" || raw === "semantic" || raw === "hybrid") return raw;
  return "hybrid";
}

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
  const mode = parseMode(c.req.query("mode"));
  const db = createDb(c.env.DB);
  const pattern = `%${q}%`;

  // Entity lookups stay lexical — semantic lives behind /search_registry on
  // MCP. The /search endpoint keeps its historical shape so orgs/products
  // keep rendering the way the web UI expects.
  const [orgs, rawProducts, rawSources] = await Promise.all([
    searchOrgs(db, pattern, limit),
    searchProducts(db, pattern, limit),
    searchSources(db, pattern, limit),
  ]);
  const products = foldSourcesIntoProducts(rawProducts, rawSources);

  // When mode==="lexical" we keep the legacy path bit-for-bit (including
  // the cascading enrichment from matched entities) to preserve the cache
  // key semantics for the existing web UI.
  if (mode === "lexical") {
    const ftsReleases = await searchReleasesFts(db, q, limit, offset).catch(
      () => [] as SearchReleaseHit[],
    );
    let releases = ftsReleases;
    if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
      releases = await searchReleasesFromMatchedEntities(
        db,
        orgs.map((o) => o.slug),
        products.filter((p) => p.kind !== "source").map((p) => p.slug),
        limit,
      );
    }
    const result = { query: q, orgs, products, sources: [], releases };
    if (wantsMarkdown(c)) return markdownResponse(c, searchToMarkdown(result));
    return c.json(result);
  }

  // Semantic / hybrid modes — run the shared helper and flatten release
  // hits into the legacy `releases` field so existing consumers keep
  // working. Chunk hits ride along on a new `chunks` field.
  const hybrid = await runHybridSearch(c.env, db, {
    query: q,
    topK: limit,
    mode,
  });

  const releases: SearchReleaseHit[] = hybrid.hits
    .filter((h): h is Extract<typeof h, { kind: "release" }> => h.kind === "release")
    .map((h) => ({
      id: h.release.id,
      sourceSlug: h.release.source.slug,
      sourceName: h.release.source.name,
      orgSlug: h.release.orgSlug,
      version: h.release.version,
      title: h.release.title,
      summary: h.release.summary,
      publishedAt: h.release.publishedAt,
      // Emit the fusion score so clients can re-interleave release and
      // chunk hits into a single ranked list (they're split into two
      // arrays on the wire for back-compat with the legacy shape).
      score: h.score,
    }));

  const chunks = hybrid.hits
    .filter((h): h is Extract<typeof h, { kind: "changelog_chunk" }> => h.kind === "changelog_chunk")
    .map((h) => ({
      sourceSlug: h.chunk.source.slug,
      sourceName: h.chunk.source.name,
      orgSlug: h.chunk.orgSlug,
      filePath: h.chunk.file_path,
      offset: h.chunk.offset,
      length: h.chunk.length,
      heading: h.chunk.heading,
      snippet: h.chunk.snippet,
      score: h.score,
    }));

  const result = {
    query: q,
    orgs,
    products,
    sources: [],
    releases,
    chunks,
    mode: hybrid.mode,
    degraded: hybrid.degraded,
    ...(hybrid.degradedReason ? { degradedReason: hybrid.degradedReason } : {}),
  };

  if (wantsMarkdown(c)) {
    return markdownResponse(c, searchToMarkdown(result));
  }

  return c.json(result);
});

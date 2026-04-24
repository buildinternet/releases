import { Hono } from "hono";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { searchToMarkdown } from "@releases/rendering/formatters.js";
import { foldSourcesIntoCatalog } from "@releases/api-types";
import type { Env } from "../index.js";
import type { SearchReleaseHit, MediaItem } from "@releases/api-types";
import { createDb } from "../db.js";
import {
  searchOrgs,
  searchProducts,
  searchSources,
  searchReleasesFts,
  searchReleasesFromMatchedEntities,
  type RawSearchReleaseRow,
} from "../queries/search.js";
import { runHybridSearch, type HybridMode } from "../lib/search-hybrid.js";
import { hydrateMediaUrls, resolveR2Url, parseBoolParam } from "../utils.js";

/**
 * Lift a raw SQL row to the wire shape. JSON-parses media, rewrites any
 * media URLs inside the markdown body through MEDIA_ORIGIN, and resolves
 * r2Url for each media item — so the web can render release hits with the
 * same markdown + thumbnail treatment used in org/source feeds.
 */
function hydrateReleaseHit(
  row: RawSearchReleaseRow,
  mediaOrigin: string,
  score?: number,
): SearchReleaseHit {
  // DB rows carry r2Key alongside MediaItem fields; resolve to r2Url
  // (a signed MEDIA_ORIGIN URL) so the web never sees raw R2 keys.
  type RawMediaRow = MediaItem & { r2Key?: string | null };
  let media: MediaItem[] = [];
  try {
    const parsed = JSON.parse(row.media ?? "[]");
    if (Array.isArray(parsed)) {
      media = parsed.map((m: RawMediaRow) =>
        Object.assign(m, { r2Url: resolveR2Url(m.r2Key, mediaOrigin) }),
      );
    }
  } catch {
    // Keep media empty — a malformed row shouldn't break the whole response.
  }
  return {
    id: row.id,
    sourceSlug: row.sourceSlug,
    sourceName: row.sourceName,
    sourceType: row.sourceType,
    orgSlug: row.orgSlug,
    orgName: row.orgName,
    version: row.version,
    title: row.title,
    summary: row.summary,
    content: hydrateMediaUrls(row.content, mediaOrigin),
    media,
    publishedAt: row.publishedAt,
    ...(score !== undefined ? { score } : {}),
  };
}

export const searchRoutes = new Hono<Env>();

function parseMode(raw: string | undefined): HybridMode {
  if (raw === "lexical" || raw === "semantic" || raw === "hybrid") return raw;
  return "hybrid";
}

searchRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.json({ error: "bad_request", message: "Missing required query parameter: q" }, 400);
  }

  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const mode = parseMode(c.req.query("mode"));
  const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
  const db = createDb(c.env.DB);
  const pattern = `%${q}%`;
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";

  // Entity lookups stay lexical — semantic lives behind /search_registry on
  // MCP. The /search endpoint keeps its historical shape so orgs/products
  // keep rendering the way the web UI expects.
  const [orgs, rawProducts, rawSources] = await Promise.all([
    searchOrgs(db, pattern, limit),
    searchProducts(db, pattern, limit),
    searchSources(db, pattern, limit),
  ]);
  const catalog = foldSourcesIntoCatalog(rawProducts, rawSources);

  // When mode==="lexical" we keep the legacy path bit-for-bit (including
  // the cascading enrichment from matched entities) to preserve the cache
  // key semantics for the existing web UI.
  if (mode === "lexical") {
    const ftsRows = await searchReleasesFts(db, q, limit, offset, { includeCoverage }).catch(
      () => [] as RawSearchReleaseRow[],
    );
    let rawReleases = ftsRows;
    if (rawReleases.length === 0 && (orgs.length > 0 || catalog.length > 0)) {
      rawReleases = await searchReleasesFromMatchedEntities(
        db,
        orgs.map((o) => o.slug),
        catalog.filter((p) => p.kind !== "source").map((p) => p.slug),
        limit,
        { includeCoverage },
      );
    }
    const releases = rawReleases.map((row) => hydrateReleaseHit(row, mediaOrigin));
    const result = { query: q, orgs, catalog, products: catalog, sources: [], releases };
    if (wantsMarkdown(c)) return markdownResponse(c, searchToMarkdown(result));
    return c.json(result);
  }

  // Semantic / hybrid modes — run the shared helper and flatten release
  // hits into the legacy `releases` field so existing consumers keep
  // working. Chunk hits ride along on a new `chunks` field.
  const hybrid = await runHybridSearch(
    c.env,
    db,
    {
      query: q,
      topK: limit,
      mode,
      includeCoverage,
    },
    { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) },
  );

  const releases: SearchReleaseHit[] = hybrid.hits
    .filter((h): h is Extract<typeof h, { kind: "release" }> => h.kind === "release")
    .map((h) =>
      hydrateReleaseHit(
        {
          id: h.release.id,
          sourceSlug: h.release.source.slug,
          sourceName: h.release.source.name,
          sourceType: h.release.source.type,
          orgSlug: h.release.orgSlug,
          orgName: h.release.orgName,
          version: h.release.version,
          title: h.release.title,
          summary: h.release.summary,
          content: h.release.content,
          media: h.release.media,
          publishedAt: h.release.publishedAt,
        },
        mediaOrigin,
        // Emit the fusion score so clients can re-interleave release and
        // chunk hits into a single ranked list (they're split into two
        // arrays on the wire for back-compat with the legacy shape).
        h.score,
      ),
    );

  const chunks = hybrid.hits
    .filter(
      (h): h is Extract<typeof h, { kind: "changelog_chunk" }> => h.kind === "changelog_chunk",
    )
    .map((h) => ({
      sourceSlug: h.chunk.source.slug,
      sourceName: h.chunk.source.name,
      orgSlug: h.chunk.orgSlug,
      orgName: h.chunk.orgName,
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
    catalog,
    products: catalog,
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

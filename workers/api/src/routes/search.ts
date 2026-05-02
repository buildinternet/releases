import { Hono } from "hono";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { searchToMarkdown } from "@releases/rendering/formatters.js";
import { foldSourcesIntoCatalog } from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import type {
  SearchReleaseHit,
  MediaItem,
  LookupResultPayload,
} from "@buildinternet/releases-api-types";
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
import { logSearch } from "../lib/log-search.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { hydrateMediaUrls, resolveR2Url, parseBoolParam } from "../utils.js";
import type { SearchSurface } from "@buildinternet/releases-core/schema";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { runLookup } from "./lookups.js";
import { embedSourceSideEffect } from "./sources.js";

/**
 * Bucket the User-Agent into a known client kind, or `null` when we have no
 * explicit signal. We only emit a value when the UA matches one of our own
 * clients — raw curl / unknown UAs land as `null` and the column falls back
 * to its schema default at write time. The status UI hides the pill for
 * default rows so "no signal" reads as absence, not a labelled bucket.
 *
 * Derivation is UA-only on purpose: `surface` comes from the spoofable
 * `X-Releases-Surface` header, so trusting it here would let any caller
 * claim `web-server`. The web frontend already sends `releases-web/<ver>`
 * as its UA, so it lands in `web-server` through the UA prefix.
 */
function deriveClientKind(userAgent: string | null): string | null {
  const ua = userAgent ?? "";
  if (ua.startsWith("releases-cli/")) return "cli";
  if (ua.startsWith("releases-web/")) return "web-server";
  return null;
}

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

/**
 * Project the internal LookupResponse (full Drizzle row shape) down to the
 * slim wire type so `UnifiedSearchResponse` type-checks cleanly.
 */
function toLookupPayload(
  lookup: Awaited<ReturnType<typeof runLookup>> | null,
): LookupResultPayload | null {
  if (!lookup) return null;
  return {
    status: lookup.status,
    source: lookup.source
      ? {
          id: lookup.source.id,
          slug: lookup.source.slug,
          name: lookup.source.name,
          url: lookup.source.url,
          discovery: lookup.source.discovery ?? "curated",
        }
      : undefined,
    releases: lookup.releases?.map((r) => ({
      id: r.id,
      version: r.version ?? null,
      title: r.title,
      publishedAt: r.publishedAt ?? null,
    })),
    relatedOrg: lookup.relatedOrg,
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

  const startedAt = Date.now();
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const mode = parseMode(c.req.query("mode"));
  const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
  const db = createDb(c.env.DB);
  const pattern = `%${q}%`;
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";

  // The web frontend sets `X-Releases-Surface: web` so we can attribute hits
  // through the API to the public site rather than to direct API consumers.
  const surface: SearchSurface = c.req.header("x-releases-surface") === "web" ? "web" : "api";
  const userAgent = c.req.header("user-agent") ?? null;
  const anonId = c.req.header("x-releases-anon-id") ?? null;
  const clientKind = deriveClientKind(userAgent);
  // Resolve auth synchronously here so the `waitUntil(logSearch(...))` calls
  // below capture it without re-reading the secret per branch.
  const authed = await isValidBearerAuth(c);

  // Parse once — reused by both the lexical and hybrid branches below.
  const coordinate = parseCoordinate(q);

  // Trigger embedding as a side effect when a new source was just indexed.
  // The try/catch guards against test environments that have no ExecutionContext.
  function maybeEmbed(lookup: Awaited<ReturnType<typeof runLookup>> | null): void {
    if (lookup?.status === "indexed" && lookup.source) {
      try {
        c.executionCtx.waitUntil(embedSourceSideEffect(c.env, db, lookup.source.id));
      } catch {
        // No ExecutionContext in test environments — embedding is best-effort.
      }
    }
  }

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

    // On-demand GitHub lookup: a coordinate-shaped query is a precise
    // question about one repo, so only entity matches (org / catalog
    // source) suppress it. Tangential FTS hits on a single segment token
    // (e.g. "shopify" in another org's release body) don't.
    let lookup: Awaited<ReturnType<typeof runLookup>> | null = null;
    if (coordinate && orgs.length === 0 && catalog.length === 0) {
      lookup = await runLookup(c.env, db, coordinate);
      maybeEmbed(lookup);
    }

    const result = {
      query: q,
      orgs,
      catalog,
      products: catalog,
      sources: [],
      releases,
      lookup: toLookupPayload(lookup),
    };
    c.executionCtx.waitUntil(
      logSearch(c.env, {
        surface,
        clientKind,
        authed,
        query: q,
        mode: "lexical",
        orgHits: orgs.length,
        catalogHits: catalog.length,
        releaseHits: releases.length,
        durationMs: Date.now() - startedAt,
        anonId,
        userAgent,
      }),
    );
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

  // On-demand GitHub lookup: same gate as the lexical branch — entity
  // matches suppress it, release/chunk hits don't.
  let lookup: Awaited<ReturnType<typeof runLookup>> | null = null;
  if (coordinate && orgs.length === 0 && catalog.length === 0) {
    lookup = await runLookup(c.env, db, coordinate);
    maybeEmbed(lookup);
  }

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
    lookup: toLookupPayload(lookup),
  };

  c.executionCtx.waitUntil(
    logSearch(c.env, {
      surface,
      clientKind,
      authed,
      query: q,
      mode: hybrid.mode,
      orgHits: orgs.length,
      catalogHits: catalog.length,
      releaseHits: releases.length,
      chunkHits: chunks.length,
      degraded: hybrid.degraded === true,
      durationMs: Date.now() - startedAt,
      anonId,
      userAgent,
    }),
  );

  if (wantsMarkdown(c)) {
    return markdownResponse(c, searchToMarkdown(result));
  }

  return c.json(result);
});

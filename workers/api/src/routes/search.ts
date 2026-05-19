import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { searchToMarkdown } from "@releases/rendering/formatters.js";
import {
  foldSourcesIntoCatalog,
  mergeCollectionHits,
  UnifiedSearchResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import type {
  SearchReleaseHit,
  MediaItem,
  LookupResultPayload,
} from "@buildinternet/releases-api-types";
import { createDb } from "../db.js";
import {
  findOrgByDomain,
  searchOrgs,
  searchProducts,
  searchSources,
  searchReleasesFts,
  searchReleasesFromMatchedEntities,
  searchCollectionsDirect,
  findCollectionsByMemberOrgs,
  type RawSearchReleaseRow,
} from "../queries/search.js";
import { runHybridSearch, runCollectionsSemantic, type HybridMode } from "../lib/search-hybrid.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";
import type { SearchCollectionHit } from "@buildinternet/releases-api-types";
import { logSearch } from "../lib/log-search.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { hydrateMediaUrls, resolveR2Url, parseBoolParam, parseLimitParam } from "../utils.js";
import {
  organizationsActive,
  sources,
  type SearchSurface,
} from "@buildinternet/releases-core/schema";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { normalizeDomain } from "@buildinternet/releases-core/domain";
import { eq } from "drizzle-orm";
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
    titleGenerated: row.titleGenerated,
    titleShort: row.titleShort,
    content: hydrateMediaUrls(row.content, mediaOrigin),
    media,
    publishedAt: row.publishedAt,
    type: row.type,
    coverageCount: row.coverageCount,
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

/**
 * Resolve a `?domain=` filter to the org id we should narrow on. Product-only
 * aliases fall back to `miss` — narrowing by them would require a
 * sourceId-list filter, which isn't a documented use case yet.
 */
async function resolveDomainScope(
  db: ReturnType<typeof createDb>,
  raw: string,
): Promise<
  | { kind: "invalid" }
  | { kind: "miss"; domain: string }
  | { kind: "hit"; orgId: string; domain: string }
> {
  const domain = normalizeDomain(raw);
  if (!domain) return { kind: "invalid" };
  const org = await findOrgByDomain(db, domain);
  if (org) return { kind: "hit", orgId: org.id, domain };
  return { kind: "miss", domain };
}

searchRoutes.get(
  "/search",
  describeRoute({
    tags: ["Search"],
    summary: "Unified search across orgs, catalog, collections, releases, and chunks",
    description:
      'Returns orgs, catalog entries (products + standalone sources folded together), curated collections, release hits, and — on hybrid/semantic modes — CHANGELOG.md chunk hits in a single response.\n\n`mode` selects the release-retrieval strategy: `lexical` (FTS5), `semantic` (vector-only), or `hybrid` (RRF fusion of FTS5 + vector; default). The handler echoes back the mode actually used, including `degraded: true` when a hybrid request fell back to lexical because Vectorize is unavailable.\n\n`?domain=` narrows the entire result set to one org (matched against `organizations.domain` and `domain_aliases.domain`). Invalid hostnames return 400; unknown hostnames return an empty envelope with `domainStatus: "not_found"` (distinct from "matched but no hits").\n\nWhen the query parses as a GitHub coordinate (`org/repo` or `github:org/repo`) and no orgs/catalog matched, the handler runs an on-demand lookup and embeds the result on `lookup`. Coordinate-shaped queries are not suppressed by tangential release/chunk hits.\n\nCollections surface via two paths: a direct match on the collection\'s name/description (lexical in every mode, plus a vector match in hybrid/semantic mode) and a member rollup that includes every collection containing one of the matched orgs. Each row carries a `via` discriminator (`"direct"` vs `"member"`); `matchedOrgSlugs` on member rows names the result-set orgs that triggered the rollup so a UI can render an "includes X" hint.\n\nContent negotiation: `Accept: text/markdown` returns a Markdown-rendered version of the same payload.',
    parameters: [
      {
        name: "q",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Search query. Required.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, default: 20 },
        description:
          "Per-section result cap. Each of orgs/catalog/releases respects this independently.",
      },
      {
        name: "offset",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0, default: 0 },
        description: "Release-list offset (lexical mode only).",
      },
      {
        name: "mode",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["lexical", "semantic", "hybrid"], default: "hybrid" },
        description: "Release-retrieval strategy.",
      },
      {
        name: "domain",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Narrow results to the org owning this domain.",
      },
      {
        name: "include_coverage",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description: "Include coverage-side rows that normally roll up into a canonical release.",
      },
    ],
    responses: {
      200: {
        description:
          "Unified search response. JSON by default; Markdown when `Accept: text/markdown` is sent.",
        content: {
          "application/json": { schema: resolver(UnifiedSearchResponseSchema) },
          "text/markdown": { schema: { type: "string" } },
        },
      },
      400: {
        description: "Missing `q` or invalid `domain` hostname",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const q = c.req.query("q") ?? "";
    if (!q) {
      return c.json({ error: "bad_request", message: "Missing required query parameter: q" }, 400);
    }

    const startedAt = Date.now();
    // Clamp limit to [1, 100] (matches the OpenAPI schema bounds); fall back
    // to 20 on NaN / non-positive input rather than letting it flow into SQL.
    const limit = parseLimitParam(c.req.query("limit"), 20, 100);
    // Same defense for offset: parseInt("abc") returns NaN, which would land
    // in `OFFSET NaN` and silently return zero rows.
    const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const mode = parseMode(c.req.query("mode"));
    const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
    const rawDomain = c.req.query("domain");
    const db = createDb(c.env.DB);
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

    // Optional `?domain=` narrows the result set to a single org. We resolve
    // up front and short-circuit on invalid/miss so we don't waste a
    // round-trip running a full search whose results would all be filtered
    // away. `domainResolution` is also surfaced on the response so callers
    // can distinguish "domain isn't owned" from "domain is owned but the
    // query had no hits."
    const domainResolution = rawDomain ? await resolveDomainScope(db, rawDomain) : null;
    if (domainResolution?.kind === "invalid") {
      return c.json(
        {
          error: "bad_request",
          message: "domain query param must be a valid hostname",
        },
        400,
      );
    }
    const scopeOrgId = domainResolution?.kind === "hit" ? domainResolution.orgId : undefined;
    const domainMissed = domainResolution?.kind === "miss";

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

    // Domain miss → empty result envelope. Skip the SQL entirely and skip
    // the on-demand GitHub lookup (which is a separate primitive — domain
    // misses don't probe).
    if (domainMissed) {
      const result = {
        query: q,
        domain: domainResolution.domain,
        domainStatus: "not_found" as const,
        orgs: [],
        catalog: [],
        sources: [],
        releases: [],
        collections: [],
        ...(mode !== "lexical" ? { chunks: [], mode, degraded: false } : {}),
        lookup: null,
      };
      c.executionCtx.waitUntil(
        logSearch(c.env, {
          surface,
          clientKind,
          authed,
          query: q,
          mode: mode === "lexical" ? "lexical" : mode,
          orgHits: 0,
          catalogHits: 0,
          releaseHits: 0,
          chunkHits: 0,
          collectionHits: 0,
          durationMs: Date.now() - startedAt,
          anonId,
          userAgent,
        }),
      );
      if (wantsMarkdown(c)) return markdownResponse(c, searchToMarkdown(result));
      return c.json(result);
    }

    // Entity lookups stay lexical — the /search endpoint keeps its historical
    // shape so orgs/products keep rendering the way the web UI expects.
    //
    // When narrowing by domain, the resolved org is surfaced unconditionally
    // as the (only) org hit — the caller has named an entity, so confirming
    // it is more useful than re-running the LIKE on the org name. Catalog
    // and releases still respect the query within the scoped org.
    const [scopedOrgRow] = scopeOrgId
      ? await db
          .select({
            slug: organizationsActive.slug,
            name: organizationsActive.name,
            domain: organizationsActive.domain,
            category: organizationsActive.category,
          })
          .from(organizationsActive)
          .where(eq(organizationsActive.id, scopeOrgId))
          .limit(1)
      : [];

    const [orgs, rawProducts, rawSources, collectionsDirectLexical] = await Promise.all([
      scopedOrgRow
        ? Promise.resolve([
            {
              slug: scopedOrgRow.slug,
              name: scopedOrgRow.name,
              domain: scopedOrgRow.domain,
              avatarUrl: null,
              category: scopedOrgRow.category,
            },
          ])
        : searchOrgs(db, q, limit, { orgId: scopeOrgId }),
      searchProducts(db, q, limit, { orgId: scopeOrgId }),
      searchSources(db, q, limit, { orgId: scopeOrgId }),
      // Direct LIKE match on collection name/slug/description — runs in
      // every mode. Independent of `?domain=`: collections are cross-org
      // by design, so a domain-scoped query still surfaces a relevant
      // collection (e.g. searching within Vercel can return the "Frontier
      // AI Labs" collection if Vercel is a member).
      searchCollectionsDirect(db, q, limit),
    ]);
    const catalog = foldSourcesIntoCatalog(rawProducts, rawSources);

    const collectionsMember = await findCollectionsByMemberOrgs(
      db,
      orgs.map((o) => o.slug),
      limit,
    );

    // Pre-compute the source-id list when narrowing — needed for the hybrid
    // path's `orgSourceIds` filter.
    let scopeSourceIds: string[] | undefined;
    if (scopeOrgId) {
      const rows = await db
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.orgId, scopeOrgId));
      scopeSourceIds = rows.map((r) => r.id);
    }

    // When mode==="lexical" we keep the legacy path bit-for-bit (including
    // the cascading enrichment from matched entities) to preserve the cache
    // key semantics for the existing web UI.
    if (mode === "lexical") {
      const ftsRows = await searchReleasesFts(db, q, limit, offset, {
        includeCoverage,
        orgId: scopeOrgId,
      }).catch(() => [] as RawSearchReleaseRow[]);
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
      // (e.g. "shopify" in another org's release body) don't. Skip when
      // narrowing by domain — the caller has already specified an entity.
      let lookup: Awaited<ReturnType<typeof runLookup>> | null = null;
      if (coordinate && !scopeOrgId && orgs.length === 0 && catalog.length === 0) {
        lookup = await runLookup(c.env, db, coordinate);
        maybeEmbed(lookup);
      }

      const collectionsHits = mergeCollectionHits(
        collectionsDirectLexical,
        [],
        collectionsMember,
        limit,
      );
      const result = {
        query: q,
        ...(domainResolution
          ? { domain: domainResolution.domain, domainStatus: "matched" as const }
          : {}),
        orgs,
        catalog,
        sources: [],
        releases,
        collections: collectionsHits,
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
          collectionHits: collectionsHits.length,
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
    // working. Chunk hits ride along on a new `chunks` field. Collection
    // semantic search runs in parallel; degrades the same way as the
    // release path (returns empty + reason) so a missing binding never
    // 500s the whole response. Embed config is resolved once and shared so
    // both helpers don't independently read the Secrets Store binding.
    const embedConfig = await buildEmbedConfig(c.env);
    const sharedOpts = {
      waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
      embedConfig,
    };
    const [hybrid, collectionsSemantic] = await Promise.all([
      runHybridSearch(
        c.env,
        db,
        {
          query: q,
          topK: limit,
          mode,
          includeCoverage,
          // Domain narrowing reaches into the hybrid layer via the existing
          // `orgSourceIds` filter so vector + FTS results both stay scoped.
          ...(scopeSourceIds && scopeSourceIds.length > 0 ? { orgSourceIds: scopeSourceIds } : {}),
        },
        sharedOpts,
      ),
      runCollectionsSemantic(c.env, db, { query: q, limit }, sharedOpts),
    ]);

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
            titleGenerated: h.release.titleGenerated,
            titleShort: h.release.titleShort,
            content: h.release.content,
            media: h.release.media,
            publishedAt: h.release.publishedAt,
            type: h.release.type,
            coverageCount: h.release.coverageCount,
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
    // matches suppress it, release/chunk hits don't. Domain narrowing also
    // suppresses (the caller has already named an entity).
    let lookup: Awaited<ReturnType<typeof runLookup>> | null = null;
    if (coordinate && !scopeOrgId && orgs.length === 0 && catalog.length === 0) {
      lookup = await runLookup(c.env, db, coordinate);
      maybeEmbed(lookup);
    }

    const collectionsSemanticHits: SearchCollectionHit[] = collectionsSemantic.hits.map((h) => ({
      slug: h.slug,
      name: h.name,
      description: h.description,
      memberCount: h.memberCount,
      via: "direct" as const,
      score: h.score,
    }));
    const collectionsHits = mergeCollectionHits(
      collectionsDirectLexical,
      collectionsSemanticHits,
      collectionsMember,
      limit,
    );

    const result = {
      query: q,
      ...(domainResolution
        ? { domain: domainResolution.domain, domainStatus: "matched" as const }
        : {}),
      orgs,
      catalog,
      sources: [],
      releases,
      collections: collectionsHits,
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
        collectionHits: collectionsHits.length,
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
  },
);

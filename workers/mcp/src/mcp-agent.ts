import { logEvent } from "@releases/lib/log-event";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDb } from "./db.js";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { hydrateMediaUrls } from "@releases/rendering/media-url.js";
import {
  search,
  getLatestReleases,
  listOrganizations,
  getOrganization,
  getRelease,
  listCatalog,
  getCatalogEntry,
  lookupDomain,
  listCollections,
  getCollection,
  getCollectionReleases,
  summarizeChanges,
  compareProducts,
  type SearchToolReturn,
  type ToolResult,
} from "./tools.js";
import { registerResources, RELEASE_FEED_UI_URI } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { logMcpSearch, deriveMcpClientKind, type McpSearchCommand } from "./lib/log-search.js";
import { buildSearchMeta } from "./lib/pagination.js";
import type { SearchMode } from "@buildinternet/releases-core/schema";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import type { LookupResultPayload } from "@buildinternet/releases-api-types";
import { getSecret } from "@releases/lib/secrets";

/**
 * Render the lookup payload as a markdown rail appended to the tool's text
 * response. Each branch tells the caller what just happened so the LLM can
 * surface "I just indexed X for you" without a second tool call.
 */
function renderLookupRail(lookup: LookupResultPayload): string {
  const lines: string[] = ["", "---", "", "## On-demand lookup"];
  switch (lookup.status) {
    case "indexed":
      lines.push(
        `Just indexed \`${lookup.source?.url ?? lookup.source?.slug ?? "(unknown)"}\` — ${
          lookup.releases?.length ?? 0
        } release(s) ingested. Re-run the search to retrieve the new content.`,
      );
      break;
    case "existing":
      lines.push(
        `Found existing source \`${lookup.source?.slug ?? "(unknown)"}\` for this coordinate.`,
      );
      break;
    case "empty":
      lines.push(
        `Repo \`${lookup.source?.url ?? "(unknown)"}\` exists but has no releases or CHANGELOG yet.`,
      );
      break;
    case "not_found":
      lines.push("Repo not found on GitHub.");
      break;
    case "deferred":
      lines.push("Lookup deferred — GitHub returned a transient error. Try again shortly.");
      break;
  }
  if (lookup.relatedOrg) {
    lines.push("", `Did you mean from **${lookup.relatedOrg.org.name}**?`);
    for (const s of lookup.relatedOrg.sources.slice(0, 5)) {
      lines.push(`- \`${s.slug}\` — ${s.name}`);
    }
  }
  return lines.join("\n");
}

type SecretBinding = { get(): Promise<string> };

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: SecretBinding;
  /** Optional Cloudflare AI Gateway passthrough — see docs/architecture/ai-gateway.md. */
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: SecretBinding;
  ENABLE_AI_TOOLS?: string;
  MEDIA_ORIGIN?: string;
  // Vectorize indexes for semantic search (read-only usage from MCP).
  RELEASES_INDEX: VectorizeIndex;
  ENTITIES_INDEX: VectorizeIndex;
  CHANGELOG_CHUNKS_INDEX: VectorizeIndex;
  // Embedding provider config (see packages/search/src/embeddings.ts).
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: SecretBinding;
  OPENAI_API_KEY?: SecretBinding;
  /** Optional KV namespace caching single-query embeddings. */
  EMBED_CACHE?: KVNamespace;
  /** Staging-only: disables indexing (X-Robots-Tag + deny-all /robots.txt). */
  INDEXING_DISABLED?: string;
  /** When "true", search-tool calls skip writing to `search_queries`. */
  SEARCH_QUERY_LOG_DISABLED?: string;
  /** Service binding to the API worker — used for on-demand /v1/lookups calls. */
  API?: Fetcher;
  /**
   * Bearer token presented to the API worker on the lookup-fallback path
   * (`maybeLookup`). The /v1/lookups route is admin-gated, so without this
   * the fallback returns 401. Bound from Secrets Store in both prod + staging.
   */
  RELEASED_API_KEY?: SecretBinding;
  /**
   * Staging-only shared secret. When bound, every request must carry a
   * matching `X-Releases-Staging-Key` header. See workers/mcp/src/index.ts.
   */
  STAGING_ACCESS_KEY?: SecretBinding;
}

/**
 * Shared tool annotation hints. Every tool this server exposes is read-only
 * against the registry DB — none mutate state. The AI-backed tools flip
 * `idempotentHint` off because LLM output varies across identical calls.
 * `openWorldHint: false` reflects that all data comes from our own registry;
 * tools don't reach out to arbitrary external systems at call time.
 */
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const AI_READ_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * `title` appears twice in a tool registration — once as the top-level
 * display name (MCP 2025-11-25 spec) and once inside `annotations.title`
 * (older field older clients still read). Build both from a single string
 * so they can't drift.
 */
function titled(title: string, hints: typeof READ_ONLY_HINTS | typeof AI_READ_HINTS) {
  return { title, annotations: { title, ...hints } };
}

/**
 * Build an `_meta` object that points at an MCP App UI resource. Sets both
 * `_meta.ui.resourceUri` (current spec) AND the legacy flat `_meta["ui/resourceUri"]`
 * key — `@modelcontextprotocol/ext-apps`'s `registerAppTool` does this same
 * normalization. MCP Inspector (and some hosts) check for the legacy key when
 * deciding which tools count as MCP Apps, so emitting both keeps the surface
 * compatible across host versions.
 */
function uiMeta(resourceUri: string) {
  return {
    ui: { resourceUri },
    "ui/resourceUri": resourceUri,
  } as const;
}

// Shared `page` / `limit` zod fields for the four list_* tools. Defaults
// (page=1, limit=50, max=200) match `parseMcpPagination` in
// workers/mcp/src/lib/pagination.ts.
const paginationFields = {
  page: z.number().int().min(1).optional().describe("1-based page number. Defaults to 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Entries per page (1–200). Defaults to 50."),
};

function withPagination<T extends Record<string, z.ZodTypeAny>>(schema: T) {
  return { ...schema, ...paginationFields };
}

export interface CreateServerOptions {
  /**
   * Inbound request UA — passed through to `search_queries.user_agent` and
   * bucketed via `deriveMcpClientKind`. Optional; when omitted (older callers
   * and tests) rows land with a NULL UA and clientKind falls back to the
   * column's schema default.
   */
  userAgent?: string | null;
}

export function createServer(env: Env, ctx?: ExecutionContext, opts?: CreateServerOptions) {
  const server = new McpServer(
    {
      name: "releases",
      version: "0.15.0",
    },
    {
      // Explicit capability advertisement. Some hosts (including older MCP
      // Inspector builds) only attempt `resources/list` after they see
      // `resources` in the initialize-response capabilities; declaring them
      // up-front is cheaper than relying on the SDK's lazy-binding heuristic.
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  const db = createDb(env.DB);
  const mediaOrigin = env.MEDIA_ORIGIN ?? "";
  const requestUserAgent = opts?.userAgent ?? null;
  const requestClientKind = deriveMcpClientKind(requestUserAgent);

  /** Hydrate portable /_media/ URLs in tool text output. */
  function withMedia<T>(handler: (params: T) => Promise<ToolResult>) {
    return async (params: T): Promise<ToolResult> => {
      const result = await handler(params);
      if (mediaOrigin && result.content[0]?.text) {
        result.content[0].text = hydrateMediaUrls(result.content[0].text, mediaOrigin);
      }
      return result;
    };
  }

  /**
   * Wrap a search tool handler so the query text, timing, and per-section
   * hit counts land in `search_queries`. The handler returns the rendered
   * `ToolResult` plus a `counts` object; this wrapper logs the counts,
   * hydrates portable media URLs in the rendered text, and returns just
   * the `ToolResult` to satisfy the MCP SDK's tool signature. Logging is
   * fire-and-forget — never blocks the response, never propagates errors.
   */
  const defaultModeFor: Record<McpSearchCommand, SearchMode> = {
    search: "hybrid",
  };

  function withSearchLog<
    T extends {
      query: string;
      mode?: SearchMode;
      organization?: string;
      entity?: string;
      limit?: number;
    },
  >(
    command: McpSearchCommand,
    handler: (params: T) => Promise<SearchToolReturn>,
  ): (params: T) => Promise<ToolResult> {
    return async (params: T) => {
      const startedAt = Date.now();
      let counts: SearchToolReturn["counts"] = {};
      try {
        const out = await handler(params);
        counts = out.counts;
        if (mediaOrigin && out.result.content[0]?.text) {
          out.result.content[0].text = hydrateMediaUrls(out.result.content[0].text, mediaOrigin);
        }
        const { degraded, ...hitCounts } = counts;
        const searchMeta = buildSearchMeta({
          mode: params.mode ?? defaultModeFor[command],
          limit: params.limit ?? 20,
          counts: hitCounts,
          degraded,
        });
        out.result._meta = { ...out.result._meta, search: searchMeta };
        return out.result;
      } finally {
        const log = logMcpSearch(env, {
          command,
          query: params.query,
          mode: params.mode ?? null,
          types: [command],
          organization: params.organization ?? null,
          entity: params.entity ?? null,
          orgHits: counts.orgHits ?? null,
          catalogHits: counts.catalogHits ?? null,
          releaseHits: counts.releaseHits ?? null,
          chunkHits: counts.chunkHits ?? null,
          degraded: counts.degraded ?? null,
          durationMs: Date.now() - startedAt,
          clientKind: requestClientKind,
          userAgent: requestUserAgent,
        });
        if (ctx) ctx.waitUntil(log);
        else void log;
      }
    };
  }

  /**
   * Fire an on-demand lookup via the API service binding when the query looks
   * like a GitHub coordinate and the primary search returned nothing. Renders
   * the result into the tool's text response so MCP clients see it inline.
   * Silently degrades when the binding is absent (local dev / staging without API).
   */
  async function maybeLookup(out: SearchToolReturn, query: string): Promise<void> {
    if (!env.API) return;
    const coord = parseCoordinate(query);
    if (!coord) return;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      // /v1/lookups is admin-gated — present a Bearer for the API auth middleware.
      const apiKey = (await getSecret(env.RELEASED_API_KEY).catch(() => null)) ?? "";
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      // Service-binding requests still flow through the API worker's middleware
      // pipeline, which includes the staging access gate. Attach the staging
      // key when bound (no-op in prod/local where the binding is absent).
      const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
      if (stagingKey) headers["X-Releases-Staging-Key"] = stagingKey;
      const res = await env.API.fetch(
        new Request("https://internal/v1/lookups", {
          method: "POST",
          headers,
          body: JSON.stringify({
            provider: coord.provider,
            coordinate: `${coord.org}/${coord.repo}`,
          }),
        }),
      );
      if (!res.ok) {
        logEvent("error", {
          component: "mcp-lookup",
          event: "fallback-non-ok",
          httpStatus: res.status,
        });
        return;
      }
      const lookup = (await res.json()) as LookupResultPayload;
      const rail = renderLookupRail(lookup);
      const block = out.result.content[0];
      if (rail && block?.type === "text") {
        block.text = block.text ? `${block.text}\n\n${rail}` : rail;
      }
    } catch (err) {
      logEvent("error", { component: "mcp-lookup", event: "fallback-failed", err });
    }
  }

  // Lazily resolve the Anthropic client once per server instance
  let anthropicClient: ReturnType<typeof buildAnthropicClient> | undefined;
  async function getAnthropic(): Promise<ReturnType<typeof buildAnthropicClient>> {
    if (!anthropicClient) {
      const [apiKey, gatewayToken] = await Promise.all([
        getSecret(env.ANTHROPIC_API_KEY),
        getSecret(env.AI_GATEWAY_TOKEN).catch(() => ""),
      ]);
      anthropicClient = buildAnthropicClient({
        apiKey: apiKey ?? "",
        baseURL: env.ANTHROPIC_BASE_URL,
        gatewayToken: gatewayToken || undefined, // null and "" both falsy → undefined
      });
    }
    return anthropicClient;
  }

  server.registerTool(
    "search",
    {
      ...titled("Search", READ_ONLY_HINTS),
      description: [
        "Unified search across the registry and release content. Returns up to three sections — organizations, catalog entries (products + standalone sources folded into one list), and releases with CHANGELOG chunks interleaved by relevance.",
        "",
        "Use `type` to narrow the surfaces you want and skip the expensive paths. For example, pass `type: ['catalog']` to look up a known entity by name (fast, registry-only); pass `type: ['releases']` when you only care about release content and want to avoid entity lookups. Omit `type` to search all three.",
        "",
        "Use `entity` (product slug / prod_ id OR source slug / src_ id) to scope release results to one catalog entry. Product identifiers expand to every source under the product. Use `organization` to scope to a whole org. Release retrieval defaults to hybrid (FTS5 + semantic vectors fused via RRF); it silently degrades to lexical when vector infra is unavailable and flags the result.",
      ].join("\n"),
      inputSchema: {
        query: z.string().describe("Search query"),
        type: z
          .array(z.enum(["orgs", "catalog", "releases"]))
          .optional()
          .describe(
            "Which sections to return. Omit to return all three. Use to skip expensive paths — e.g. ['catalog'] for registry-only lookups, ['releases'] for pure release search.",
          ),
        organization: z
          .string()
          .optional()
          .describe(
            "Scope release results to sources belonging to this organization. Accepts an org_ id, slug, or registered domain.",
          ),
        domain: z
          .string()
          .optional()
          .describe(
            "Scope to the org owning this domain. Input is normalized (scheme/path/www stripped, lowercased), so `https://vercel.com/` and `vercel.com` both work. Falls back to a 'no match' message when the domain isn't owned by anything indexed. Use this instead of `organization` when you have a URL-shaped input.",
          ),
        entity: z
          .string()
          .optional()
          .describe(
            "Scope release results to one catalog entry. Accepts a prod_ id (expands to every source under the product), a src_ id, or an org-scoped coordinate in the form orgSlug/slug (e.g. 'vercel/nextjs'). Bare slugs without an org prefix are not accepted.",
          ),
        limit: z.number().optional().describe("Max results per section (default 20)"),
        mode: z
          .enum(["lexical", "semantic", "hybrid"])
          .optional()
          .describe(
            "Release-retrieval strategy. 'hybrid' (default) fuses FTS + vector results. 'lexical' is legacy FTS only. 'semantic' is vectors only. Falls back to lexical if vector infra is unavailable.",
          ),
        include_coverage: z
          .boolean()
          .optional()
          .describe(
            "Include releases grouped as coverage of another (e.g. marketing posts that re-announce a platform release). Defaults to false so each underlying launch appears once.",
          ),
      },
    },
    withSearchLog("search", async (params) => {
      const out = await search(db, params, env, ctx);
      const { counts } = out;
      // Gate on entity matches only — release/chunk hits on a single
      // segment token shouldn't suppress the lookup for the typed repo.
      const hasEntityHit = (counts.orgHits ?? 0) > 0 || (counts.catalogHits ?? 0) > 0;
      if (!hasEntityHit) await maybeLookup(out, params.query);
      return out;
    }),
  );

  server.registerTool(
    "get_latest_releases",
    {
      ...titled("Get latest releases", READ_ONLY_HINTS),
      description: [
        "Get the most recent releases, optionally filtered by product or organization. Excludes prereleases (canaries / alphas / betas / RCs) by default — pass `include_prereleases: true` to include them.",
        "",
        "Cursor-paginated: pass `limit` for slice size (default 10), `cursor` to continue from a prior call. The result's `_meta.pagination` carries `kind: 'cursor'`, `hasMore`, and `nextCursor` when more rows exist; the response text echoes `nextCursor` so an LLM caller can chain without parsing `_meta`. Cursors are stable under inserts — a release added between calls won't shift the slice.",
      ].join("\n"),
      // MCP App UI for hosts that support it (Claude Desktop). Pairs with the
      // tool's `structuredContent` payload; non-UI hosts ignore the field and
      // the model continues to read the rendered markdown in `content[0].text`.
      _meta: uiMeta(RELEASE_FEED_UI_URI),
      inputSchema: {
        product: z
          .string()
          .optional()
          .describe(
            "Filter to a specific source. Accepts a src_ id or an org-scoped coordinate in the form orgSlug/sourceSlug (e.g. 'vercel/next-js'). Bare slugs without an org prefix are not accepted.",
          ),
        organization: z
          .string()
          .optional()
          .describe(
            "Filter to sources belonging to this organization. Accepts an org_ id, slug, or registered domain.",
          ),
        type: z
          .enum(["feature", "rollup"])
          .optional()
          .describe(
            "Filter by release type: 'feature' for individual releases, 'rollup' for seasonal/quarterly catch-all posts. Omit to include both.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Slice size (1–200). Defaults to 10."),
        cursor: z
          .string()
          .optional()
          .describe(
            "Opaque continuation token from a prior call's `_meta.pagination.nextCursor`. Pass to fetch the next slice. Stale cursors are silently ignored — the call returns a fresh head of the feed.",
          ),
        include_coverage: z
          .boolean()
          .optional()
          .describe(
            "Include releases grouped as coverage of another (e.g. marketing posts that re-announce a platform release). Defaults to false so each underlying launch appears once.",
          ),
        include_prereleases: z
          .boolean()
          .optional()
          .describe(
            "Include prerelease tags (alphas, betas, RCs, canaries). Defaults to false so the feed matches the public web view.",
          ),
      },
    },
    withMedia(async (params) => getLatestReleases(db, params)),
  );

  server.registerTool(
    "list_catalog",
    {
      ...titled("List catalog", READ_ONLY_HINTS),
      description: [
        "List catalog entries — products and standalone sources combined into one list with a `kind: 'product' | 'source'` discriminator per row.",
        "",
        "Orgs that group multiple sources under a product (e.g. Vercel → Next.js, Turborepo) surface those products; orgs with a single source that isn't part of a product surface it directly as a `kind: 'source'` entry. Either shape is a reasonable thing to pass to `search(entity: ...)`.",
        "",
        "Paginated: defaults to 50 entries per page. Pass `page: 2` for the next slice. The footer surfaces the total when more pages exist.",
      ].join("\n"),
      inputSchema: withPagination({
        organization: z
          .string()
          .optional()
          .describe("Organization to scope to. Accepts an org_ id, slug, domain, or name."),
      }),
    },
    async (params) => listCatalog(db, params),
  );

  server.registerTool(
    "get_catalog_entry",
    {
      ...titled("Get catalog entry", READ_ONLY_HINTS),
      description:
        "Detail for a single catalog entry — accepts a prod_ id, src_ id, or an org-scoped coordinate in the form orgSlug/slug (e.g. 'vercel/nextjs' or 'vercel/next-js'). Returns the union of product / source detail fields depending on the entry kind. Source entries list tracked CHANGELOG files by path and byte size. Pass `include_changelog: true` to inline the root CHANGELOG, or `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens` to embed a specific file or slice — heading-aligned, supports per-package files in monorepos (e.g. `packages/next/CHANGELOG.md`), and emits `totalTokens` / `sliceTokens` for LLM context budgeting. Files over 1MB are flagged as truncated so you know the tail is missing.",
      inputSchema: {
        identifier: z
          .string()
          .describe(
            "Catalog entry identifier: prod_ id, src_ id, or org-scoped coordinate orgSlug/slug (e.g. 'vercel/nextjs'). Bare slugs without an org prefix are not accepted.",
          ),
        include_changelog: z
          .boolean()
          .optional()
          .describe(
            "When true, inline the root tracked CHANGELOG for a source-kind entry. Ignored for products.",
          ),
        changelog_path: z
          .string()
          .optional()
          .describe(
            "Specific CHANGELOG path for a source-kind entry (e.g. 'packages/next/CHANGELOG.md'). Passing this implies include_changelog.",
          ),
        changelog_offset: z
          .number()
          .optional()
          .describe(
            "Character offset into the selected CHANGELOG. Snapped forward to the next heading unless 0. Passing this implies include_changelog.",
          ),
        changelog_limit: z
          .number()
          .optional()
          .describe(
            "Target slice size in characters. Slice ends at a heading boundary. Defaults to 40000 when slicing without a token budget. Passing this implies include_changelog.",
          ),
        changelog_tokens: z
          .number()
          .optional()
          .describe(
            "Target slice size in tokens (cl100k_base). Takes precedence over changelog_limit. Recommended brackets: 2000, 5000, 10000, 20000. Passing this implies include_changelog.",
          ),
      },
    },
    withMedia(async (params) => getCatalogEntry(db, params)),
  );

  server.registerTool(
    "list_organizations",
    {
      ...titled("List organizations", READ_ONLY_HINTS),
      description:
        "List all indexed organizations, optionally filtered. Paginated: defaults to 50 entries per page; pass `page: 2` for the next slice.",
      inputSchema: withPagination({
        query: z
          .string()
          .optional()
          .describe("Search across org name, slug, domain, and account handles"),
        platform: z.string().optional().describe("Filter to orgs with an account on this platform"),
      }),
    },
    async (params) => listOrganizations(db, params),
  );

  server.registerTool(
    "get_organization",
    {
      ...titled("Get organization", READ_ONLY_HINTS),
      description:
        "Get detailed information about a single organization — accounts, tags, sources, products, aliases. When an AI-generated overview exists the response includes a short preview; pass `include_overview: true` to inline the full briefing (with a stale warning if it's older than 30 days).",
      inputSchema: {
        identifier: z
          .string()
          .describe(
            "Organization identifier. Accepts an org_ id, slug, domain, name, or account handle.",
          ),
        include_overview: z
          .boolean()
          .optional()
          .describe(
            "When true, inline the full AI-generated overview instead of the default first-paragraph preview.",
          ),
      },
    },
    withMedia(async (params) => getOrganization(db, params)),
  );

  server.registerTool(
    "lookup_domain",
    {
      ...titled("Lookup by domain", READ_ONLY_HINTS),
      description: [
        "Resolve a domain to the org or product that owns it. The domain is normalized first (scheme, `www.`, path, and trailing slash stripped, lowercased), so `https://vercel.com/about` and `vercel.com` both look up the same row.",
        "",
        "Returns the matching org (with primary-vs-alias distinction) and any products whose alias targets the same domain. Pure resolution — does not probe the domain or materialize anything; unknown domains surface a 'no match' message. Use `lookup_domain` when you have a URL-shaped input; use `get_organization` when you already have a slug or id.",
      ].join("\n"),
      inputSchema: {
        domain: z
          .string()
          .describe(
            "Domain to resolve. Any URL-shaped form is accepted; the server normalizes it.",
          ),
      },
    },
    async (params) => lookupDomain(db, params),
  );

  server.registerTool(
    "list_collections",
    {
      ...titled("List collections", READ_ONLY_HINTS),
      description: [
        "List curated collections — named cross-org playlists (e.g. 'Frontier AI Labs') independent of the fixed category taxonomy.",
        "",
        "Use `get_collection` for a collection's full member list, or `get_collection_releases` for the interleaved cross-org release feed. Paginated: defaults to 50 entries per page; pass `page: 2` for the next slice.",
      ].join("\n"),
      inputSchema: withPagination({}),
    },
    async (params) => listCollections(db, params),
  );

  server.registerTool(
    "get_collection",
    {
      ...titled("Get collection", READ_ONLY_HINTS),
      description:
        "Detail for a single collection — name, description, and the ordered list of member organizations. Hidden / on-demand orgs never leak through; only publicly visible orgs appear in the member list.",
      inputSchema: {
        slug: z.string().describe("Collection slug (e.g. 'frontier-ai-labs')."),
      },
    },
    withMedia(async (params) => getCollection(db, params)),
  );

  server.registerTool(
    "get_collection_releases",
    {
      ...titled("Get collection releases", READ_ONLY_HINTS),
      description: [
        "Interleaved cross-org release feed for a collection — same shape as `get_latest_releases` but scoped to the collection's member orgs.",
        "",
        "Cursor-paginated: pass `limit` for slice size (default 20), `cursor` to continue from a prior call. The result's `_meta.pagination` carries `kind: 'cursor'`, `hasMore`, and `nextCursor` when more rows exist; the response text echoes `nextCursor` so an LLM caller can chain without parsing `_meta`. Cursors are stable under inserts.",
      ].join("\n"),
      // Shares the release-feed UI with `get_latest_releases` — same payload shape.
      _meta: uiMeta(RELEASE_FEED_UI_URI),
      inputSchema: {
        slug: z.string().describe("Collection slug (e.g. 'frontier-ai-labs')."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Slice size (1–200). Defaults to 20."),
        cursor: z
          .string()
          .optional()
          .describe(
            "Opaque continuation token from a prior call's `_meta.pagination.nextCursor`. Stale cursors are silently ignored — the call returns a fresh head of the feed.",
          ),
        include_prereleases: z
          .boolean()
          .optional()
          .describe(
            "Include prerelease tags (alphas, betas, RCs). Defaults to false so the feed matches the public web view.",
          ),
      },
    },
    withMedia(async (params) => getCollectionReleases(db, params)),
  );

  server.registerTool(
    "get_release",
    {
      ...titled("Get release", READ_ONLY_HINTS),
      description:
        "Fetch the full content of a single release by id. Release ids are returned by search or get_latest_releases — pass them here to read the whole entry (e.g. to quote a specific Next.js release note). Accepts the full rel_<nanoid> form or the bare 21-char nanoid.",
      inputSchema: {
        id: z.string().describe("Release id — 'rel_<nanoid>' or a bare 21-char nanoid"),
      },
    },
    withMedia(async (params) => getRelease(db, params)),
  );

  if (env.ENABLE_AI_TOOLS === "true") {
    server.registerTool(
      "summarize_changes",
      {
        ...titled("Summarize changes", AI_READ_HINTS),
        description: "Get an AI-generated summary of recent changes for a product",
        inputSchema: {
          product: z
            .string()
            .describe(
              "Source identifier: src_ id or org-scoped coordinate orgSlug/sourceSlug (e.g. 'vercel/next-js'). Bare slugs without an org prefix are not accepted.",
            ),
          days: z.number().optional().describe("Look back this many days (default 30)"),
          instructions: z
            .string()
            .optional()
            .describe(
              "Additional guidance for the summary (e.g. what to focus on, audience, format)",
            ),
        },
      },
      withMedia(async (params) => {
        const anthropic = await getAnthropic();
        return summarizeChanges(db, params, anthropic);
      }),
    );

    server.registerTool(
      "compare_products",
      {
        ...titled("Compare products", AI_READ_HINTS),
        description: "Compare recent changes between two products",
        inputSchema: {
          products: z
            .array(z.string())
            .describe(
              "Array of exactly two source identifiers to compare. Each entry must be a src_ id or an org-scoped coordinate orgSlug/sourceSlug (e.g. 'vercel/next-js'). Bare slugs without an org prefix are not accepted.",
            ),
          days: z.number().optional().describe("Look back this many days (default 30)"),
        },
      },
      withMedia(async (params) => {
        const anthropic = await getAnthropic();
        return compareProducts(db, params, anthropic);
      }),
    );
  }

  registerResources(server, db, mediaOrigin);
  registerPrompts(server, db, { aiTools: env.ENABLE_AI_TOOLS === "true" });

  return server;
}

import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, publicReadAuthMiddleware } from "./middleware/auth.js";
import { publicRateLimitMiddleware } from "./middleware/rate-limit.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { cacheControl } from "./middleware/cache.js";
import { varyOnAccept } from "./middleware/content-negotiation.js";
import { statsRoutes } from "./routes/stats.js";
import { orgRoutes } from "./routes/orgs.js";
import { sitemapRoutes } from "./routes/sitemap.js";
import { sourceRoutes } from "./routes/sources.js";
import { searchRoutes } from "./routes/search.js";
import { relatedRoutes } from "./routes/related.js";
import { fetchLogRoutes } from "./routes/fetch-log.js";
import { usageLogRoutes } from "./routes/usage-log.js";
import { ignoreRoutes } from "./routes/ignore.js";
import { statusRoutes } from "./routes/status.js";
import { sessionRoutes } from "./routes/sessions.js";
import { mediaRoutes } from "./routes/media.js";
import { releaseRoutes } from "./routes/releases.js";
import summaries from "./routes/summaries.js";
import knowledge from "./routes/knowledge.js";
import overview from "./routes/overview.js";
import playbook from "./routes/playbook.js";
import { productRoutes } from "./routes/products.js";
import { discoverRoutes } from "./routes/discover.js";
import { aliasRoutes } from "./routes/aliases.js";
import { evaluateRoutes } from "./routes/evaluate.js";
import { adminEmbedRoutes } from "./routes/admin-embed.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { pollAndFetch } from "./cron/poll-fetch.js";
import { retierSources } from "./cron/retier.js";

export { StatusHub } from "./status-hub.js";

/** Cloudflare Secrets Store binding — call .get() to retrieve the secret value. */
type SecretBinding = { get(): Promise<string> };

export type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY?: SecretBinding;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
    CACHE_DISABLED?: string;
    GITHUB_TOKEN?: SecretBinding;
    CRON_ENABLED?: string;
    DISCOVERY_WORKER?: Fetcher;
    // Vectorize indexes for semantic search (provisioned out-of-band).
    RELEASES_INDEX: VectorizeIndex;
    ENTITIES_INDEX: VectorizeIndex;
    CHANGELOG_CHUNKS_INDEX: VectorizeIndex;
    // Embedding provider config (see src/lib/embeddings.ts).
    EMBEDDING_PROVIDER?: string;
    VOYAGE_API_KEY?: SecretBinding;
    OPENAI_API_KEY?: SecretBinding;
    // Per-IP rate limiter for unauthenticated public reads (see middleware/rate-limit.ts).
    RATE_LIMIT_ENABLED?: string;
    PUBLIC_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // Optional KV namespace caching single-query embeddings on the search
    // path (see src/lib/embedding-cache.ts). Absent → every cold search
    // re-calls the embedding provider, matching pre-cache behavior.
    EMBED_CACHE?: KVNamespace;
  };
};

const app = new Hono<Env>();

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: "internal_error", message }, 500);
});

app.use("*", cors());

// Security response headers
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

// ── v1 REST API ──

const v1 = new Hono<Env>();

// No-auth routes (status WebSocket, public media GET)
v1.route("/", statusRoutes);
v1.route("/", mediaRoutes);

// Public-read routes: GET is open, writes require auth
const publicReadRoutes = [
  "stats", "orgs", "sources", "search", "releases",
  "products", "summaries", "knowledge", "overview", "tags",
  "related", "sitemap",
];
for (const r of publicReadRoutes) {
  v1.use(`/${r}`, publicReadAuthMiddleware, publicRateLimitMiddleware, dbHealthCheck);
  v1.use(`/${r}/*`, publicReadAuthMiddleware, publicRateLimitMiddleware, dbHealthCheck);
}

// Admin-only routes: all methods require auth.
// Playbook content (auto-generated header + agent notes) is internal —
// only authenticated CLI/agent callers should be able to read it.
const adminRoutes = [
  "sessions", "fetch-log", "usage-log", "blocked-urls",
  "discover", "evaluate", "aliases", "status/fetch-log", "status/usage", "status/event",
  "admin/embed", "playbook",
];
for (const r of adminRoutes) {
  v1.use(`/${r}`, authMiddleware, dbHealthCheck);
  v1.use(`/${r}/*`, authMiddleware, dbHealthCheck);
}

// Cache-Control for read-heavy GET endpoints
v1.use("/stats", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/orgs/:slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }), varyOnAccept());
v1.use("/orgs/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs/:slug/releases", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }), varyOnAccept());
v1.use("/orgs/:slug/accounts", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/sources", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/sources/fetchable", cacheControl(15));
v1.use("/sources/:slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }), varyOnAccept());
v1.use("/sources/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/search", cacheControl(30, { staleWhileRevalidate: 30, isPublic: true }), varyOnAccept());
v1.use("/related/*", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/releases/:id", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }), varyOnAccept());
v1.use("/status/fetch-log", cacheControl(15));
v1.use("/status/usage", cacheControl(30));
v1.use("/products", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/products/:slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/sitemap", cacheControl(600, { staleWhileRevalidate: 600, isPublic: true }));

// Route modules
v1.route("/", sessionRoutes);
v1.route("/", statsRoutes);
v1.route("/", orgRoutes);
v1.route("/", sitemapRoutes);
v1.route("/", productRoutes);
v1.route("/", sourceRoutes);
v1.route("/", searchRoutes);
v1.route("/", relatedRoutes);
v1.route("/", fetchLogRoutes);
v1.route("/", usageLogRoutes);
v1.route("/", ignoreRoutes);
v1.route("/", releaseRoutes);
v1.route("/summaries", summaries);
v1.route("/overview", overview);
v1.route("/playbook", playbook);
v1.route("/knowledge", knowledge); // deprecated — alias for overview/playbook
v1.route("/", discoverRoutes);
v1.route("/", aliasRoutes);
v1.route("/", evaluateRoutes);
v1.route("/", adminEmbedRoutes);
v1.route("/", telemetryRoutes);

// Static endpoint — categories are defined in code, not DB
v1.get("/categories", (c) => {
  // Import would create a circular dep, so we inline the list here.
  // Must stay in sync with src/lib/categories.ts.
  return c.json([
    "ai", "cloud", "database", "design", "developer-tools",
    "devops", "framework", "infrastructure", "observability", "security",
  ]);
});

app.route("/v1", v1);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env["Bindings"], ctx: ExecutionContext) {
    // Daily retier job runs at 03:00 UTC; poll-and-fetch runs every other hour.
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(retierSources({
        DB: env.DB,
        CRON_ENABLED: env.CRON_ENABLED,
      }));
      return;
    }
    const githubToken = await env.GITHUB_TOKEN?.get();
    ctx.waitUntil(pollAndFetch({
      DB: env.DB,
      GITHUB_TOKEN: githubToken,
      CRON_ENABLED: env.CRON_ENABLED,
      RELEASES_INDEX: env.RELEASES_INDEX,
      CHANGELOG_CHUNKS_INDEX: env.CHANGELOG_CHUNKS_INDEX,
      EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
      VOYAGE_API_KEY: env.VOYAGE_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
    }));
  },
};

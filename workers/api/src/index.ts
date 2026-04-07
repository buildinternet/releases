import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { cacheControl } from "./middleware/cache.js";
import { varyOnAccept } from "./middleware/content-negotiation.js";
import { statsRoutes } from "./routes/stats.js";
import { orgRoutes } from "./routes/orgs.js";
import { sourceRoutes } from "./routes/sources.js";
import { searchRoutes } from "./routes/search.js";
import { fetchLogRoutes } from "./routes/fetch-log.js";
import { usageLogRoutes } from "./routes/usage-log.js";
import { ignoreRoutes } from "./routes/ignore.js";
import { statusRoutes } from "./routes/status.js";
import { sessionRoutes } from "./routes/sessions.js";
import { mediaRoutes } from "./routes/media.js";
import { releaseRoutes } from "./routes/releases.js";
import summaries from "./routes/summaries.js";
import { productRoutes } from "./routes/products.js";
import { discoverRoutes } from "./routes/discover.js";
import { pollAndFetch } from "./cron/poll-fetch.js";

export { StatusHub } from "./status-hub.js";

export type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
    CACHE_DISABLED?: string;
    GITHUB_TOKEN?: string;
    CRON_ENABLED?: string;
    DISCOVERY_WORKER?: Fetcher;
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

// Unauthenticated routes (status WebSocket/fetch, public media GET)
v1.route("/", statusRoutes);
v1.route("/", mediaRoutes);

// Auth + DB health for everything else
v1.use("/*", authMiddleware);
v1.use("/*", dbHealthCheck);

// Cache-Control for read-heavy GET endpoints.
// Public endpoints use CDN edge caching; internal/admin endpoints stay private.
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
v1.use("/releases/:id", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }), varyOnAccept());
v1.use("/summaries/*", cacheControl(300, { staleWhileRevalidate: 120, isPublic: true }));
v1.use("/status/fetch-log", cacheControl(15));
v1.use("/status/usage", cacheControl(30));
v1.use("/products", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/products/:slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));

// Route modules
v1.route("/", sessionRoutes);
v1.route("/", statsRoutes);
v1.route("/", orgRoutes);
v1.route("/", productRoutes);
v1.route("/", sourceRoutes);
v1.route("/", searchRoutes);
v1.route("/", fetchLogRoutes);
v1.route("/", usageLogRoutes);
v1.route("/", ignoreRoutes);
v1.route("/", releaseRoutes);
v1.route("/summaries", summaries);
v1.route("/", discoverRoutes);

app.route("/v1", v1);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(pollAndFetch(env));
  },
};

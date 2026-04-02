import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { cacheControl } from "./middleware/cache.js";
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

export { StatusHub } from "./status-hub.js";

export type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
    CACHE_DISABLED?: string;
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

// Status routes mounted before auth — they accept unauthenticated browser WebSocket/fetch connections
app.route("/api", statusRoutes);

// Media routes mounted before auth — GET is public, PUT has its own auth check
app.route("/api", mediaRoutes);

app.use("/api/*", authMiddleware);
app.use("/api/*", dbHealthCheck);

// Cache-Control for read-heavy GET endpoints (Cloudflare handles gzip/brotli automatically).
// Set CACHE_DISABLED=1 in env to bypass (e.g. local dev).
app.use("/api/stats", cacheControl(300, { staleWhileRevalidate: 60 }));
app.use("/api/orgs", cacheControl(60, { staleWhileRevalidate: 30 }));
app.use("/api/orgs/:slug", cacheControl(60, { staleWhileRevalidate: 30 }));
app.use("/api/orgs/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60 }));
app.use("/api/sources", cacheControl(60, { staleWhileRevalidate: 30 }));
app.use("/api/sources/:slug", cacheControl(60, { staleWhileRevalidate: 30 }));
app.use("/api/search", cacheControl(30, { staleWhileRevalidate: 30 }));
app.use("/api/releases/:id", cacheControl(120, { staleWhileRevalidate: 60 }));
app.use("/api/summaries/*", cacheControl(300, { staleWhileRevalidate: 120 }));
app.use("/api/status/fetch-log", cacheControl(15));
app.use("/api/status/usage", cacheControl(30));
app.use("/api/orgs/:slug/releases", cacheControl(60, { staleWhileRevalidate: 30 }));
app.use("/api/orgs/:slug/accounts", cacheControl(120, { staleWhileRevalidate: 60 }));
app.use("/api/sources/fetchable", cacheControl(15));
app.use("/api/sources/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60 }));

app.route("/api", sessionRoutes);
app.route("/api", statsRoutes);
app.route("/api", orgRoutes);
app.route("/api", sourceRoutes);
app.route("/api", searchRoutes);
app.route("/api", fetchLogRoutes);
app.route("/api", usageLogRoutes);
app.route("/api", ignoreRoutes);
app.route("/api", releaseRoutes);
app.route("/api/summaries", summaries);

export default app;

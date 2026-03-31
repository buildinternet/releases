import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { statsRoutes } from "./routes/stats.js";
import { orgRoutes } from "./routes/orgs.js";
import { sourceRoutes } from "./routes/sources.js";
import { searchRoutes } from "./routes/search.js";
import { fetchLogRoutes } from "./routes/fetch-log.js";
import { usageLogRoutes } from "./routes/usage-log.js";
import { ignoreRoutes } from "./routes/ignore.js";
import { statusRoutes } from "./routes/status.js";
import { mediaRoutes } from "./routes/media.js";
import summaries from "./routes/summaries.js";

export { StatusHub } from "./status-hub.js";

export type Env = {
  Bindings: {
    DB: D1Database;
    API_SECRET: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
  };
};

const app = new Hono<Env>();

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: "internal_error", message }, 500);
});

app.use("*", cors());

// Status routes mounted before auth — they accept unauthenticated browser WebSocket/fetch connections
app.route("/api", statusRoutes);

// Media routes mounted before auth — GET is public, PUT has its own auth check
app.route("/api", mediaRoutes);

app.use("/api/*", authMiddleware);
app.use("/api/*", dbHealthCheck);

app.route("/api", statsRoutes);
app.route("/api", orgRoutes);
app.route("/api", sourceRoutes);
app.route("/api", searchRoutes);
app.route("/api", fetchLogRoutes);
app.route("/api", usageLogRoutes);
app.route("/api", ignoreRoutes);
app.route("/api/summaries", summaries);

export default app;

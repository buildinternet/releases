import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { statsRoutes } from "./routes/stats.js";
import { orgRoutes } from "./routes/orgs.js";
import { sourceRoutes } from "./routes/sources.js";
import { searchRoutes } from "./routes/search.js";
import { fetchLogRoutes } from "./routes/fetch-log.js";
import { ignoreRoutes } from "./routes/ignore.js";
import { statusRoutes } from "./routes/status.js";

export { StatusHub } from "./status-hub.js";

export type Env = {
  Bindings: {
    DB: D1Database;
    API_SECRET: string;
    DEV_MODE: string;
    STATUS_HUB: DurableObjectNamespace;
  };
};

const app = new Hono<Env>();

app.use("*", cors());

// Status routes mounted before auth — they use their own devModeMiddleware gate
// and need to accept unauthenticated browser WebSocket/fetch connections
app.route("/api", statusRoutes);

app.use("/api/*", authMiddleware);
app.use("/api/*", dbHealthCheck);

app.route("/api", statsRoutes);
app.route("/api", orgRoutes);
app.route("/api", sourceRoutes);
app.route("/api", searchRoutes);
app.route("/api", fetchLogRoutes);
app.route("/api", ignoreRoutes);

export default app;

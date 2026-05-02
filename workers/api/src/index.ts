import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, publicReadAuthMiddleware } from "./middleware/auth.js";
import { publicRateLimitMiddleware } from "./middleware/rate-limit.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { cacheControl } from "./middleware/cache.js";
import { varyOnAccept } from "./middleware/content-negotiation.js";
import { blockIndexing } from "./middleware/indexing.js";
import { stagingAccessGate } from "./middleware/staging-access.js";
import { statsRoutes } from "./routes/stats.js";
import { orgRoutes } from "./routes/orgs.js";
import { sitemapRoutes } from "./routes/sitemap.js";
import { sourceRoutes } from "./routes/sources.js";
import { searchRoutes } from "./routes/search.js";
import { relatedRoutes } from "./routes/related.js";
import { fetchLogRoutes } from "./routes/fetch-log.js";
import { usageLogRoutes } from "./routes/usage-log.js";
import { ignoreRoutes } from "./routes/ignore.js";
import { lookupRoutes } from "./routes/lookups.js";
import { statusRoutes } from "./routes/status.js";
import { sessionRoutes } from "./routes/sessions.js";
import { mediaRoutes } from "./routes/media.js";
import { streamRoutes } from "./routes/stream.js";
import { mountWebhooksReplay } from "./routes/webhooks-replay.js";
import { releaseRoutes } from "./routes/releases.js";
import summaries from "./routes/summaries.js";
import overview from "./routes/overview.js";
import overviewInputs from "./routes/overview-inputs.js";
import playbook from "./routes/playbook.js";
import { productRoutes } from "./routes/products.js";
import { evaluateRoutes } from "./routes/evaluate.js";
import { adminEmbedStatusRoutes } from "./routes/admin-embed-status.js";
import { adminCronRunsRoutes } from "./routes/admin-cron-runs.js";
import { adminSearchQueriesRoutes } from "./routes/admin-search-queries.js";
import { errataRoutes } from "./routes/errata.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { workflowsRoutes } from "./routes/workflows.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { pollAndFetch, queryDueSources } from "./cron/poll-fetch.js";
import { drizzle } from "drizzle-orm/d1";
import { retierSources } from "./cron/retier.js";
import { scrapeAgentSweep } from "./cron/scrape-agent-sweep.js";
import { forceDrainSweep } from "./cron/force-drain-sweep.js";
import { sweepSearchQueries } from "./cron/sweep-search-queries.js";
import { sendAlert, type AlertEnv } from "./lib/send-alert.js";

export { StatusHub } from "./status-hub.js";
export { ReleaseHub } from "./release-hub.js";
export { ScrapeAgentSweepWorkflow } from "./workflows/scrape-agent-sweep.js";
export { PollAndFetchWorkflow } from "./workflows/poll-and-fetch.js";
export { PollFetchSummaryWorkflow } from "./workflows/poll-fetch-summary.js";
export { OnboardSourceWorkflow } from "./workflows/onboard-source.js";

/** Cloudflare Secrets Store binding — call .get() to retrieve the secret value. */
type SecretBinding = { get(): Promise<string> };

export type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY?: SecretBinding;
    // Shared secret for the web frontend's server-to-server traffic. Unlike
    // RELEASED_API_KEY this only exempts requests from the public rate limiter —
    // it does NOT unlock admin-gated content. Sent as X-Releases-Proxy-Key.
    RELEASES_PROXY_KEY?: SecretBinding;
    STATUS_HUB: DurableObjectNamespace;
    RELEASE_HUB: DurableObjectNamespace;
    WEBHOOK_DELIVERY_QUEUE: Queue<unknown>;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
    CACHE_DISABLED?: string;
    GITHUB_TOKEN?: SecretBinding;
    CRON_ENABLED?: string;
    SCRAPE_AGENT_CRON_ENABLED?: string;
    SCRAPE_AGENT_MAX_SESSIONS?: string;
    // Feature flag: when "true", the 01:00 UTC cron kicks a
    // `SCRAPE_AGENT_WORKFLOW` instance instead of inlining
    // `scrapeAgentSweep()` in `ctx.waitUntil`. See issue #482.
    SCRAPE_AGENT_USE_WORKFLOW?: string;
    SCRAPE_AGENT_WORKFLOW?: Workflow;
    // Feature flag: when "true", the 2-hourly poll-and-fetch cron fans out
    // one `POLL_AND_FETCH_WORKFLOW` instance per due source instead of
    // inlining `pollAndFetch()` in `ctx.waitUntil`. See issue #486.
    POLL_FETCH_USE_WORKFLOW?: string;
    POLL_AND_FETCH_WORKFLOW?: Workflow;
    // Summary workflow kicked once per hourly fan-out. Sleeps 10 min then
    // emails any failures recorded in `workflow_failures` by per-source
    // instances. Optional — absent → no alert (safe default).
    POLL_FETCH_SUMMARY_WORKFLOW?: Workflow;
    // Feature flag: when "true", `POST /v1/sources` dispatches an
    // `ONBOARD_SOURCE_WORKFLOW` instance for the playbook + embed + backfill
    // tail instead of riding `c.executionCtx.waitUntil(...)`. See issue #493.
    ONBOARD_USE_WORKFLOW?: string;
    ONBOARD_SOURCE_WORKFLOW?: Workflow;
    // Feature flag: when "true", poll-and-fetch widens its candidate set to
    // include scrape/agent sources with no feedUrl and routes them through
    // change-detector branches defined in the org playbook's `fetchQuirks`
    // frontmatter. Default off. See #517.
    SCRAPE_CHANGE_DETECT_ENABLED?: string;
    // Feature flag: when "true", the 04:00 UTC cron force-drains stranded
    // scrape/agent sources (unreliable quirk or stale beyond
    // FORCE_DRAIN_STALE_HOURS) into the scrape-agent-sweep inbox. Default
    // off. See #518.
    FORCE_DRAIN_CRON_ENABLED?: string;
    FORCE_DRAIN_STALE_HOURS?: string;
    FORCE_SWEEP_MAX_SESSIONS?: string;
    DISCOVERY_WORKER?: Fetcher;
    ANTHROPIC_API_KEY?: SecretBinding;
    // Optional Cloudflare AI Gateway passthrough. When set, all direct Anthropic
    // SDK calls from this worker route through the gateway for observability,
    // caching, and fallback config. Managed-agent internal calls run on
    // Anthropic's infra and are not affected. See docs/architecture/ai-gateway.md.
    ANTHROPIC_BASE_URL?: string;
    AI_GATEWAY_TOKEN?: SecretBinding;
    // Vectorize indexes for semantic search (provisioned out-of-band).
    RELEASES_INDEX: VectorizeIndex;
    ENTITIES_INDEX: VectorizeIndex;
    CHANGELOG_CHUNKS_INDEX: VectorizeIndex;
    // Embedding provider config (see packages/search/src/embeddings.ts).
    EMBEDDING_PROVIDER?: string;
    VOYAGE_API_KEY?: SecretBinding;
    OPENAI_API_KEY?: SecretBinding;
    WEBHOOK_HMAC_MASTER?: SecretBinding;
    // Cloudflare credentials for querying Analytics Engine (webhook deliveries endpoint).
    // Absent → GET /v1/webhooks/:id/deliveries returns 501.
    CF_API_TOKEN?: SecretBinding;
    CF_ACCOUNT_ID?: string;
    // Per-IP rate limiter for unauthenticated public reads (see middleware/rate-limit.ts).
    RATE_LIMIT_ENABLED?: string;
    PUBLIC_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // Optional KV namespace caching single-query embeddings on the search
    // path (see packages/search/src/embedding-cache.ts). Absent → every cold search
    // re-calls the embedding provider, matching pre-cache behavior.
    EMBED_CACHE?: KVNamespace;
    // Optional KV namespace caching the GET /v1/releases/latest response
    // (see src/lib/latest-cache.ts). Absent → every request hits D1.
    LATEST_CACHE?: KVNamespace;
    // Gates event-driven KV purge of `/v1/releases/latest` (see
    // src/lib/latest-cache.ts invalidateLatestCache). Ships "false"; flipped
    // to "true" after a parity-logging week.
    INVALIDATION_ENABLED?: string;
    // Email notifications (see src/lib/email.ts). SEND_EMAIL is the Cloudflare
    // Email Routing send binding; absent → email notifications no-op.
    SEND_EMAIL?: { send(message: unknown): Promise<void> };
    EMAIL_NOTIFY_ENABLED?: string;
    EMAIL_NOTIFY_TO?: string;
    EMAIL_FROM?: string;
    ADMIN_BASE_URL?: string;
    // Optional KV namespace for Tier-1 alert dedup (1h TTL per subject).
    // Reuses an existing KV binding — no new resource needed.
    // See src/lib/send-alert.ts.
    ALERT_DEDUP_KV?: KVNamespace;
    // Staging-only kill switch — see middleware/indexing.ts.
    INDEXING_DISABLED?: string;
    // When "true", `/v1/search` and the MCP search tools skip writing rows to
    // `search_queries`. Default off → logging on. See workers/api/src/lib/log-search.ts.
    SEARCH_QUERY_LOG_DISABLED?: string;
    // Retention window for `search_queries` rows. Rows older than this many days
    // are deleted by the nightly 05:00 UTC sweep. Default 90.
    SEARCH_QUERY_RETENTION_DAYS?: string;
    // Staging-only shared secret — see middleware/staging-access.ts. Absent
    // everywhere outside `[env.staging]`, so the gate no-ops for prod/local.
    STAGING_ACCESS_KEY?: SecretBinding;
    // Errata memory store ID — destination for POST /v1/errata/:orgId. See #537.
    MEMORY_STORE_ERRATA_ID?: string;
    // IndexNow integration (#649). When INDEXNOW_ENABLED="true", new releases
    // ping api.indexnow.org so search engines pick up the org/source/product
    // changes immediately. Off everywhere by default; staging stays off via
    // INDEXING_DISABLED. Key is hosted at https://releases.sh/{INDEXNOW_KEY}.txt
    // by web/src/proxy.ts.
    INDEXNOW_ENABLED?: string;
    INDEXNOW_KEY?: SecretBinding;
    // Public web base URL — used by the IndexNow helper to build canonical
    // URLs. Defaults to https://releases.sh when unset.
    WEB_BASE_URL?: string;
  };
};

const app = new Hono<Env>();

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: "internal_error", message }, 500);
});

// Public read CORS — wildcard is fine; these endpoints don't accept credentials.
app.use("*", cors());
app.use("*", stagingAccessGate());
app.use("*", blockIndexing());

// Security response headers
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

// ── v1 REST API ──

const v1 = new Hono<Env>();

// No-auth routes (status WebSocket, public media GET, public webhook replay)
v1.route("/", statusRoutes);
v1.route("/", mediaRoutes);
v1.route("/", streamRoutes);
mountWebhooksReplay(v1, (c) => c.env);

// Public-read routes: GET is open, writes require auth
const publicReadRoutes = [
  "stats",
  "orgs",
  "sources",
  "search",
  "releases",
  "products",
  "tags",
  "related",
  "sitemap",
];
for (const r of publicReadRoutes) {
  v1.use(`/${r}`, publicReadAuthMiddleware, publicRateLimitMiddleware, dbHealthCheck);
  v1.use(`/${r}/*`, publicReadAuthMiddleware, publicRateLimitMiddleware, dbHealthCheck);
}

// Admin-only routes: all methods require auth. /v1/lookups is here (not in
// publicReadRoutes) because the route only exposes a side-effecting POST —
// public GETs aren't a thing on it. MCP fallbacks present a Bearer via the
// API service binding (see workers/mcp/src/mcp-agent.ts maybeLookup).
const adminRoutes = [
  "sessions",
  "evaluate",
  "status/fetch-log",
  "status/usage",
  "status/event",
  "admin/blocklist",
  "admin/embed/status",
  "admin/cron-runs",
  "admin/logs",
  "admin/search-queries",
  "errata",
  "webhooks",
  "workflows",
  "lookups",
];
for (const r of adminRoutes) {
  v1.use(`/${r}`, authMiddleware, dbHealthCheck);
  v1.use(`/${r}/*`, authMiddleware, dbHealthCheck);
}

// Admin / write paths — scope CORS to known first-party origins so the
// global wildcard (set above on `app`) is overridden for these routes.
// Browsers already refuse credentialed requests to wildcard origins; this is
// defense-in-depth. Add staging frontend origins here when one ships.
// NOTE: This must be registered AFTER app.use("*", cors()) so that Hono's
// header writes resolve to the stricter value for admin paths.
const ALLOWED_ADMIN_ORIGINS = [
  "https://releases.sh",
  // staging.releases.sh is the expected staging web host once it ships;
  // add it here when the staging frontend is deployed.
];
const adminCors = cors({
  origin: ALLOWED_ADMIN_ORIGINS,
  credentials: true,
});
for (const r of adminRoutes) {
  v1.use(`/${r}`, adminCors);
  v1.use(`/${r}/*`, adminCors);
}

// Cache-Control for read-heavy GET endpoints
v1.use("/stats", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use(
  "/orgs/:slug",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/orgs/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use(
  "/orgs/:slug/releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/orgs/:slug/accounts", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/sources", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/sources/fetchable", cacheControl(15));
v1.use(
  "/sources/:slug",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/sources/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/search", cacheControl(30, { staleWhileRevalidate: 30, isPublic: true }), varyOnAccept());
v1.use("/related/*", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use(
  "/releases/:id",
  cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }),
  varyOnAccept(),
);
v1.use("/status/fetch-log", cacheControl(15));
v1.use("/status/usage", cacheControl(30));
v1.use("/products", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/products/:slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/sitemap", cacheControl(600, { staleWhileRevalidate: 600, isPublic: true }));

// Route modules — releaseRoutes is mounted before sourceRoutes so the static
// `/releases/latest` handler (in releases.ts) wins over the parametric
// `/releases/:id` handler (in sources.ts) regardless of router internals.
v1.route("/", sessionRoutes);
v1.route("/", statsRoutes);
v1.route("/", orgRoutes);
v1.route("/", sitemapRoutes);
v1.route("/", productRoutes);
v1.route("/", releaseRoutes);
v1.route("/", sourceRoutes);
v1.route("/", searchRoutes);
v1.route("/", relatedRoutes);
v1.route("/", fetchLogRoutes);
v1.route("/", usageLogRoutes);
v1.route("/", ignoreRoutes);
v1.route("/", lookupRoutes);
v1.route("/", summaries);
v1.route("/", overview);
v1.route("/", overviewInputs);
v1.route("/", playbook);
v1.route("/", evaluateRoutes);
v1.route("/", adminEmbedStatusRoutes);
v1.route("/", adminCronRunsRoutes);
v1.route("/", adminSearchQueriesRoutes);
v1.route("/", errataRoutes);
v1.route("/", webhooksRoutes);
v1.route("/", workflowsRoutes);
v1.route("/", telemetryRoutes);

// Static endpoint — categories are defined in code, not DB
v1.get("/categories", (c) => {
  // Import would create a circular dep, so we inline the list here.
  // Must stay in sync with src/lib/categories.ts.
  return c.json([
    "ai",
    "cloud",
    "database",
    "design",
    "developer-tools",
    "devops",
    "framework",
    "infrastructure",
    "observability",
    "security",
  ]);
});

app.route("/v1", v1);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env["Bindings"], ctx: ExecutionContext) {
    // Daily retier job runs at 03:00 UTC; scrape-no-feed agent sweep at 01:00 UTC;
    // force-drain for stranded sources at 04:00 UTC; search-queries retention
    // sweep at 05:00 UTC; poll-and-fetch hourly.
    // Build the alert env once; shared by all five cron dispatch sites.
    const alertEnv: AlertEnv = {
      SEND_EMAIL: env.SEND_EMAIL,
      EMAIL_NOTIFY_ENABLED: env.EMAIL_NOTIFY_ENABLED,
      EMAIL_NOTIFY_TO: env.EMAIL_NOTIFY_TO,
      EMAIL_FROM: env.EMAIL_FROM,
      ALERT_DEDUP_KV: env.ALERT_DEDUP_KV,
    };

    if (event.cron === "0 5 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "sweep-search-queries-cron",
          sweepSearchQueries({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            SEARCH_QUERY_RETENTION_DAYS: env.SEARCH_QUERY_RETENTION_DAYS,
          }),
          alertEnv,
        ),
      );
      return;
    }
    if (event.cron === "0 4 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "force-drain-cron",
          forceDrainSweep({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            FORCE_DRAIN_CRON_ENABLED: env.FORCE_DRAIN_CRON_ENABLED,
            FORCE_DRAIN_STALE_HOURS: env.FORCE_DRAIN_STALE_HOURS,
            FORCE_SWEEP_MAX_SESSIONS: env.FORCE_SWEEP_MAX_SESSIONS,
          }),
          alertEnv,
        ),
      );
      return;
    }
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "retier-cron",
          retierSources({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
          }),
          alertEnv,
        ),
      );
      return;
    }
    if (event.cron === "0 1 * * *") {
      if (!env.DISCOVERY_WORKER) {
        console.warn("[scrape-agent-cron] DISCOVERY_WORKER binding missing; skipping");
        return;
      }
      // Feature-flag the Workflows-based path. Behavior is identical to
      // the inline sweep — the workflow resolves secrets + runs the same
      // pipeline step-by-step so a partial failure doesn't strand the
      // tail of the dispatch list. See issue #482.
      if (env.SCRAPE_AGENT_USE_WORKFLOW === "true") {
        if (!env.SCRAPE_AGENT_WORKFLOW) {
          console.warn(
            "[scrape-agent-cron] SCRAPE_AGENT_USE_WORKFLOW=true but workflow binding missing; skipping",
          );
          return;
        }
        ctx.waitUntil(
          loggedDispatch(
            "scrape-agent-cron",
            env.SCRAPE_AGENT_WORKFLOW.create({
              id: `scrape-agent-sweep-${event.scheduledTime}`,
              params: { scheduledTime: event.scheduledTime },
            }),
            alertEnv,
          ),
        );
        return;
      }
      const releasesApiKey = await env.RELEASED_API_KEY?.get();
      if (!releasesApiKey) {
        console.warn("[scrape-agent-cron] RELEASED_API_KEY secret missing; skipping");
        return;
      }
      ctx.waitUntil(
        loggedDispatch(
          "scrape-agent-cron",
          scrapeAgentSweep({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            SCRAPE_AGENT_CRON_ENABLED: env.SCRAPE_AGENT_CRON_ENABLED,
            SCRAPE_AGENT_MAX_SESSIONS: env.SCRAPE_AGENT_MAX_SESSIONS,
            FORCE_DRAIN_STALE_HOURS: env.FORCE_DRAIN_STALE_HOURS,
            DISCOVERY_WORKER: env.DISCOVERY_WORKER,
            RELEASED_API_KEY: releasesApiKey,
            ANTHROPIC_API_KEY: await env.ANTHROPIC_API_KEY?.get(),
            ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
            AI_GATEWAY_TOKEN: await env.AI_GATEWAY_TOKEN?.get().catch(() => undefined),
            SEND_EMAIL: env.SEND_EMAIL,
            EMAIL_NOTIFY_ENABLED: env.EMAIL_NOTIFY_ENABLED,
            EMAIL_NOTIFY_TO: env.EMAIL_NOTIFY_TO,
            EMAIL_FROM: env.EMAIL_FROM,
            ADMIN_BASE_URL: env.ADMIN_BASE_URL,
          }),
          alertEnv,
        ),
      );
      return;
    }
    // Feature-flag the Workflows-based poll-and-fetch path. When flipped,
    // the cron fans out one workflow instance per due source so a single
    // transient failure (usually a Voyage 429 mid-embed) no longer silently
    // drops vectors. See issue #486.
    if (env.POLL_FETCH_USE_WORKFLOW === "true") {
      if (!env.POLL_AND_FETCH_WORKFLOW) {
        console.warn(
          "[poll-fetch-cron] POLL_FETCH_USE_WORKFLOW=true but workflow binding missing; skipping",
        );
        return;
      }
      ctx.waitUntil(
        loggedDispatch("poll-fetch-cron", fanOutPollAndFetch(env, event.scheduledTime), alertEnv),
      );
      return;
    }
    const githubToken = await env.GITHUB_TOKEN?.get();
    ctx.waitUntil(
      loggedDispatch(
        "poll-fetch-cron",
        pollAndFetch({
          DB: env.DB,
          GITHUB_TOKEN: githubToken,
          CRON_ENABLED: env.CRON_ENABLED,
          SCRAPE_CHANGE_DETECT_ENABLED: env.SCRAPE_CHANGE_DETECT_ENABLED,
          RELEASES_INDEX: env.RELEASES_INDEX,
          CHANGELOG_CHUNKS_INDEX: env.CHANGELOG_CHUNKS_INDEX,
          EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
          VOYAGE_API_KEY: env.VOYAGE_API_KEY,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          RELEASE_HUB: env.RELEASE_HUB,
          WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
          LATEST_CACHE: env.LATEST_CACHE,
          INVALIDATION_ENABLED: env.INVALIDATION_ENABLED,
        }),
        alertEnv,
      ),
    );
  },
};

/**
 * Wrap a cron dispatch promise so a rejection hits the Workers error log
 * with our tag instead of vanishing into `ctx.waitUntil`'s swallow. Returns
 * a Promise<void> that always resolves — swallowing stays; logging is what's
 * new. See issue #486 postmortem.
 *
 * When `alertEnv` is provided and the promise rejects, also fires a Tier-1
 * [alert] email via `sendAlert()` (fire-and-forget, deduplicated per 1h).
 */
function loggedDispatch(tag: string, p: Promise<unknown>, alertEnv?: AlertEnv): Promise<void> {
  return p
    .then(() => undefined)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(`[${tag}] dispatch failed: ${message}`, stack ?? "");
      if (alertEnv) {
        const body = [`Cron tag: ${tag}`, `Error: ${message}`, stack ? `\nStack:\n${stack}` : ""]
          .filter(Boolean)
          .join("\n");
        // Fire-and-forget — never block or throw in the catch handler.
        sendAlert(alertEnv, {
          subject: `[alert] cron crashed: ${tag}`,
          body,
        }).catch(() => undefined);
      }
    });
}

/**
 * Query due sources and spawn one `POLL_AND_FETCH_WORKFLOW` per source.
 * `createBatch` has a hard cap of 100 instances per call, so we chunk.
 * The workflow handles CRON_ENABLED internally — keeping that check there
 * means a flag flip mid-fan-out still short-circuits each instance cleanly.
 */
const CREATE_BATCH_MAX = 100;

async function fanOutPollAndFetch(env: Env["Bindings"], scheduledTime: number): Promise<void> {
  const db = drizzle(env.DB);
  const due = await queryDueSources(db, new Date(), {
    changeDetectEnabled: env.SCRAPE_CHANGE_DETECT_ENABLED === "true",
  });
  if (due.length === 0) {
    console.log("[poll-fetch-cron] no due sources; skipping workflow fan-out");
    return;
  }
  console.log(`[poll-fetch-cron] fan-out ${due.length} workflow instance(s)`);
  const params = due.map((source) => ({
    // Instance IDs must be unique; pairing the scheduled time with the source
    // id keeps replays from collisions across fires. See #486.
    id: `poll-fetch-${scheduledTime}-${source.id}`,
    params: { sourceId: source.id, scheduledTime },
  }));
  for (let i = 0; i < params.length; i += CREATE_BATCH_MAX) {
    const chunk = params.slice(i, i + CREATE_BATCH_MAX);
    // oxlint-disable-next-line no-await-in-loop -- sequential to stay under control-plane rate; per-instance work runs in parallel anyway
    await env.POLL_AND_FETCH_WORKFLOW!.createBatch(chunk);
  }

  // Kick one summary instance per fan-out. It sleeps 10 min then queries
  // workflow_failures for this scheduledTime and sends one alert if any
  // sources failed. Absent binding → silently skip.
  if (env.POLL_FETCH_SUMMARY_WORKFLOW) {
    try {
      await env.POLL_FETCH_SUMMARY_WORKFLOW.create({
        id: `poll-fetch-summary-${scheduledTime}`,
        params: { scheduledTime },
      });
    } catch (err) {
      // Non-fatal — don't let summary wiring failure block the fan-out.
      console.warn(
        `[poll-fetch-cron] failed to create summary workflow: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

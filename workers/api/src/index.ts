import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import {
  authMiddleware,
  publicReadAuthMiddleware,
  tokensAuthMiddleware,
} from "./middleware/auth.js";
import type { AuthContext } from "./middleware/auth.js";
import { publicRateLimitMiddleware } from "./middleware/rate-limit.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { cacheControl } from "./middleware/cache.js";
import { varyOnAccept } from "./middleware/content-negotiation.js";
import { blockIndexing } from "./middleware/indexing.js";
import { stagingAccessGate } from "./middleware/staging-access.js";
import { mountV1Routes } from "./v1-routes.js";
import { publicReadRoutes, adminRoutes } from "./route-namespaces.js";
import { graphqlRoutes } from "./graphql/handler.js";
import { BareSlugRejected } from "./utils.js";
import { pollAndFetch, queryDueSources } from "./cron/poll-fetch.js";
import { drizzle } from "drizzle-orm/d1";
import { finalizeRunRow, insertRunningRow } from "./db/cron-runs-dao.js";
import { retierSources } from "./cron/retier.js";
import { scrapeAgentSweep } from "./cron/scrape-agent-sweep.js";
import { forceDrainSweep } from "./cron/force-drain-sweep.js";
import { sweepSearchQueries } from "./cron/sweep-search-queries.js";
import { sweepTombstones } from "./cron/sweep-tombstones.js";
import { sendAlert, type AlertEnv } from "./lib/send-alert.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { getSecret } from "@releases/lib/secrets";

export { StatusHub } from "./status-hub.js";
export { ReleaseHub } from "./release-hub.js";
export { ScrapeAgentSweepWorkflow } from "./workflows/scrape-agent-sweep.js";
export { PollAndFetchWorkflow } from "./workflows/poll-and-fetch.js";
export { PollFetchSummaryWorkflow } from "./workflows/poll-fetch-summary.js";
export { OnboardSourceWorkflow } from "./workflows/onboard-source.js";
export { BatchSummarizeWorkflow } from "./workflows/batch-summarize.js";
export { BatchOverviewWorkflow } from "./workflows/batch-overview.js";

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
    // Batch summarization workflow (issue #971). Cron at 04:30 UTC; self-gates
    // via BATCH_SUMMARIZE_ENABLED. Admin POST trigger runs unconditionally.
    BATCH_SUMMARIZE_ENABLED?: string;
    BATCH_SUMMARIZE_MAX_COST_USD?: string;
    BATCH_SUMMARIZE_WORKFLOW?: Workflow;
    // Batch overview workflow. Admin POST trigger only for now (no cron entry
    // until the path is proven against the existing weekly managed-agent
    // routine). Self-gates via BATCH_OVERVIEW_ENABLED for any future cron path.
    BATCH_OVERVIEW_ENABLED?: string;
    BATCH_OVERVIEW_MAX_COST_USD?: string;
    BATCH_OVERVIEW_WORKFLOW?: Workflow;
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
    /**
     * Service binding to the discovery worker. Typed as the RPC surface
     * (`startManagedFetchSession`) plus the standard HTTP `fetch` method used
     * by the scrape-agent sweep (`/update`). The `entrypoint:
     * "DiscoveryEntrypoint"` annotation in wrangler.jsonc ensures the binding
     * resolves to the named class so RPC methods are available at runtime.
     */
    DISCOVERY_WORKER?: import("./cron/poll-fetch.js").DiscoveryWorkerRpc & {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    };
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
    // Kill switch for DB-backed token validation (see middleware/auth.ts).
    // When "true", all relk_… tokens are rejected without a DB lookup.
    API_TOKENS_DISABLED?: string;
    // When "true", `/v1/search` and the MCP search tools skip writing rows to
    // `search_queries`. Default off → logging on. See workers/api/src/lib/log-search.ts.
    SEARCH_QUERY_LOG_DISABLED?: string;
    // Retention window for `search_queries` rows. Rows older than this many days
    // are deleted by the nightly 05:00 UTC sweep. Default 90.
    SEARCH_QUERY_RETENTION_DAYS?: string;
    // Retention window for soft-deleted org/source/product rows. Tombstoned
    // rows older than this many days are hard-purged by the nightly 05:30 UTC
    // sweep. Default 30. See workers/api/src/cron/sweep-tombstones.ts (#666).
    TOMBSTONE_RETENTION_DAYS?: string;
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
    // Deploy-environment discriminator. Set to "production" in the top-level
    // wrangler.jsonc vars and "staging" in the env.staging block. Read by
    // /v1/graphql to gate GraphiQL + introspection. Absent in `wrangler dev`.
    ENVIRONMENT?: string;
  };
  Variables: {
    auth?: AuthContext;
  };
};

const app = new Hono<Env>();

app.onError((err, c) => {
  // Bare-path source/product routes that match a slug instead of a typed ID
  // throw `BareSlugRejected` from `resolveSourceFromContext` /
  // `resolveProductFromContext`. Translate to a 400 with the same message
  // the resolver constructed (it points at the org-scoped path and the
  // /v1/lookups/*-by-slug resolver).
  if (err instanceof BareSlugRejected) {
    return c.json({ error: "bare_slug_rejected", entity: err.entity, message: err.message }, 400);
  }
  // Hono's underlying validator throws `HTTPException(400)` for malformed JSON
  // bodies (un-parseable bytes — schema-level validation goes through our
  // `validateJson` hook). Surface it in the same envelope as schema failures
  // so clients see `{ error: "bad_request", message }` consistently instead
  // of a 500 with stringified Hono internals.
  if (err instanceof HTTPException) {
    const status = err.status;
    // Forward any headers the exception attached via `new HTTPException(s, { res })`.
    // The malformed-JSON path doesn't set `res`, but middlewares that do (e.g.
    // adding a `Retry-After` to a 429, or a `Set-Cookie` rotation) would
    // otherwise lose them when we re-shape the body into our envelope.
    // Collect into a tuple list and `append` post-construction so multi-value
    // headers (notably repeated `Set-Cookie`) are preserved — a plain
    // `Record<string, string>` would collapse them.
    const passthrough: Array<[string, string]> = [];
    if (err.res) {
      err.res.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        // `c.json` sets content-type/content-length itself; let it.
        if (lower !== "content-type" && lower !== "content-length") {
          passthrough.push([key, value]);
        }
      });
    }
    const res = c.json(
      { error: status === 400 ? "bad_request" : "http_error", message: err.message },
      status,
    );
    for (const [key, value] of passthrough) {
      res.headers.append(key, value);
    }
    return res;
  }
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

// `publicReadRoutes` and `adminRoutes` are defined in route-namespaces.ts so
// the CI coverage gate (scripts/check-openapi-coverage.ts) can import them
// without pulling in the worker's `cloudflare:workers` re-exports.
for (const r of publicReadRoutes) {
  v1.use(`/${r}`, publicReadAuthMiddleware, publicRateLimitMiddleware, dbHealthCheck);
  v1.use(`/${r}/*`, publicReadAuthMiddleware, publicRateLimitMiddleware, dbHealthCheck);
}
for (const r of adminRoutes) {
  // /tokens needs a split gate: read for /tokens/me self-introspection, admin
  // for the rest. Every other admin namespace stays admin-only.
  const mw = r === "tokens" ? tokensAuthMiddleware : authMiddleware;
  v1.use(`/${r}`, mw, dbHealthCheck);
  v1.use(`/${r}/*`, mw, dbHealthCheck);
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
v1.use("/orgs/:slug/collections", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
// Catalog + org-scoped source/product GETs (#690): same cache profile as the
// bare resource routes since they hit the same handlers.
v1.use("/orgs/:slug/catalog", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use(
  "/orgs/:orgSlug/sources/:sourceSlug",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use(
  "/orgs/:orgSlug/sources/:sourceSlug/*",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
v1.use(
  "/orgs/:orgSlug/products/:productSlug",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
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
// /lookups GET endpoints — pure resolution primitives backed by indexed
// columns; cheap to compute, safe to cache. POST /v1/lookups (the on-demand
// GitHub indexer) is auth-gated and unaffected by these GET-only directives.
v1.use("/lookups/by-domain", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/lookups/source-by-slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/lookups/product-by-slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/categories", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/categories/:slug", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use(
  "/categories/:slug/releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/tags/:slug", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/collections", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/collections/:slug", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use(
  "/collections/:slug/releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/openapi.json", cacheControl(3600, { staleWhileRevalidate: 300, isPublic: true }));

// Route modules. Mount order is load-bearing (releaseRoutes before
// sourceRoutes so /releases/latest wins over the parametric /releases/:id)
// and is preserved in `mountV1Routes`. `mountOpenApi(v1)` runs at the tail
// of that call so the generator sees the complete route table.
mountV1Routes(v1);

// GraphQL spike (#TBD). Sits inside v1 so it picks up the per-route public
// middleware (rate limit, db health). publicReadAuthMiddleware is intentionally
// not applied — its POST-requires-Bearer behavior would block legitimate
// public GraphQL queries (which are POSTs by convention); admin-vs-public
// gating is resolved inside the resolver via isValidBearerAuth.
v1.use("/graphql", publicRateLimitMiddleware, dbHealthCheck);
v1.route("/", graphqlRoutes);

// Bare-API JSON index. A human or agent hitting `https://api.releases.sh/` or
// `/v1` gets a self-describing payload pointing at the OpenAPI spec, the
// rendered reference, and the human docs — instead of Hono's default text 404.
// `v1.get("/")` must be registered BEFORE `app.route("/v1", v1)` because
// Hono's `route(path, app)` snapshots `app.routes` at mount time; routes added
// to the sub-app after the mount are not picked up.
type IndexCtx = { req: { url: string } };
const apiIndexPayload = (c: IndexCtx) => {
  const origin = new URL(c.req.url).origin;
  return {
    name: "Releases API",
    version: "v1",
    description:
      "REST API for the Releases changelog registry. See the OpenAPI spec or the rendered reference for endpoint details.",
    links: {
      openapi: `${origin}/v1/openapi.json`,
      reference: `${origin}/v1/docs`,
      docs: "https://releases.sh/docs/api/rest",
      web: "https://releases.sh",
    },
  };
};
// RFC 8288 Link header advertising the OpenAPI spec via rel="service-desc"
// so agents that follow HTTP-level discovery (no body parse) find the schema.
const serviceDescLink = (origin: string) =>
  `<${origin}/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"`;
const setServiceDescLink = (c: {
  req: { url: string };
  header: (k: string, v: string) => void;
}) => {
  c.header("Link", serviceDescLink(new URL(c.req.url).origin));
};
v1.get("/", (c) => {
  setServiceDescLink(c);
  return c.json(apiIndexPayload(c));
});

app.route("/v1", v1);

app.get("/", (c) => {
  setServiceDescLink(c);
  return c.json(apiIndexPayload(c));
});

// Catch-all JSON 404 — matches the envelope used by `onError` so unknown
// paths look the same as path-known errors to clients.
app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
    },
    404,
  ),
);

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
    if (event.cron === "30 5 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "sweep-tombstones-cron",
          sweepTombstones({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            TOMBSTONE_RETENTION_DAYS: env.TOMBSTONE_RETENTION_DAYS,
            RELEASES_INDEX: env.RELEASES_INDEX,
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
    if (event.cron === "30 4 * * *") {
      // Batch-summarize cron. Gate check runs here before creating a Workflow
      // instance so no instance is spawned when the feature is off. The admin
      // POST trigger bypasses the flag and runs unconditionally.
      // The collect-eligible step also checks the flag as defense-in-depth.
      if (env.BATCH_SUMMARIZE_ENABLED !== "true") {
        logEvent("info", {
          component: "batch-summarize-cron",
          event: "disabled",
        });
        return;
      }
      if (!env.BATCH_SUMMARIZE_WORKFLOW) {
        logEvent("warn", {
          component: "batch-summarize-cron",
          event: "workflow-binding-missing",
        });
        return;
      }
      ctx.waitUntil(
        loggedDispatch(
          "batch-summarize-cron",
          env.BATCH_SUMMARIZE_WORKFLOW.create({
            id: `batch-summarize-${event.scheduledTime}`,
            params: {
              scheduledTime: event.scheduledTime,
              trigger: "cron",
              sinceDays: 1,
            },
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
        logEvent("warn", { component: "scrape-agent-cron", event: "discovery-worker-missing" });
        return;
      }
      // Feature-flag the Workflows-based path. Behavior is identical to
      // the inline sweep — the workflow resolves secrets + runs the same
      // pipeline step-by-step so a partial failure doesn't strand the
      // tail of the dispatch list. See issue #482.
      if (env.SCRAPE_AGENT_USE_WORKFLOW === "true") {
        if (!env.SCRAPE_AGENT_WORKFLOW) {
          logEvent("warn", { component: "scrape-agent-cron", event: "workflow-binding-missing" });
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
      const releasesApiKey = await getSecret(env.RELEASED_API_KEY);
      if (!releasesApiKey) {
        logEvent("warn", { component: "scrape-agent-cron", event: "api-key-missing" });
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
            ANTHROPIC_API_KEY: (await getSecret(env.ANTHROPIC_API_KEY)) ?? undefined,
            ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
            AI_GATEWAY_TOKEN:
              (await getSecret(env.AI_GATEWAY_TOKEN).catch(() => null)) ?? undefined,
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
        logEvent("warn", { component: "poll-fetch-cron", event: "workflow-binding-missing" });
        return;
      }
      ctx.waitUntil(
        loggedDispatch("poll-fetch-cron", fanOutPollAndFetch(env, event.scheduledTime), alertEnv),
      );
      return;
    }
    const githubToken = (await getSecret(env.GITHUB_TOKEN)) ?? undefined;
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
          DISCOVERY_WORKER: env.DISCOVERY_WORKER,
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
      logEvent("error", { component: tag, event: "dispatch-failed", err });
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
  const startedAt = new Date().toISOString();
  // Reserve a `running` cron_runs row up front so the dispatch is visible on
  // /status?tab=cron even if the fan-out crashes before finalize. The row is
  // updated to `done` (or `dispatch_failed`) once createBatch returns.
  const runId = await insertRunningRow(db, {
    cronName: "poll-and-fetch",
    startedAt,
  }).catch((err) => {
    logEvent("warn", {
      component: "poll-fetch-cron",
      event: "cron-run-insert-failed",
      err: err instanceof Error ? err : String(err),
      ...dbErrorLogFields(err),
    });
    return null;
  });

  let dispatched = 0;
  let dispatchErrors = 0;
  let candidates = 0;
  let preflightError: Error | null = null;
  const dispatchErrorDetail: Array<{ orgSlug: string; error: string }> = [];

  try {
    const due = await queryDueSources(db, new Date(), {
      changeDetectEnabled: env.SCRAPE_CHANGE_DETECT_ENABLED === "true",
    });
    candidates = due.length;
    if (due.length === 0) {
      logEvent("info", { component: "poll-fetch-cron", event: "no-due-sources" });
      return;
    }
    logEvent("info", { component: "poll-fetch-cron", event: "fanout", instanceCount: due.length });
    const params = due.map((source) => ({
      // Instance IDs must be unique; pairing the scheduled time with the source
      // id keeps replays from collisions across fires. See #486.
      id: `poll-fetch-${scheduledTime}-${source.id}`,
      params: { sourceId: source.id, scheduledTime },
    }));
    for (let i = 0; i < params.length; i += CREATE_BATCH_MAX) {
      const chunk = params.slice(i, i + CREATE_BATCH_MAX);
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential to stay under control-plane rate; per-instance work runs in parallel anyway
        await env.POLL_AND_FETCH_WORKFLOW!.createBatch(chunk);
        dispatched += chunk.length;
      } catch (err) {
        dispatchErrors += chunk.length;
        dispatchErrorDetail.push({
          orgSlug: `chunk-${i}`,
          error: err instanceof Error ? err.message : String(err),
        });
        logEvent("error", {
          component: "poll-fetch-cron",
          event: "createbatch-failed",
          chunkOffset: i,
          chunkSize: chunk.length,
          err: err instanceof Error ? err : String(err),
        });
      }
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
        logEvent("warn", {
          component: "poll-fetch-cron",
          event: "summary-workflow-create-failed",
          err: err instanceof Error ? err : String(err),
        });
      }
    }
  } catch (err) {
    // queryDueSources or other pre-loop work threw before any dispatch could
    // happen. Stash so the `finally` finalizes with `dispatch_failed` instead
    // of mis-marking the run `done` (dispatched=0, dispatchErrors=0).
    preflightError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    if (runId) {
      const status = preflightError
        ? ("dispatch_failed" as const)
        : dispatchErrors > 0 && dispatched === 0
          ? ("dispatch_failed" as const)
          : dispatchErrors > 0
            ? ("degraded" as const)
            : ("done" as const);
      if (preflightError) {
        dispatchErrorDetail.push({
          orgSlug: "preflight",
          error: preflightError.message,
        });
      }
      await finalizeRunRow(db, runId, {
        endedAt: new Date().toISOString(),
        status,
        candidates,
        dispatched,
        skippedOverCap: 0,
        dispatchErrors,
        sessionsStarted: [],
        dispatchErrorDetail,
        notes: preflightError ? `preflight failed: ${preflightError.message}` : null,
      }).catch((err) => {
        logEvent("warn", {
          component: "poll-fetch-cron",
          event: "cron-run-finalize-failed",
          err: err instanceof Error ? err : String(err),
        });
      });
    }
  }
}

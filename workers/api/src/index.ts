import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  authMiddleware,
  publicReadAuthMiddleware,
  tokensAuthMiddleware,
} from "./middleware/auth.js";
import type { AuthContext, AuthSessionContext } from "./middleware/auth.js";
import type { JWTVerifyGetKey } from "@releases/lib/oauth-jwt";
import {
  createAuth,
  authCorsMiddleware,
  runAuthWithWaitUntil,
  type BetterAuthInstance,
} from "./auth/index.js";
import {
  oauthSelfServiceGuard,
  OAUTH_SELF_SERVICE_WRITE_PATHS,
} from "./auth/oauth-self-service-guard.js";
import { forwardWellKnown, buildApiProtectedResourceMetadata } from "./oauth-discovery.js";
import type { AuthEmailBinding } from "./auth/email.js";
import { classifySignInFailure, redactIp, makeAuthAudit } from "./auth/audit.js";
import {
  publicRateLimitMiddleware,
  selectAuthEdgeLimiter,
  edgeRateLimitIpKey,
} from "./middleware/rate-limit.js";
import { dbHealthCheck } from "./middleware/db-health.js";
import { cacheControl } from "./middleware/cache.js";
import { edgeCache } from "./middleware/edge-cache.js";
import { varyOnAccept } from "./middleware/content-negotiation.js";
import { blockIndexing } from "./middleware/indexing.js";
import { stagingAccessGate } from "./middleware/staging-access.js";
import { mountV1Routes } from "./v1-routes.js";
import { publicReadRoutes, adminRoutes } from "./route-namespaces.js";
import { graphqlRoutes } from "./graphql/handler.js";
import { healthRoutes } from "./routes/health.js";
import { pollAndFetch, queryDueSources } from "./cron/poll-fetch.js";
import { drizzle } from "drizzle-orm/d1";
import { finalizeRunRow, insertRunningRow } from "./db/cron-runs-dao.js";
import { retierSources } from "./cron/retier.js";
import { sweepSearchQueries } from "./cron/sweep-search-queries.js";
import { sweepTombstones } from "./cron/sweep-tombstones.js";
import { scanStaleFirecrawlSources } from "./cron/firecrawl-staleness.js";
import { sendStalenessDigest } from "./cron/send-staleness-digest.js";
import { wellKnownSync } from "./cron/well-known-sync.js";
import { mobileAppDiscoverySweep } from "./cron/mobile-app-discovery.js";
import { sweepOauthClients } from "./cron/sweep-oauth-clients.js";
import { sendDigests } from "./cron/send-digests.js";
import { handleQueueBatch } from "./queues/handler.js";
import { runCollectionSummaries } from "./cron/collection-summaries.js";
import { sendAlert, type AlertEnv } from "./lib/send-alert.js";
import { respondError } from "./lib/error-response";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { getSecret } from "@releases/lib/secrets";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { NotFoundError } from "@releases/lib/releases-error";

export { StatusHub } from "./status-hub.js";
export { ReleaseHub } from "./release-hub.js";
export { SourceActor } from "./source-actor.js";
export { OrgActor } from "./org-actor.js";
export { PollAndFetchWorkflow } from "./workflows/poll-and-fetch.js";
export { OnboardSourceWorkflow } from "./workflows/onboard-source.js";
export { BatchSummarizeWorkflow } from "./workflows/batch-summarize.js";
export { OverviewRegenWorkflow } from "./workflows/overview-regen.js";
export { FirecrawlIngestWorkflow } from "./workflows/firecrawl-ingest.js";
export { BackfillSourceWorkflow } from "./workflows/backfill-source.js";
export { BatchEnrichWorkflow } from "./workflows/batch-enrich.js";
export { CollectionSummariesWorkflow } from "./workflows/collection-summaries.js";
export { MediaBackfillWorkflow } from "./workflows/media-backfill.js";

/** Cloudflare Secrets Store binding — call .get() to retrieve the secret value. */
type SecretBinding = { get(): Promise<string> };

export type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY?: SecretBinding;
    // New-prefix alias of the static root credential. Preferred over the legacy binding.
    RELEASES_API_KEY?: SecretBinding;
    // Shared secret for the web frontend's server-to-server traffic. Unlike
    // RELEASES_API_KEY this only exempts requests from the public rate limiter —
    // it does NOT unlock admin-gated content. Sent as X-Releases-Proxy-Key.
    RELEASES_PROXY_KEY?: SecretBinding;
    STATUS_HUB: DurableObjectNamespace;
    RELEASE_HUB: DurableObjectNamespace;
    // Per-source fetch-scheduling actor (#1776). When bound, a source
    // self-schedules its fetches via its own DO alarm; the hourly poll cron is a
    // re-seed heartbeat that (re-)seeds due sources' alarms. Absent ⇒ no-op.
    SOURCE_ACTOR?: DurableObjectNamespace<import("./source-actor.js").SourceActor>;
    // Per-org scrape/agent drain actor (#1777). A flagged source's SourceActor
    // arms this DO, which dispatches one /update session for the org.
    ORG_ACTOR?: DurableObjectNamespace<import("./org-actor.js").OrgActor>;
    WEBHOOK_DELIVERY_QUEUE: Queue<unknown>;
    /** Per-recipient follow digest send (cron enqueues; API worker consumes). */
    DIGEST_DELIVERY_QUEUE?: Queue<import("./queues/types.js").DigestDeliveryMessage>;
    /** Release.created fan-out before webhook-delivery (publish enqueues). */
    RELEASE_EVENTS_QUEUE?: Queue<import("./queues/types.js").ReleaseFanoutMessage>;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
    /** Scrape title-dedup kill switch (#1410); default off (i.e. dedup ON). */
    SCRAPE_TITLE_DEDUP_DISABLED?: string;
    /**
     * Cloudflare Media Transformations binding (wrangler `"media"`). Streams an
     * ingested animated GIF to a small MP4 stored in R2 (#1368). Absent → GIFs
     * stored verbatim. NOTE: deliberately a different binding NAME from the R2
     * bucket `MEDIA` above (`env.MEDIA` is the bucket; this is the transformer).
     */
    MEDIA_TRANSFORM?: import("./lib/media-ingest.js").MediaTransformBinding;
    /** GIF→MP4 ingest-transcode kill switch (#1368); default off. */
    MEDIA_GIF_TRANSCODE_ENABLED?: string;
    /** Raw page snapshots for durable backfill (#1281); pointer in source_raw_snapshots. */
    RAW_SNAPSHOTS?: R2Bucket;
    /** Routes deep Firecrawl backfills to BackfillSourceWorkflow (#1281); default off. */
    BACKFILL_WORKFLOW_ENABLED?: string;
    CACHE_DISABLED?: string;
    GITHUB_TOKEN?: SecretBinding;
    CRON_ENABLED?: string;
    // Per-source ingest engine (fetch → parse → insert), invoked by each
    // SourceActor's alarm (#1776). When this binding is absent (local dev), the
    // hourly cron falls back to inlining `pollAndFetch()` in `ctx.waitUntil`
    // instead of driving actors. See issue #486.
    POLL_AND_FETCH_WORKFLOW?: Workflow;
    // `POST /v1/sources` dispatches an `ONBOARD_SOURCE_WORKFLOW` instance for the
    // playbook + embed + backfill tail when this binding is wired (always in
    // prod), else rides `c.executionCtx.waitUntil(...)`. See issue #493.
    ONBOARD_SOURCE_WORKFLOW?: Workflow;
    // Batch summarization workflow (issue #971). Cron at 04:30 UTC; self-gates
    // via BATCH_SUMMARIZE_ENABLED. Admin POST trigger runs unconditionally.
    BATCH_SUMMARIZE_ENABLED?: string;
    BATCH_SUMMARIZE_MAX_COST_USD?: string;
    BATCH_SUMMARIZE_WORKFLOW?: Workflow;
    // OpenRouter-backed per-org overview regen (OverviewRegenWorkflow). Cron path
    // self-gates via OVERVIEW_REGEN_ENABLED; admin POST runs unconditionally.
    // Fast-tier tunables (#1895) are read by the workflow, not the handler.
    OVERVIEW_REGEN_ENABLED?: string;
    OVERVIEW_FAST_CADENCE_DAYS?: string;
    OVERVIEW_FAST_MIN_RELEASES?: string;
    OVERVIEW_REGEN_WORKFLOW?: Workflow;
    // Batch feed-content enrichment backfill (#1296). Admin POST trigger only;
    // BATCH_ENRICH_ENABLED is reserved for a future cron path. Drains the
    // render-heavy / JS-shell summary-only sources the sync route can't finish.
    BATCH_ENRICH_ENABLED?: string;
    BATCH_ENRICH_MAX_COST_USD?: string;
    BATCH_ENRICH_WORKFLOW?: Workflow;
    /** Nightly collection daily summaries (cron + admin POST). */
    COLLECTION_SUMMARIES_WORKFLOW?: Workflow;
    /** Durable media / video / gif backfill loops (admin POST). */
    MEDIA_BACKFILL_WORKFLOW?: Workflow;
    FORCE_DRAIN_STALE_HOURS?: string;
    /**
     * Service binding to the discovery worker. Typed as the RPC surface
     * (`startManagedFetchSession`) plus the standard HTTP `fetch` method used
     * by the OrgActor drain to POST `/update`. The `entrypoint:
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
    WEB_BOT_AUTH_PRIVATE_KEY?: SecretBinding;
    WEB_BOT_AUTH_ENABLED?: string;
    // Webhook delivery history queries Analytics Engine via CLOUDFLARE_* (see shared.ts).
    // Per-IP rate limiter for unauthenticated public reads (see middleware/rate-limit.ts).
    RATE_LIMIT_ENABLED?: string;
    PUBLIC_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // Per-token rate limiter for relk_ tokens, keyed by tokenId (see middleware/rate-limit.ts).
    TOKEN_RATE_LIMIT_ENABLED?: string;
    TOKEN_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // Per-account rate limiter for authenticated free accounts (relu_ + OAuth
    // JWT users), keyed by userId. Rides RATE_LIMIT_ENABLED (see middleware/rate-limit.ts).
    USER_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // KV cache of credential-validation results for the account rate-limit tier
    // (hash(credential) → {valid,userId}, ~60s TTL). Absent → verify every read.
    CREDENTIAL_CACHE?: KVNamespace;
    // Edge per-IP rate limiter sitting IN FRONT of /api/auth/* (POST only), so a
    // brute-force / credential-stuffing flood is shed at the edge before Better
    // Auth's own limiter runs — keeping that flood off the shared D1. Native
    // Cloudflare `ratelimit` binding (no D1/KV write). Kill switch defaults ON
    // (only "false" opts out); absent binding (e.g. staging) → no-op. See #1728.
    AUTH_EDGE_RATE_LIMIT_ENABLED?: string;
    AUTH_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // KV backing for Better Auth's brute-force rate-limit counters. When bound,
    // createAuth wires `rateLimit.customStorage` to this namespace so the per-key
    // counter upserts land on KV instead of the shared D1 (#1728). Absent → the
    // limiter falls back to `storage: "database"` (local dev / staging).
    AUTH_RATE_LIMIT_KV?: KVNamespace;
    // Per-IP limiter for the open POST /v1/feedback (see routes/feedback.ts).
    // Kill switch defaults ON (only "false" opts out); enforced in-handler
    // because publicRateLimitMiddleware only covers safe methods.
    FEEDBACK_RATE_LIMIT_ENABLED?: string;
    FEEDBACK_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // Per-sub / per-user caps on POST /v1/me/webhooks/:id/test (see test-rate-limit.ts).
    WEBHOOK_TEST_RATE_LIMIT_ENABLED?: string;
    WEBHOOK_TEST_SUB_RATE_LIMITER?: {
      limit(options: { key: string }): Promise<{ success: boolean }>;
    };
    WEBHOOK_TEST_USER_RATE_LIMITER?: {
      limit(options: { key: string }): Promise<{ success: boolean }>;
    };
    // Max feedback notification emails per rolling hour (default 20). Caps the
    // inbox-bomb amplification of the open endpoint; overflow rows are still
    // stored. See lib/feedback-email.ts.
    FEEDBACK_NOTIFY_MAX_PER_HOUR?: string;
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
    // Kill switch for the open POST /v1/feedback endpoint (releases feedback).
    FEEDBACK_DISABLED?: string;
    // Kill switch for the open POST /v1/recommendations endpoint.
    RECOMMENDATIONS_DISABLED?: string;
    // Max recommendation notification emails per rolling hour (default 20).
    RECOMMENDATION_NOTIFY_MAX_PER_HOUR?: string;
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
    USER_API_KEYS_ENABLED?: string;
    WELL_KNOWN_MATERIALIZATION_ENABLED?: string;
    // Mobile-app discovery sweep tunables (cron/mobile-app-discovery.ts).
    MOBILE_DISCOVERY_INTERVAL_HOURS?: string;
    MOBILE_DISCOVERY_MAX_PER_RUN?: string;
    MOBILE_DISCOVERY_MAX_APPS_PER_ORG?: string;
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
    // Stale OAuth-client reaper (nightly 07:00 UTC). Retention window in days
    // (default 30) for abandoned dynamic-registration clients; the enable flag
    // gates delete-vs-observe (fallback for `oauth-client-reaper-enabled`). See
    // workers/api/src/cron/sweep-oauth-clients.ts.
    OAUTH_CLIENT_REAPER_RETENTION_DAYS?: string;
    OAUTH_CLIENT_REAPER_ENABLED?: string;
    // Staging-only shared secret — see middleware/staging-access.ts. Absent
    // everywhere outside `[env.staging]`, so the gate no-ops for prod/local.
    STAGING_ACCESS_KEY?: SecretBinding;
    // Errata memory store ID — destination for POST /v1/errata/:orgId. See #537.
    MEMORY_STORE_ERRATA_ID?: string;
    // IndexNow integration (#649). New releases ping api.indexnow.org so search
    // engines pick up the org/source/product changes immediately. Always on now;
    // staging suppresses it via INDEXING_DISABLED, and a missing INDEXNOW_KEY is
    // a no-op. Key is hosted at https://releases.sh/{INDEXNOW_KEY}.txt by
    // web/src/proxy.ts.
    INDEXNOW_KEY?: SecretBinding;
    // Public web base URL — used by the IndexNow helper to build canonical
    // URLs. Defaults to https://releases.sh when unset.
    WEB_BASE_URL?: string;
    // Deploy-environment discriminator. Set to "production" in the top-level
    // wrangler.jsonc vars and "staging" in the env.staging block. Read by
    // /v1/graphql to gate GraphiQL + introspection. Absent in `wrangler dev`.
    ENVIRONMENT?: string;
    // Cloudflare Browser Rendering credentials for feed-content enrichment.
    // Bound via Secrets Store in Task 9 — optional here so the route degrades
    // gracefully (cheap-path-only) when absent.
    CLOUDFLARE_ACCOUNT_ID?: SecretBinding;
    CLOUDFLARE_API_TOKEN?: SecretBinding;
    // Floor length (chars) below which a feed item's content is considered thin.
    // Mirrors FetchOneEnv.FEED_THIN_CHARS; default 600 when absent.
    FEED_THIN_CHARS?: string;
    // Firecrawl integration. FIRECRAWL_API_KEY gates the monitor-sync helper;
    // FIRECRAWL_WEBHOOK_SECRET is used in Phase 2 to verify inbound webhook
    // payloads. FIRECRAWL_INGEST_WORKFLOW is bound in wrangler in Phase 2.
    FIRECRAWL_API_KEY?: SecretBinding;
    FIRECRAWL_WEBHOOK_SECRET?: SecretBinding;
    FIRECRAWL_INGEST_WORKFLOW?: Workflow; // bound in wrangler in Phase 2
    // GitHub App webhook signing secret — verifies inbound `X-Hub-Signature-256`
    // on POST /v1/integrations/github/webhook (#1698). Bound from the Secrets
    // Store; an unresolved binding fails the receiver closed (401).
    RELEASES_GITHUB_WEBHOOK_SECRET?: SecretBinding;
    // Durable backfill workflow (#1281). Routes POST /v1/workflows/backfill-source
    // to a resumable BackfillSourceWorkflow instance when BACKFILL_WORKFLOW_ENABLED=true.
    BACKFILL_SOURCE_WORKFLOW?: Workflow;
    // Hours since a firecrawl source's last run before the hourly staleness
    // scan flags it (monitor stopped delivering). Default 48. See option A.
    FIRECRAWL_STALE_HOURS?: string;
    // First-party source staleness scan (#1528): warn when an established-cadence
    // source we still poll has stopped producing. All optional with defaults
    // (floor 14d, multiplier 3×, poll-recency 3d). See cron/source-staleness.ts.
    SOURCE_STALE_FLOOR_DAYS?: string;
    SOURCE_STALE_MULTIPLIER?: string;
    SOURCE_STALE_POLL_RECENCY_DAYS?: string;
    // Cloudflare Flagship binding (prod + staging apps; absent in local dev /
    // tests → flag() falls back to the wrangler var). See @releases/lib/flags.
    FLAGS?: FlagshipBinding;
    // OpenRouter model for the large-body extraction tool-loop (issue #1536).
    // Consulted only when `openrouter-enabled` is on + OPENROUTER_API_KEY (bound
    // below) resolves; empty → extraction stays on Anthropic (fail-open). Read by
    // resolveExtractAiSdkModel in the firecrawl-ingest / backfill workflows.
    EXTRACT_MODEL?: string;
    // OpenRouter model for the shared summarization lane (release summaries AND
    // collection daily summaries); empty → stay on Anthropic Haiku. Read by
    // resolveSummarizeModel + resolveCollectionSummaryModel via TextModelEnv.
    SUMMARIZE_MODEL?: string;
    // How many recent ET days to back-fill if a summary row is missing (default 2).
    // Read by runCollectionSummaries.
    COLLECTION_SUMMARY_CATCHUP_DAYS?: string;
    // OpenRouter cheap-call lane config. OPENROUTER_API_KEY is the Secrets Store
    // binding; OPENROUTER_BASE_URL overrides the default endpoint; OPENROUTER_ENABLED
    // is the Flagship/var kill switch. Read by resolveTextModel (TextModelEnv) for
    // all secondary AI lanes: marketing-classifier, summarize, collection-summary.
    OPENROUTER_ENABLED?: string;
    OPENROUTER_API_KEY?: SecretBinding;
    OPENROUTER_BASE_URL?: string;
    // ── Better Auth (human user sessions; a separate layer from the relk_
    // machine tokens). The auth instance is served at /api/auth/* — see
    // src/auth/index.ts. ──
    // Signing secret. Cloudflare Secrets Store binding in prod; a plain string
    // is accepted too (local .dev.vars / wrangler var). Required in prod.
    BETTER_AUTH_SECRET?: SecretBinding | string;
    // Local-dev fallback for the signing secret (plain string, `.dev.vars` only).
    // The same-named Secrets Store binding above shadows a plain `BETTER_AUTH_SECRET`
    // line in `wrangler dev`, so local dev sets THIS distinct var to get a stable
    // secret. Preferred only when the binding is unresolvable; never bound in prod.
    // See resolveSigningSecret in src/auth/index.ts and issue #1425.
    BETTER_AUTH_SECRET_DEV?: string;
    // Better Auth Infrastructure ("dash") API key — connects this backend to the
    // hosted admin/analytics dashboard at dash.better-auth.com via the dash()
    // plugin. Secrets Store binding in prod; plain string locally (.dev.vars).
    // Absent → the dash plugin stays off (no keyless outbound calls). See
    // src/auth/index.ts.
    BETTER_AUTH_API_KEY?: SecretBinding | string;
    // Project-scoped Better Auth Infrastructure KV "identify" endpoint backing the
    // sentinel() security plugin, e.g. https://kv.better-auth.com/projects/<id>.
    // A plain var (a project URL, not a secret); paired with BETTER_AUTH_API_KEY —
    // sentinel() mounts only when BOTH resolve. Absent → no Sentinel checks. See
    // src/auth/index.ts.
    BETTER_AUTH_IDENTIFY_URL?: string;
    // Public base URL of THIS worker (where the auth handler lives), e.g.
    // https://api.releases.sh. Drives OAuth callback + cookie-domain derivation.
    // Local: set via .dev.vars to https://api.releases.localhost, or omit to let
    // Better Auth infer from the request.
    BETTER_AUTH_URL?: string;
    // Optional explicit cross-subdomain cookie domain (e.g. ".releases.sh").
    // Absent → derived from BETTER_AUTH_URL's host (strip the leftmost label).
    BETTER_AUTH_COOKIE_DOMAIN?: string;
    // Optional comma-separated extra trusted web origins (allowed to call the
    // auth API with credentials), on top of the releases.sh/.localhost family.
    BETTER_AUTH_TRUSTED_ORIGINS?: string;
    // Comma-separated extra `aud` values for issued OAuth access tokens (the
    // resource servers, e.g. the MCP worker). Unioned with the BETTER_AUTH_URL
    // origin by oauthValidAudiences(). Plain config, not a feature flag.
    OAUTH_RESOURCE_AUDIENCES?: string;
    // Explicit kill switch for Better Auth's brute-force rate limiting (default
    // OFF → rate limiting stays ON in prod). Set to "true" in local `.dev.vars`
    // to skip rate limiting during sign-in testing. A plain var (never a transient
    // Secrets-Store failure), so it can't silently drop protection in prod.
    AUTH_RATE_LIMIT_DISABLED?: string;
    // Social-login credentials — GATED: a provider activates only when BOTH its
    // id + secret resolve; absent → silently omitted (no crash). To enable, add
    // the matching Secrets Store binding here AND the value in the store.
    GOOGLE_CLIENT_ID?: SecretBinding | string;
    GOOGLE_CLIENT_SECRET?: SecretBinding | string;
    GITHUB_CLIENT_ID?: SecretBinding | string;
    GITHUB_CLIENT_SECRET?: SecretBinding | string;
    // Stripe (`@better-auth/stripe`) — GATED on BOTH resolving (same seam as the
    // social pairs): present → a Stripe Customer is created on sign-up and linked
    // via user.stripeCustomerId; absent either → the plugin is omitted (no Stripe
    // calls). Secrets Store bindings in prod (add them to the store + wrangler.jsonc
    // before binding — see the GitHub note there), plain strings locally (.dev.vars).
    // STRIPE_SECRET_KEY is the account API key; STRIPE_WEBHOOK_SECRET is the signing
    // secret for the /api/auth/stripe/webhook endpoint. See auth/index.ts.
    STRIPE_SECRET_KEY?: SecretBinding | string;
    STRIPE_WEBHOOK_SECRET?: SecretBinding | string;
    // Cloudflare Email Sending binding for USER-FACING auth mail (verification +
    // password reset). Object-form send → arbitrary recipients. Distinct from
    // SEND_EMAIL (Email Routing, internal-only, verified-destinations). Absent →
    // sendAuthEmail logs the link and no-ops (local `wrangler dev` simulates sends).
    AUTH_EMAIL?: AuthEmailBinding;
    // Sender address + display name for AUTH_EMAIL. Default noreply@releases.sh / "Releases".
    AUTH_EMAIL_FROM?: string;
    AUTH_EMAIL_FROM_NAME?: string;
    // Digest email sender address. Falls back to AUTH_EMAIL_FROM / noreply@releases.sh.
    DIGEST_EMAIL_FROM?: string;
    // Digest cron tunables. DIGEST_MAX_PER_RUN caps recipients processed per cron
    // fire; DIGEST_MAX_RELEASES caps releases shown per email. Both default to
    // safe values in send-digests.ts when absent.
    DIGEST_MAX_PER_RUN?: string;
    DIGEST_MAX_RELEASES?: string;
    // Public REST API origin — used to build unsubscribe URLs in digest emails.
    // Falls back to https://api.releases.sh when absent.
    API_BASE_URL?: string;
  };
  Variables: {
    auth?: AuthContext;
    session?: AuthSessionContext;
    /** Test seam: an injected Better Auth instance; real requests build one per call. */
    betterAuth?: BetterAuthInstance;
    /**
     * Test seam: a local JWKS resolver for OAuth-JWT verification. Real requests
     * leave this unset and the JWKS is fetched from the AS endpoint.
     */
    oauthJwtKeyResolver?: JWTVerifyGetKey;
  };
};

const app = new Hono<Env>();

app.onError((err, c) => respondError(c, err));

// Better Auth CORS — credentialed, first-party origins only. MUST come before
// the global wildcard `cors()` so it owns the `/api/auth/*` preflight (the first
// matching CORS middleware answers OPTIONS and returns). See src/auth/index.ts.
app.use("/api/auth/*", authCorsMiddleware());
// Session-authed self-serve surface needs the same credentialed, origin-reflecting
// CORS as /api/auth/* so the browser sends the cross-subdomain session cookie.
app.use("/v1/api-keys", authCorsMiddleware());
app.use("/v1/api-keys/*", authCorsMiddleware());
app.use("/v1/me/*", authCorsMiddleware());
app.use("/v1/workspaces", authCorsMiddleware());
app.use("/v1/workspaces/*", authCorsMiddleware());

// Public read CORS — wildcard is fine; these endpoints don't accept credentials.
// SKIP `/api/auth/*`: those routes are owned by `authCorsMiddleware` above, which
// sets a credentialed, origin-reflecting CORS header. If this wildcard `cors()`
// also ran there it would overwrite `Access-Control-Allow-Origin` with `*` on the
// actual (non-preflight) response — which browsers reject for `credentials:
// "include"` requests. The preflight passes (authCorsMiddleware short-circuits
// OPTIONS), but the real GET/POST would be blocked. Keep the two in lockstep.
// SKIP `/v1/api-keys` for the same reason — it is carved out above.
const publicReadCors = cors();
app.use("*", (c, next) =>
  c.req.path.startsWith("/api/auth/") ||
  c.req.path === "/v1/api-keys" ||
  c.req.path.startsWith("/v1/api-keys/") ||
  c.req.path.startsWith("/v1/me/") ||
  c.req.path === "/v1/workspaces" ||
  c.req.path.startsWith("/v1/workspaces/")
    ? next()
    : publicReadCors(c, next),
);
app.use("*", stagingAccessGate());
app.use("*", blockIndexing());

// Security response headers
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

// Apex OAuth/OIDC discovery aliases — public (no per-route token auth). The two
// AS-metadata aliases forward to Better Auth; the protected-resource metadata is
// the REST API's OWN RFC 9728 document — it is itself an OAuth resource server
// (#1483 verifies "Sign in with Releases" JWTs whose `aud` is this origin),
// mirroring the MCP worker's surface. See oauth-discovery.ts. CORS for these
// non-/api/auth paths is handled by the wildcard `publicReadCors` above.
app.get("/.well-known/oauth-authorization-server", async (c) =>
  forwardWellKnown(
    await createAuth(c.env),
    "oauth-authorization-server",
    c.req.url,
    c.req.raw.headers,
  ),
);
app.get("/.well-known/openid-configuration", async (c) =>
  forwardWellKnown(await createAuth(c.env), "openid-configuration", c.req.url, c.req.raw.headers),
);
// RFC 8414 §3.1 path-aware form. Our issuer carries a path component
// (`https://api.releases.sh/api/auth`), so a strict client constructs the
// metadata URL by INSERTING the well-known segment between host and path —
// `…/.well-known/oauth-authorization-server/api/auth` — rather than appending
// it. Serve those alongside the root aliases so issuer-derived discovery
// resolves either way. `forwardWellKnown` rewrites to the Better Auth path
// regardless of the inbound path, so the same handler answers both forms.
app.get("/.well-known/oauth-authorization-server/api/auth", async (c) =>
  forwardWellKnown(
    await createAuth(c.env),
    "oauth-authorization-server",
    c.req.url,
    c.req.raw.headers,
  ),
);
app.get("/.well-known/openid-configuration/api/auth", async (c) =>
  forwardWellKnown(await createAuth(c.env), "openid-configuration", c.req.url, c.req.raw.headers),
);
app.get("/.well-known/oauth-protected-resource", (c) =>
  Response.json(buildApiProtectedResourceMetadata(c.env), {
    headers: { "Cache-Control": "public, max-age=3600" },
  }),
);

// Lock the oauth-provider plugin's self-service *write* client endpoints to
// admins. The provisioning path is the root-key /v1/admin/oauth route; this
// removes the "any logged-in user can register a client" surface while leaving
// the consent-flow read endpoints (public-client*) untouched. See #1482.
for (const p of OAUTH_SELF_SERVICE_WRITE_PATHS) {
  app.use(p, oauthSelfServiceGuard());
}

// ── Better Auth ──
// Human user sessions (email/password now; Google/GitHub when their secrets are
// supplied). Served at /api/auth/* on this worker (api.releases.sh). createAuth is
// memoized per isolate; the handler wraps in runAuthWithWaitUntil for background
// work. See src/auth/index.ts.
// Runs after the "*" middleware above, so the staging gate + noindex apply.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  // Edge brute-force shedding (#1728). A credential-stuffing flood hits the
  // mutating auth endpoints (POST sign-in/sign-up/…), and Better Auth's own
  // limiter is D1-backed — so without a front gate every flood request incurs a
  // D1 read+write, write-amplifying into the shared database. Reject abusive
  // per-IP volume HERE, on Cloudflare's native limiter (no D1/KV write), before
  // we even construct the auth instance. GET (session reads like /get-session,
  // polled by the browser and often shared behind NAT) is intentionally exempt —
  // the brute-force risk and the D1-write amplification both live on the POSTs.
  // Gated by binding presence (absent in staging → no-op) + a default-ON kill
  // switch. Better Auth's per-key limiter still runs as the precise second layer.
  const authEdgeLimiter = selectAuthEdgeLimiter(
    c.req.method,
    c.env.AUTH_EDGE_RATE_LIMIT_ENABLED,
    c.env.AUTH_RATE_LIMITER,
  );
  if (authEdgeLimiter) {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
    // Key by /64 for IPv6 so a single subnet can't rotate addresses past the cap.
    const { success } = await authEdgeLimiter.limit({ key: edgeRateLimitIpKey(ip) });
    if (!success) {
      logEvent("warn", {
        component: "api",
        event: "auth_edge_rate_limited",
        path: new URL(c.req.url).pathname,
        ip: redactIp(ip),
      });
      // Mirror Better Auth's 429 shape: it sets `X-Retry-After` (which the web
      // auth-client reads) — emit that plus the standard `Retry-After`.
      return c.json({ message: "Too many requests. Please try again later." }, 429, {
        "Retry-After": "60",
        "X-Retry-After": "60",
      });
    }
  }

  // Scope executionCtx.waitUntil via AsyncLocalStorage for this handler only.
  // `c.executionCtx` throws when absent (e.g. tests) — background work then
  // falls back to Better Auth's default floating behavior.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  const auth = await createAuth(c.env);
  const res = await runAuthWithWaitUntil(waitUntil, () => auth.handler(c.req.raw));

  // Audit failed credential sign-ins. This is the ONLY place a rate-limit (429)
  // rejection is observable — it short-circuits in Better Auth's router before any
  // internal hook runs — so all sign-in failure modes are classified here from the
  // response (path + status, no body read). Successes/state-changes ride the
  // internal hooks in createAuth. Never let an audit failure break the response.
  try {
    const failure = classifySignInFailure({
      path: new URL(c.req.url).pathname,
      method: c.req.method,
      status: res.status,
    });
    if (failure) {
      makeAuthAudit(c.env)("warn", {
        event: failure.event,
        reason: failure.reason,
        ip: redactIp(c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")),
      });
    }
  } catch {
    // Audit logging is best-effort; a classification/log error must not 500 the auth flow.
  }

  return res;
});

// ── v1 REST API ──

const v1 = new Hono<Env>();

// Shared edge cache (Cache API), registered FIRST so it is the outermost v1
// middleware: it short-circuits on a cache hit before auth/rate-limit/DB run,
// and on a miss stores the response after the per-route `cacheControl(...)`
// header below has been applied. Anonymous GETs only; reuses CACHE_DISABLED as
// its kill switch. Without this the Cache-Control headers are inert at the
// edge for a Workers route (issue #1800). See middleware/edge-cache.ts.
v1.use("*", edgeCache());

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

// Self-serve API keys: per-IP limiter on the read (GET list) path for parity
// with public reads. It no-ops on POST/DELETE (non-safe methods); those are
// session-gated. (See routing.md — the session-authed self-serve bucket.)
v1.use("/api-keys", publicRateLimitMiddleware);
v1.use("/api-keys/*", publicRateLimitMiddleware);

// /me follows reads: same per-IP limiter posture as api-keys. No-ops on
// POST/DELETE (non-safe methods); those are session-gated.
v1.use("/me/follows", publicRateLimitMiddleware);
v1.use("/me/*", publicRateLimitMiddleware);

// Token-authenticated personalized feed — rate-limited but not under publicReadAuth.
v1.use("/feed/:token", publicRateLimitMiddleware);
// Token-authenticated unsubscribe — rate-limited, not under publicReadAuth.
v1.use("/digest/unsubscribe/:token", publicRateLimitMiddleware);

// Cache-Control for read-heavy GET endpoints
v1.use("/stats", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use(
  "/orgs/:slug",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/orgs/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs/:slug/heatmap", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use(
  "/orgs/:slug/releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/orgs/:slug/accounts", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs/:slug/collections", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
// Non-personalized org-scoped reads that were missing a Cache-Control while
// their single-entity/org-scoped siblings had one (#1800 Tier 2).
v1.use(
  "/orgs/:slug/recent-releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
v1.use("/orgs/:slug/tags", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs/:slug/sparklines", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/orgs/:slug/products", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
// AI-generated org overview — identical for every visitor until the next
// regen, the only headline-content read that was uncached (#1800 finding 1).
v1.use("/orgs/:slug/overview", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
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
v1.use("/sources/:slug/heatmap", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
// Per-source feeds/changelog — public, JSON-only (no markdown negotiation, so
// no varyOnAccept); their org-scoped twins are already cached via the
// /orgs/:orgSlug/sources/:sourceSlug/* wildcard (#1800 Tier 2).
v1.use("/sources/:slug/releases", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/sources/:slug/changelog", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use(
  "/sources/:slug/recent-releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
v1.use(
  "/sources/:slug/known-releases",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
v1.use("/search", cacheControl(30, { staleWhileRevalidate: 30, isPublic: true }), varyOnAccept());
v1.use("/related/*", cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }));
// Single-release detail: same 60s/SWR-30 profile as the other single-entity
// reads (/orgs/:slug, /sources/:slug, /products/:slug). The old 120s/SWR-60
// let downstream caches serve up to ~3 minutes of staleness right after
// generate-content / PATCH wrote title_short/summary (#1580). There is no
// worker-side cache to bust — this header IS the freshness contract.
v1.use(
  "/releases/:id",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
  varyOnAccept(),
);
v1.use("/status/fetch-log", cacheControl(15));
v1.use("/status/usage", cacheControl(30));
v1.use("/products", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/products/:slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/products/:slug/activity", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
v1.use("/products/:slug/heatmap", cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }));
// Non-personalized product-scoped reads missing a Cache-Control (#1800 Tier 2).
v1.use(
  "/products/:slug/collections",
  cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }),
);
v1.use(
  "/products/:identifier/tags",
  cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }),
);
// AI-generated product overview — same shared-content profile as its sibling
// /orgs/:slug/overview (#1800 finding 1).
v1.use("/products/:slug/overview", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use(
  "/orgs/:orgSlug/products/:productSlug/activity",
  cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }),
);
// Match the bare /products/:slug/heatmap 120s profile — without this explicit
// entry the org-scoped twin falls through to the 60s /* wildcard below, so the
// same data had two lifetimes by URL shape (#1800 TTL drift). Must precede the
// wildcard: cacheControl no-ops once a Cache-Control header is already set.
v1.use(
  "/orgs/:orgSlug/products/:productSlug/heatmap",
  cacheControl(120, { staleWhileRevalidate: 60, isPublic: true }),
);
v1.use(
  "/orgs/:orgSlug/products/:productSlug/*",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
v1.use("/sitemap", cacheControl(600, { staleWhileRevalidate: 600, isPublic: true }));
// /lookups GET endpoints — pure resolution primitives backed by indexed
// columns; cheap to compute, safe to cache. POST /v1/lookups (the on-demand
// GitHub indexer) is auth-gated and unaffected by these GET-only directives.
v1.use("/lookups/by-domain", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/lookups/source-by-slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
v1.use("/lookups/product-by-slug", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
// Pure resolution primitive over indexed columns, same class as the three
// lookup siblings above — was the only one uncached (#1800 Tier 2).
v1.use(
  "/lookups/source-by-coordinate",
  cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }),
);
// whats-changed reads already-ingested releases — cacheable like the other
// public read primitives; the (package, from, to) range is deterministic.
v1.use("/whats-changed", cacheControl(60, { staleWhileRevalidate: 30, isPublic: true }));
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
// Written once/day by the collection-summaries cron — static for ~24h and
// fully shared, yet was uncached (#1800 finding 2).
v1.use(
  "/collections/:slug/daily-summaries",
  cacheControl(300, { staleWhileRevalidate: 60, isPublic: true }),
);
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

// /feedback is an open POST (like /telemetry). publicRateLimitMiddleware only
// covers safe methods, so rate limiting for this POST lives in the handler
// (FEEDBACK_RATE_LIMITER, per-IP). dbHealthCheck guards the D1 insert.
v1.use("/feedback", dbHealthCheck);
// …but the triage write-path (/feedback/:id — PATCH/DELETE) is admin-only,
// mirroring the /v1/admin/feedback read-back. Only the sub-paths are gated; the
// bare /feedback above stays open. Strict CORS like the other admin paths.
v1.use("/feedback/*", adminCors, authMiddleware, dbHealthCheck);

// /recommendations mirrors /feedback: bare POST is open with in-handler
// rate limiting; sub-path triage operations are admin-only.
v1.use("/recommendations", dbHealthCheck);
v1.use("/recommendations/*", adminCors, authMiddleware, dbHealthCheck);

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

// Top-level liveness/readiness probe (status.releases.sh). Outside /v1 so it
// skips the per-route public-read auth + rate-limit middleware.
app.route("/", healthRoutes);

app.get("/", (c) => {
  setServiceDescLink(c);
  return c.json(apiIndexPayload(c));
});

// Catch-all JSON 404 — matches the envelope used by `onError` so unknown
// paths look the same as path-known errors to clients.
app.notFound((c) =>
  respondError(c, new NotFoundError(`No route for ${c.req.method} ${new URL(c.req.url).pathname}`)),
);

export default {
  fetch: app.fetch,
  async queue(
    batch: MessageBatch<
      | import("./queues/types.js").DigestDeliveryMessage
      | import("./queues/types.js").ReleaseFanoutMessage
    >,
    env: Env["Bindings"],
  ): Promise<void> {
    await handleQueueBatch(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env["Bindings"], ctx: ExecutionContext) {
    // Daily retier runs at 03:00 UTC; the source staleness digest at 04:00 UTC;
    // search-queries retention at 05:00 UTC; poll-and-fetch hourly.
    // Build the alert env once for cron dispatches.
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
    if (event.cron === "0 6 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "well-known-sync-cron",
          wellKnownSync({
            DB: env.DB,
            MEDIA: env.MEDIA,
            MEDIA_ORIGIN: env.MEDIA_ORIGIN,
            CRON_ENABLED: env.CRON_ENABLED,
            FLAGS: env.FLAGS,
            WELL_KNOWN_MATERIALIZATION_ENABLED: env.WELL_KNOWN_MATERIALIZATION_ENABLED,
            GITHUB_TOKEN: env.GITHUB_TOKEN,
          }),
          alertEnv,
        ),
      );
      return;
    }
    if (event.cron === "30 6 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "mobile-app-discovery-cron",
          mobileAppDiscoverySweep({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            FLAGS: env.FLAGS,
            WELL_KNOWN_MATERIALIZATION_ENABLED: env.WELL_KNOWN_MATERIALIZATION_ENABLED,
            MOBILE_DISCOVERY_INTERVAL_HOURS: env.MOBILE_DISCOVERY_INTERVAL_HOURS,
            MOBILE_DISCOVERY_MAX_PER_RUN: env.MOBILE_DISCOVERY_MAX_PER_RUN,
            MOBILE_DISCOVERY_MAX_APPS_PER_ORG: env.MOBILE_DISCOVERY_MAX_APPS_PER_ORG,
          }),
          alertEnv,
        ),
      );
      return;
    }
    if (event.cron === "15 6 * * *") {
      if (env.CRON_ENABLED === "false") return;
      const collectionSummariesEnv = {
        DB: env.DB,
        CRON_ENABLED: env.CRON_ENABLED,
        COLLECTION_SUMMARY_CATCHUP_DAYS: env.COLLECTION_SUMMARY_CATCHUP_DAYS,
        SUMMARIZE_MODEL: env.SUMMARIZE_MODEL,
        ENVIRONMENT: env.ENVIRONMENT,
        FLAGS: env.FLAGS,
        OPENROUTER_ENABLED: env.OPENROUTER_ENABLED,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
        AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
      };
      if (env.COLLECTION_SUMMARIES_WORKFLOW) {
        ctx.waitUntil(
          loggedDispatch(
            "collection-summaries-cron",
            env.COLLECTION_SUMMARIES_WORKFLOW.create({
              id: `collection-summaries-${event.scheduledTime}`,
              params: {
                scheduledTime: event.scheduledTime,
                trigger: "cron" as const,
              },
            }),
            alertEnv,
          ),
        );
      } else {
        ctx.waitUntil(
          loggedDispatch(
            "collection-summaries-cron",
            runCollectionSummaries(collectionSummariesEnv, new Date(event.scheduledTime)),
            alertEnv,
          ),
        );
      }
      return;
    }
    if (event.cron === "0 7 * * *") {
      ctx.waitUntil(
        loggedDispatch(
          "sweep-oauth-clients-cron",
          sweepOauthClients({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            FLAGS: env.FLAGS,
            OAUTH_CLIENT_REAPER_ENABLED: env.OAUTH_CLIENT_REAPER_ENABLED,
            OAUTH_CLIENT_REAPER_RETENTION_DAYS: env.OAUTH_CLIENT_REAPER_RETENTION_DAYS,
          }),
          alertEnv,
        ),
      );
      return;
    }
    // Daily (`0 13 * * *`) and weekly-Monday (`0 13 * * MON`) digests are delivered
    // as separate scheduled events with distinct cron strings, so on Mondays both
    // fire — each targets its own cadence's subscribers. The weekly entry uses the
    // named weekday: Cloudflare cron numbers weekdays 1=Sunday..7=Saturday, so the
    // old `0 13 * * 1` fired Sundays (#1796).
    if (event.cron === "0 13 * * *" || event.cron === "0 13 * * MON") {
      const cadence = event.cron === "0 13 * * MON" ? "weekly" : "daily";
      ctx.waitUntil(
        loggedDispatch(
          `digest-${cadence}-cron`,
          sendDigests(
            {
              DB: env.DB,
              AUTH_EMAIL: env.AUTH_EMAIL,
              DIGEST_DELIVERY_QUEUE: env.DIGEST_DELIVERY_QUEUE,
              DIGEST_EMAIL_FROM: env.DIGEST_EMAIL_FROM,
              WEB_BASE_URL: env.WEB_BASE_URL,
              MEDIA_ORIGIN: env.MEDIA_ORIGIN,
              CRON_ENABLED: env.CRON_ENABLED,
              DIGEST_MAX_PER_RUN: env.DIGEST_MAX_PER_RUN,
              DIGEST_MAX_RELEASES: env.DIGEST_MAX_RELEASES,
              API_BASE_URL: env.API_BASE_URL,
              ENVIRONMENT: env.ENVIRONMENT,
            },
            { cadence, runStart: new Date(event.scheduledTime) },
          ),
          alertEnv,
        ),
      );
      return;
    }
    if (event.cron === "0 4 * * *") {
      // Source staleness digest (#1528): first-party + Firecrawl scans, emailed
      // to the operator when anything is overdue. Runs daily, an hour after the
      // retier (0 3) so medianGapDays are fresh. Hourly firecrawl scan still
      // logs between digests for faster observability.
      ctx.waitUntil(
        loggedDispatch(
          "staleness-digest-cron",
          sendStalenessDigest({
            DB: env.DB,
            CRON_ENABLED: env.CRON_ENABLED,
            SOURCE_STALE_FLOOR_DAYS: env.SOURCE_STALE_FLOOR_DAYS,
            SOURCE_STALE_MULTIPLIER: env.SOURCE_STALE_MULTIPLIER,
            SOURCE_STALE_POLL_RECENCY_DAYS: env.SOURCE_STALE_POLL_RECENCY_DAYS,
            FIRECRAWL_STALE_HOURS: env.FIRECRAWL_STALE_HOURS,
            FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,
            SEND_EMAIL: env.SEND_EMAIL,
            EMAIL_NOTIFY_ENABLED: env.EMAIL_NOTIFY_ENABLED,
            EMAIL_NOTIFY_TO: env.EMAIL_NOTIFY_TO,
            EMAIL_FROM: env.EMAIL_FROM,
            WEB_BASE_URL: env.WEB_BASE_URL,
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
      if (!(await flag(env.FLAGS, env.BATCH_SUMMARIZE_ENABLED, FLAGS.batchSummarizeEnabled))) {
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
    if (event.cron === "0 8 * * *") {
      if (env.CRON_ENABLED === "false") return;
      if (!(await flag(env.FLAGS, env.OVERVIEW_REGEN_ENABLED, FLAGS.overviewRegenEnabled))) {
        logEvent("info", { component: "overview-regen-cron", event: "disabled" });
        return;
      }
      if (!env.OVERVIEW_REGEN_WORKFLOW) {
        logEvent("warn", { component: "overview-regen-cron", event: "workflow-binding-missing" });
        return;
      }
      ctx.waitUntil(
        loggedDispatch(
          "overview-regen-cron",
          env.OVERVIEW_REGEN_WORKFLOW.create({
            id: `overview-regen-${event.scheduledTime}`,
            params: { scheduledTime: event.scheduledTime, trigger: "cron" },
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
    // Resilience: on every hourly fire, flag firecrawl-owned sources whose
    // monitor has stopped delivering (out of credits / suspended / failing
    // workflow). Cheap scan over the ~handful of firecrawl sources; emits warn
    // events on the `firecrawl-staleness` component. No-ops when CRON_ENABLED is
    // "false". See resilience option A.
    ctx.waitUntil(
      loggedDispatch(
        "firecrawl-staleness-cron",
        scanStaleFirecrawlSources({
          DB: env.DB,
          CRON_ENABLED: env.CRON_ENABLED,
          FIRECRAWL_STALE_HOURS: env.FIRECRAWL_STALE_HOURS,
          FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,
        }),
        alertEnv,
      ),
    );

    // Actor-driven path whenever the ingest-workflow binding is wired (always in
    // prod): the cron is a re-seed heartbeat that ensures each due source's
    // SourceActor has a pending alarm; the actor itself runs the ingest workflow.
    // The inline `pollAndFetch` below stays as the fallback when the binding is
    // absent (local dev, no DO infra). See issues #486 and #1776.
    if (env.POLL_AND_FETCH_WORKFLOW) {
      ctx.waitUntil(loggedDispatch("poll-fetch-cron", fanOutPollAndFetch(env), alertEnv));
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
          // Without these the inline-cron fallback (no POLL_AND_FETCH_WORKFLOW
          // binding) would fetch unsigned even when signing is enabled.
          WEB_BOT_AUTH_ENABLED: env.WEB_BOT_AUTH_ENABLED,
          WEB_BOT_AUTH_PRIVATE_KEY: env.WEB_BOT_AUTH_PRIVATE_KEY,
          FLAGS: env.FLAGS,
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

// Bounded concurrency for seeding SourceActor alarms from the cron heartbeat —
// polite on the DO control plane; the per-source work runs in its own object.
const SOURCE_ACTOR_ENSURE_CONCURRENCY = 20;

/**
 * Re-seed heartbeat for the per-source SourceActor DOs (#1776). Queries due
 * sources and, for each, calls `ensureScheduled` — an idempotent no-op when the
 * actor already has a pending alarm, and a re-seed for one whose alarm was
 * cleared (paused / org-paused / firecrawl via `noReschedule`). The actor's own
 * alarm re-reads D1 and runs the ingest workflow; the cron never fetches here.
 */
async function fanOutPollAndFetch(env: Env["Bindings"]): Promise<void> {
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

  let seeded = 0;
  let ensureErrors = 0;
  let candidates = 0;
  let preflightError: Error | null = null;
  const dispatchErrorDetail: Array<{ orgSlug: string; error: string }> = [];

  try {
    const dueAll = await queryDueSources(db, new Date(), { changeDetectEnabled: true });
    candidates = dueAll.length;
    if (dueAll.length === 0) {
      logEvent("info", { component: "poll-fetch-cron", event: "no-due-sources" });
      return;
    }

    // SourceActor heartbeat (#1776): every source self-schedules via its own DO
    // alarm; this cron just (re-)seeds a due source's alarm when it has none
    // pending (idempotent). A source that hit `noReschedule` (paused / org-paused
    // / firecrawl) deleted its alarm, so the heartbeat is what re-seeds it once it
    // is due again. Binding absent ⇒ nothing to drive (no cron-driven fallback).
    if (!env.SOURCE_ACTOR) {
      logEvent("warn", {
        component: "poll-fetch-cron",
        event: "source-actor-binding-absent",
        candidates,
      });
      return;
    }
    const actor = env.SOURCE_ACTOR;
    logEvent("info", {
      component: "poll-fetch-cron",
      event: "source-actor-heartbeat",
      due: dueAll.length,
    });
    // Idempotent bootstrap/heartbeat: seed each due source's actor if it has no
    // pending alarm. Bounded concurrency to stay polite on the DO control plane;
    // failures are per-source and non-fatal (the next hourly cron retries).
    for (let i = 0; i < dueAll.length; i += SOURCE_ACTOR_ENSURE_CONCURRENCY) {
      const batch = dueAll.slice(i, i + SOURCE_ACTOR_ENSURE_CONCURRENCY);
      // oxlint-disable-next-line no-await-in-loop -- bounded waves; each wave runs in parallel
      await Promise.all(
        batch.map((s) =>
          actor
            .getByName(s.id)
            .ensureScheduled(s.id)
            .then(() => {
              seeded += 1;
            })
            .catch((err: unknown) => {
              ensureErrors += 1;
              dispatchErrorDetail.push({
                orgSlug: s.orgId ?? "unknown",
                error: `ensure ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
              });
              logEvent("warn", {
                component: "poll-fetch-cron",
                event: "source-actor-ensure-failed",
                sourceId: s.id,
                err: err instanceof Error ? err.message : String(err),
              });
            }),
        ),
      );
    }
  } catch (err) {
    // queryDueSources or other pre-loop work threw before any dispatch could
    // happen. Stash so the `finally` finalizes with `dispatch_failed` instead
    // of mis-marking the run `done` (dispatched=0, dispatchErrors=0).
    preflightError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    if (runId) {
      // Heartbeat health: an actor-seed failure degrades the run so a persistent
      // seeding problem is visible on /status?tab=cron instead of finalizing `done`.
      const status = preflightError
        ? ("dispatch_failed" as const)
        : ensureErrors > 0
          ? ("degraded" as const)
          : ("done" as const);
      if (preflightError) {
        dispatchErrorDetail.push({
          orgSlug: "preflight",
          error: preflightError.message,
        });
      }
      const notes = preflightError
        ? `preflight failed: ${preflightError.message}`
        : ensureErrors > 0
          ? `${ensureErrors} source-actor ensure failure(s)`
          : null;
      await finalizeRunRow(db, runId, {
        endedAt: new Date().toISOString(),
        status,
        candidates,
        dispatched: seeded,
        skippedOverCap: 0,
        dispatchErrors: ensureErrors,
        sessionsStarted: [],
        dispatchErrorDetail,
        notes,
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

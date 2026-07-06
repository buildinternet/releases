/**
 * Mounts every route module onto a v1 Hono router. Split out of `index.ts` so
 * `scripts/check-openapi-coverage.ts` can introspect the registered routes
 * without dragging in the worker's `cloudflare:workers` re-exports (Durable
 * Objects + Workflows), which Bun can't resolve outside the Workers runtime.
 *
 * Only route mounting lives here — middleware (auth, rate-limit, CORS,
 * cache-control, etc.) and worker plumbing (`fetch`, `scheduled`, DOs)
 * stay in `index.ts`.
 */
import type { Hono } from "hono";
import type { Env } from "./index.js";
import { statsRoutes } from "./routes/stats.js";
import { siteNoticeRoutes } from "./routes/site-notice.js";
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
import { adminOverviewsRoutes } from "./routes/admin-overviews.js";
import { adminSourcesRoutes } from "./routes/admin-sources.js";
import { adminOrgDependentsRoutes } from "./routes/admin-org-dependents.js";
import { adminOrgsRoutes } from "./routes/admin-orgs.js";
import { adminBatchRunsRoutes } from "./routes/admin-batch-runs.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { adminDigestRoutes } from "./routes/admin-digest.js";
import { adminEmailsRoutes } from "./routes/admin-emails.js";
import { adminOauthRoutes } from "./routes/admin-oauth.js";
import { errataRoutes } from "./routes/errata.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { workflowsRoutes } from "./routes/workflows.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { adminFeedbackRoutes } from "./routes/admin-feedback.js";
import { recommendationRoutes } from "./routes/recommendations.js";
import { adminRecommendationRoutes } from "./routes/admin-recommendations.js";
import { taxonomyRoutes } from "./routes/taxonomy.js";
import { collectionRoutes } from "./routes/collections.js";
import { apiTokenRoutes } from "./routes/api-tokens.js";
import { userApiKeyRoutes } from "./routes/user-api-keys.js";
import { meRoutes } from "./routes/me.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { feedRoutes } from "./routes/feed.js";
import { digestRoutes } from "./routes/digest.js";
import { changelogRoutes } from "./routes/changelog.js";
import { whatsChangedRoutes } from "./routes/whats-changed.js";
import { firecrawlRoutes } from "./routes/firecrawl.js";
import { githubRoutes } from "./routes/github.js";
import { listingRoutes } from "./routes/listing.js";
import { mountOpenApi } from "./openapi.js";

/**
 * Mount order is load-bearing: `releaseRoutes` ships a static
 * `/releases/latest` handler that must register before `sourceRoutes`'
 * parametric `/releases/:id` so the static segment wins regardless of
 * router internals. Keep that ordering intact.
 */
export function mountV1Routes(v1: Hono<Env>) {
  v1.route("/", statusRoutes);
  v1.route("/", mediaRoutes);
  v1.route("/", streamRoutes);
  mountWebhooksReplay(v1, (c) => c.env);
  v1.route("/", sessionRoutes);
  v1.route("/", statsRoutes);
  v1.route("/", siteNoticeRoutes);
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
  v1.route("/", adminOverviewsRoutes);
  v1.route("/", adminSourcesRoutes);
  v1.route("/", adminOrgDependentsRoutes);
  v1.route("/", adminOrgsRoutes);
  v1.route("/", adminBatchRunsRoutes);
  v1.route("/", adminUsersRoutes);
  v1.route("/", adminDigestRoutes);
  v1.route("/", adminEmailsRoutes);
  v1.route("/", adminOauthRoutes);
  v1.route("/", errataRoutes);
  v1.route("/", webhooksRoutes);
  v1.route("/", workflowsRoutes);
  v1.route("/", telemetryRoutes);
  v1.route("/", feedbackRoutes);
  v1.route("/", adminFeedbackRoutes);
  v1.route("/", recommendationRoutes);
  v1.route("/", adminRecommendationRoutes);
  v1.route("/", taxonomyRoutes);
  v1.route("/", collectionRoutes);
  v1.route("/", apiTokenRoutes);
  v1.route("/", userApiKeyRoutes);
  v1.route("/", meRoutes);
  v1.route("/", workspaceRoutes);
  v1.route("/", feedRoutes);
  v1.route("/", digestRoutes);
  v1.route("/", changelogRoutes);
  v1.route("/", whatsChangedRoutes);
  v1.route("/", firecrawlRoutes);
  v1.route("/", githubRoutes);
  v1.route("/", listingRoutes);
  // `graphqlRoutes` is intentionally NOT mounted here — it carries its own
  // dedicated middleware sandwich in `index.ts` (publicRateLimit + dbHealth,
  // no publicReadAuth) and isn't under any namespace the OpenAPI gate cares
  // about, so the script doesn't need it.
  mountOpenApi(v1);
}

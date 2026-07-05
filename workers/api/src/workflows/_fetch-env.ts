/**
 * Single source of truth for building the `FetchOneEnv` that workflow ingest
 * paths hand to `fetchOne`. Both the poll-and-fetch and onboard-source workflows
 * (and, transitively, backfill-source / firecrawl-ingest) forward the identical
 * set of bindings, so the mapping lives here once.
 *
 * History: this was duplicated across two `resolveFetchEnv` copies, and one drop
 * (the Anthropic key + FEED_ENRICH_* vars) silently disabled ingest-time feed
 * enrichment + the marketing classifier in production — every forwarded field is
 * optional on `FetchOneEnv`, so the omission type-checked. Consolidating removes
 * the drift surface: a new forwarded binding is added in one place.
 */
import { getSecret } from "@releases/lib/secrets";
import type { MediaTransformBinding } from "../lib/media-ingest.js";
import type { FetchOneEnv } from "../cron/poll-fetch.js";
import type { AnthropicEnv } from "../lib/anthropic.js";
import type { InvalidationEnv } from "../lib/latest-cache.js";

/**
 * The workflow-env fields forwarded into a `FetchOneEnv`. `FLAGS` rides on
 * `InvalidationEnv`; the Anthropic key + gateway opts ride on `AnthropicEnv`.
 * Every field is optional, so any concrete workflow env (PollAndFetchWorkflowEnv,
 * OnboardSourceWorkflowEnv, …) is structurally assignable.
 */
export interface WorkflowFetchEnv extends InvalidationEnv, AnthropicEnv {
  GITHUB_TOKEN?: { get(): Promise<string> };
  RELEASES_INDEX?: unknown;
  CHANGELOG_CHUNKS_INDEX?: unknown;
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: { get(): Promise<string> };
  OPENAI_API_KEY?: { get(): Promise<string> };
  RELEASE_HUB?: DurableObjectNamespace;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  DB?: D1Database;
  // Deterministic-update dispatch bindings (#1946): summary-only crawl-enabled
  // feeds delegate through startDeterministicUpdate, which needs the workflow
  // binding, the per-source lock DO, StatusHub, and the spend-cap/kill-switch
  // levers (LATEST_CACHE + FLAGS ride on InvalidationEnv above).
  DETERMINISTIC_UPDATE_WORKFLOW?: Workflow;
  SOURCE_ACTOR?: DurableObjectNamespace;
  STATUS_HUB?: DurableObjectNamespace;
  MA_SESSIONS_DISABLED?: string;
  MA_DAILY_SPEND_CAP_ORG_CENTS?: string;
  MA_DAILY_SPEND_CAP_GLOBAL_CENTS?: string;
  WEB_BOT_AUTH_ENABLED?: string;
  WEB_BOT_AUTH_PRIVATE_KEY?: { get(): Promise<string> };
  MEDIA?: R2Bucket;
  MEDIA_TRANSFORM?: MediaTransformBinding;
  MEDIA_GIF_TRANSCODE_ENABLED?: string;
  FEED_ENRICH_ENABLED?: string;
  FEED_ENRICH_MAX_PER_FIRE?: string;
  FEED_THIN_CHARS?: string;
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string> };
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string> };
}

/**
 * The forwarded fields whose silent omission disables an ingest-time AI pass:
 * the Anthropic client inputs (enrichment + marketing classifier), the
 * feed-enrich tuning vars, and the Browser-Rendering creds enrichment escalates
 * with. This is the exact set the original drop no-opped, and the set the
 * `*-resolve-env` regression tests pin.
 */
type AiCriticalFetchKeys =
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_BASE_URL"
  | "AI_GATEWAY_TOKEN"
  | "FEED_ENRICH_ENABLED"
  | "FEED_ENRICH_MAX_PER_FIRE"
  | "FEED_THIN_CHARS"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN";

/**
 * `FetchOneEnv` with the AI-critical keys promoted from optional to required —
 * `-?` forces each KEY to appear in the builder's return literal (dropping a
 * line is a compile error), while `| undefined` preserves fail-open: the binding
 * itself may still resolve to undefined at runtime. Note this is deliberately
 * NOT `Required<Pick<…>>`, which would strip `undefined` from the VALUE and
 * reject the genuinely-optional source bindings the builder forwards.
 */
type GuardedFetchOneEnv = FetchOneEnv & {
  [K in AiCriticalFetchKeys]-?: FetchOneEnv[K] | undefined;
};

/**
 * Project a workflow env down to the `FetchOneEnv` slice. The only async work is
 * resolving the GitHub token secret; everything else is a binding hand-off. Keep
 * the field list exhaustive — a dropped binding silently no-ops the corresponding
 * ingest-time AI pass (see the module header). The {@link GuardedFetchOneEnv}
 * return type turns dropping one of the AI-critical bindings into a compile
 * error rather than a silent prod regression.
 */
export async function buildFetchOneEnv(env: WorkflowFetchEnv): Promise<GuardedFetchOneEnv> {
  const githubToken = (await getSecret(env.GITHUB_TOKEN).catch(() => null)) ?? undefined;
  return {
    GITHUB_TOKEN: githubToken,
    RELEASES_INDEX: env.RELEASES_INDEX,
    CHANGELOG_CHUNKS_INDEX: env.CHANGELOG_CHUNKS_INDEX,
    EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
    VOYAGE_API_KEY: env.VOYAGE_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    RELEASE_HUB: env.RELEASE_HUB,
    WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
    DB: env.DB,
    DETERMINISTIC_UPDATE_WORKFLOW: env.DETERMINISTIC_UPDATE_WORKFLOW,
    SOURCE_ACTOR: env.SOURCE_ACTOR,
    STATUS_HUB: env.STATUS_HUB,
    LATEST_CACHE: env.LATEST_CACHE,
    MA_SESSIONS_DISABLED: env.MA_SESSIONS_DISABLED,
    MA_DAILY_SPEND_CAP_ORG_CENTS: env.MA_DAILY_SPEND_CAP_ORG_CENTS,
    MA_DAILY_SPEND_CAP_GLOBAL_CENTS: env.MA_DAILY_SPEND_CAP_GLOBAL_CENTS,
    WEB_BOT_AUTH_ENABLED: env.WEB_BOT_AUTH_ENABLED,
    WEB_BOT_AUTH_PRIVATE_KEY: env.WEB_BOT_AUTH_PRIVATE_KEY,
    MEDIA: env.MEDIA,
    MEDIA_TRANSFORM: env.MEDIA_TRANSFORM,
    MEDIA_GIF_TRANSCODE_ENABLED: env.MEDIA_GIF_TRANSCODE_ENABLED,
    FLAGS: env.FLAGS,
    // Anthropic key + gateway opts (ingest-time enrichment / marketing classifier
    // build their client from these) and the feed-enrich tuning + render creds.
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
    FEED_ENRICH_ENABLED: env.FEED_ENRICH_ENABLED,
    FEED_ENRICH_MAX_PER_FIRE: env.FEED_ENRICH_MAX_PER_FIRE,
    FEED_THIN_CHARS: env.FEED_THIN_CHARS,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
  };
}

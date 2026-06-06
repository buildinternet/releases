/**
 * Worker-safe feature-flag helper backed by Cloudflare Flagship, with a layered
 * fallback to the existing wrangler vars. No `fs`/Node imports — safe in workers.
 *
 * Evaluation order: Flagship value (if the flag exists in the app) → the wrangler
 * var → the hardcoded default. Any binding-missing or eval error collapses to the
 * var/default, so a Flagship outage is strictly "behaves like today", never worse.
 *
 * The helper takes the var *value* (a typed `string | undefined` field) rather
 * than the whole env, because worker `Env` interfaces hold non-string bindings
 * and are not assignable to a string-record.
 */

/** Minimal shape of the native Flagship Workers binding (avoids an npm dep). */
export interface FlagshipBinding {
  getBooleanValue(
    key: string,
    defaultValue: boolean,
    context?: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface FlagDef {
  /** Flagship flag key (kebab-case). MUST exist identically in BOTH apps. */
  readonly key: string;
  /** wrangler-var name that supplies the fallback value (documentation + tests). */
  readonly env: string;
  /** Hardcoded last-resort default when neither Flagship nor the var is set. */
  readonly default: boolean;
}

/**
 * Registry of every Tier-1 flag. Single source of truth: the same `key`s must be
 * created in both the prod and staging Flagship apps before a flag is relied on.
 * Kill-switch flags whose absence should mean "feature on" must set `default: true`.
 */
export const FLAGS = {
  pollFetchUseWorkflow: {
    key: "poll-fetch-use-workflow",
    env: "POLL_FETCH_USE_WORKFLOW",
    default: false,
  },
  scrapeAgentUseWorkflow: {
    key: "scrape-agent-use-workflow",
    env: "SCRAPE_AGENT_USE_WORKFLOW",
    default: false,
  },
  onboardUseWorkflow: { key: "onboard-use-workflow", env: "ONBOARD_USE_WORKFLOW", default: false },
  mediaR2UploadEnabled: {
    key: "media-r2-upload-enabled",
    env: "MEDIA_R2_UPLOAD_ENABLED",
    default: false,
  },
  mediaGifTranscodeEnabled: {
    key: "media-gif-transcode-enabled",
    env: "MEDIA_GIF_TRANSCODE_ENABLED",
    default: false,
  },
  feedEnrichEnabled: { key: "feed-enrich-enabled", env: "FEED_ENRICH_ENABLED", default: false },
  scrapeChangeDetectEnabled: {
    key: "scrape-change-detect-enabled",
    env: "SCRAPE_CHANGE_DETECT_ENABLED",
    default: false,
  },
  // Kill switch (#1410): scrape-source title-dedup is ON by default (default:false
  // → not disabled); flip to true in Flagship to roll back. Collapses same-source
  // same-normalized-title rows that anchor URLs (`<page>#<slug>`) fail to dedup.
  scrapeTitleDedupDisabled: {
    key: "scrape-title-dedup-disabled",
    env: "SCRAPE_TITLE_DEDUP_DISABLED",
    default: false,
  },
  webBotAuthEnabled: { key: "web-bot-auth-enabled", env: "WEB_BOT_AUTH_ENABLED", default: false },
  invalidationEnabled: { key: "invalidation-enabled", env: "INVALIDATION_ENABLED", default: false },
  indexnowEnabled: { key: "indexnow-enabled", env: "INDEXNOW_ENABLED", default: false },
  enableAiTools: { key: "enable-ai-tools", env: "ENABLE_AI_TOOLS", default: false },
  maSessionsDisabled: { key: "ma-sessions-disabled", env: "MA_SESSIONS_DISABLED", default: false },
  batchSummarizeEnabled: {
    key: "batch-summarize-enabled",
    env: "BATCH_SUMMARIZE_ENABLED",
    default: false,
  },
  batchOverviewEnabled: {
    key: "batch-overview-enabled",
    env: "BATCH_OVERVIEW_ENABLED",
    default: false,
  },
  recommendationsDisabled: {
    key: "recommendations-disabled",
    env: "RECOMMENDATIONS_DISABLED",
    default: false,
  },
  feedbackDisabled: { key: "feedback-disabled", env: "FEEDBACK_DISABLED", default: false },
  rateLimitEnabled: { key: "rate-limit-enabled", env: "RATE_LIMIT_ENABLED", default: false },
  searchQueryLogDisabled: {
    key: "search-query-log-disabled",
    env: "SEARCH_QUERY_LOG_DISABLED",
    default: false,
  },
  apiTokensDisabled: { key: "api-tokens-disabled", env: "API_TOKENS_DISABLED", default: false },
  // Rollout gate: the Better Auth user-API-key path. default:false → OFF until the
  // web self-serve panel ships; flip on in BOTH Flagship apps to enable relu_ key
  // verification + (later) self-serve creation. Separate from apiTokensDisabled,
  // which kills the whole token path (both lanes).
  userApiKeysEnabled: {
    key: "user-api-keys-enabled",
    env: "USER_API_KEYS_ENABLED",
    default: false,
  },
  // Rollout gate: the OAuth 2.0 Device Authorization Grant (RFC 8628) path that
  // backs `releases login` from the CLI — registers the `deviceAuthorization()` +
  // `bearer()` plugins and their endpoints. default:false → OFF until the web
  // /device verification pages ship; flip on in BOTH Flagship apps. Device login
  // mints relu_ user keys, so it is only useful with `user-api-keys-enabled` ALSO
  // on (the /v1/api-keys create route the CLI calls is gated on that flag).
  deviceAuthorizationEnabled: {
    key: "device-authorization-enabled",
    env: "DEVICE_AUTHORIZATION_ENABLED",
    default: false,
  },
  cacheDisabled: { key: "cache-disabled", env: "CACHE_DISABLED", default: false },
  indexingDisabled: { key: "indexing-disabled", env: "INDEXING_DISABLED", default: false },
  extractToolLoopEnabled: {
    key: "extract-toolloop-enabled",
    env: "EXTRACT_TOOLLOOP_ENABLED",
    default: false,
  },
  backfillWorkflow: {
    key: "backfill-workflow-enabled",
    env: "BACKFILL_WORKFLOW_ENABLED",
    default: false,
  },
  rawSnapshotCapture: {
    key: "raw-snapshot-capture-enabled",
    env: "RAW_SNAPSHOT_CAPTURE_ENABLED",
    default: false,
  },
  wellKnownSyncEnabled: {
    key: "well-known-sync-enabled",
    env: "WELL_KNOWN_SYNC_ENABLED",
    default: true,
  },
  // OpenRouter cheap-call lane for the per-source marketing classifier. OFF by
  // default → the classifier stays on Anthropic Haiku. Flip ON (per env) once an
  // OPENROUTER_API_KEY is bound and the eval confirms agreement with the Haiku
  // baseline. Fail-open: a missing key/model or any OpenRouter throw falls back
  // to Anthropic at the call site (see workers/api/src/lib/text-model.ts).
  marketingClassifierOpenrouter: {
    key: "marketing-classifier-openrouter",
    env: "MARKETING_CLASSIFIER_OPENROUTER",
    default: false,
  },
  // OpenRouter cheap-call lane for the *live* poll-fetch release summarizer
  // (title / short title / summary). OFF by default → summarization stays on
  // Anthropic Haiku. Separate from the marketing flag because summaries are
  // user-facing: flip ON (per env) only after the release-content eval confirms
  // no quality regression vs. Haiku AND a SUMMARIZE_MODEL + OPENROUTER_API_KEY
  // are configured. The daily batch path (Message Batches API) is NOT affected —
  // it always stays on Anthropic (no OpenRouter batch equivalent). Fail-open: a
  // missing key/model or any OpenRouter throw falls back to Anthropic at the call
  // site (see workers/api/src/lib/text-model.ts).
  summarizeOpenrouter: {
    key: "summarize-openrouter",
    env: "SUMMARIZE_OPENROUTER",
    default: false,
  },
} as const satisfies Record<string, FlagDef>;

/** Layered fallback: var value if set, else the hardcoded default. */
function fallbackOf(varValue: string | undefined, def: FlagDef): boolean {
  return varValue === undefined ? def.default : varValue === "true";
}

/**
 * Evaluate a flag. `binding` is `env.FLAGS` (may be undefined outside prod/staging
 * or in tests); `varValue` is the matching wrangler var (e.g. `env.CACHE_DISABLED`).
 * Never throws.
 */
export async function flag(
  binding: FlagshipBinding | undefined,
  varValue: string | undefined,
  def: FlagDef,
): Promise<boolean> {
  const fb = fallbackOf(varValue, def);
  if (!binding) return fb;
  try {
    return await binding.getBooleanValue(def.key, fb);
  } catch {
    return fb;
  }
}

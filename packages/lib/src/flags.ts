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
  mediaGifTranscodeEnabled: {
    key: "media-gif-transcode-enabled",
    env: "MEDIA_GIF_TRANSCODE_ENABLED",
    default: false,
  },
  feedEnrichEnabled: { key: "feed-enrich-enabled", env: "FEED_ENRICH_ENABLED", default: false },
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
  // Single switch for the secondary AI lanes (marketing classifier, live release
  // summarizer, …) on the TextModel seam. OFF → those lanes use Anthropic Haiku.
  // Flip ON in Flagship to route every such lane that ALSO has an OpenRouter model
  // var configured (e.g. MARKETING_CLASSIFIER_MODEL) onto OpenRouter at runtime; a
  // lane with an empty model var stays on Anthropic regardless (fail-open). This is
  // the ONLY OpenRouter toggle — there are no per-lane flags; per-lane control is
  // "set the model var or leave it empty". Resolved in
  // workers/api/src/lib/text-model.ts (resolveTextModel). OpenRouter is called
  // directly, never fronted by the CF AI Gateway (no double-hop) — see
  // docs/architecture/ai-gateway.md.
  openrouterEnabled: {
    key: "openrouter-enabled",
    env: "OPENROUTER_ENABLED",
    default: false,
  },
  // Rollout gate for the stale OAuth-client reaper cron (sweep-oauth-clients).
  // default:false → the nightly sweep runs in OBSERVE-ONLY mode (logs the
  // reapable candidates without deleting), so you can watch what it would purge
  // in Axiom first. Flip ON in BOTH Flagship apps to actually delete abandoned
  // dynamic-registration clients (untrusted, never consented, no tokens, older
  // than the retention window). The cron always runs when crons are on; this flag
  // only gates delete-vs-observe.
  oauthClientReaperEnabled: {
    key: "oauth-client-reaper-enabled",
    env: "OAUTH_CLIENT_REAPER_ENABLED",
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

export type FlagState = "on" | "off" | "unset";

/**
 * Three-state flag evaluation for inheritance. Distinguishes an explicit on/off
 * from "unset" (neither Flagship nor the var supplies a value), so a caller can
 * fall back to a different base (e.g. a global default flag) instead of the
 * FlagDef's hardcoded `default`. Precedence matches `flag()`: Flagship → var →
 * unset. Never throws.
 *
 * Flagship's getBooleanValue returns the passed default when a key is absent and
 * gives no separate "missing" signal, so we probe it twice with opposite
 * defaults: equal results ⇒ the key is present (explicit value); differing
 * results ⇒ the key is absent (the calls only echoed our two defaults).
 */
export async function flagState(
  binding: FlagshipBinding | undefined,
  varValue: string | undefined,
  def: FlagDef,
): Promise<FlagState> {
  if (binding) {
    try {
      const [asFalse, asTrue] = await Promise.all([
        binding.getBooleanValue(def.key, false),
        binding.getBooleanValue(def.key, true),
      ]);
      if (asFalse === asTrue) return asFalse ? "on" : "off";
    } catch {
      // fall through to the var / unset path
    }
  }
  if (varValue !== undefined) return varValue === "true" ? "on" : "off";
  return "unset";
}

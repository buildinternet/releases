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
  overviewRegenEnabled: {
    key: "overview-regen-enabled",
    env: "OVERVIEW_REGEN_ENABLED",
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
  // Default ON — the large-body (>50K-token) extraction tool-loop is rolled out
  // and Enabled in both Flagship apps. Per the outage-safety rule above, the
  // default matches the deployed reality so a Flagship outage keeps it on (a
  // no-op) instead of silently dropping every >50K body back to one-shot. Flip
  // OFF in Flagship to kill-switch the tool-loop fleet-wide.
  extractToolLoopEnabled: {
    key: "extract-toolloop-enabled",
    env: "EXTRACT_TOOLLOOP_ENABLED",
    default: true,
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
  // summarizer, feed enrichment, large-body extraction, …) on the TextModel seam.
  // ON → route every such lane that ALSO has an OpenRouter model var configured
  // (e.g. MARKETING_CLASSIFIER_MODEL, SUMMARIZE_MODEL, EXTRACT_MODEL) onto
  // OpenRouter at runtime; a lane with an empty model var stays on Anthropic Haiku
  // regardless (fail-open). This is the ONLY OpenRouter toggle — there are no
  // per-lane flags; per-lane control is "set the model var or leave it empty".
  // Resolved in workers/api/src/lib/text-model.ts (resolveTextModel) +
  // extract-model.ts. OpenRouter is called directly, never fronted by the CF AI
  // Gateway (no double-hop) — see docs/architecture/ai-gateway.md.
  //
  // default:true — OpenRouter is the established prod default for these lanes (the
  // prod wrangler vars point SUMMARIZE_MODEL / EXTRACT_MODEL / FEED_ENRICH_MODEL at
  // OpenRouter models), so the safe last-resort fallback (Flagship unreachable AND
  // OPENROUTER_ENABLED var unset) is ON, matching the deployed reality rather than
  // silently dropping the whole fleet back to Anthropic Haiku. Flip OFF in Flagship
  // to kill-switch every OpenRouter lane back to Anthropic at once.
  openrouterEnabled: {
    key: "openrouter-enabled",
    env: "OPENROUTER_ENABLED",
    default: true,
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
  // Rollout gate + kill switch for the actor-native scrape/agent drain
  // (OrgActor). default:false → OFF: the poll path does not self-flag, the
  // SourceActor does not notify an OrgActor, and the force-drain (#518) +
  // scrape-agent-sweep (#482) crons run as before. Flip ON in BOTH Flagship
  // apps to move the drain onto the actor path (the crons then early-return).
  // Roll back by flipping OFF — the crons resume next tick.
  orgDrainActorEnabled: {
    key: "org-drain-actor-enabled",
    env: "ORG_DRAIN_ACTOR_ENABLED",
    default: false,
  },
  // Rollout gate + kill switch for the deterministic `update` path (#1878).
  // A routine per-source update is a deterministic fetch→extract pipeline; the
  // worker agent added nothing load-bearing, yet its ~19k-token prompt+skills+
  // playbook cache-creation was ~84% of the session cost. ON → the discovery
  // worker loops `scrapeFetch` over the due sources directly, with NO
  // Managed-Agents (Haiku) session. OFF (default) → the legacy worker-agent
  // session runs unchanged. Flip ON in BOTH Flagship apps to roll out (verify on
  // staging / a few orgs first); flip OFF to instantly revert to the agent path.
  deterministicUpdateEnabled: {
    key: "deterministic-update-enabled",
    env: "DETERMINISTIC_UPDATE_ENABLED",
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

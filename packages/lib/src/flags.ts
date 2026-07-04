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

/**
 * Lifecycle of a flag — the axis that decides whether it's permanent surface or
 * a candidate for deletion:
 * - `kill-switch`: a permanent operational lever (incident/rollback/mode toggle)
 *   expected to live indefinitely.
 * - `rollout`: a temporary gate for staging a new feature. Once it's been fully
 *   on (or off) in prod for a while, RETIRE it — remove the flag + the dead
 *   branch. Rollout gates that never get retired are the main source of sprawl.
 */
export type FlagKind = "kill-switch" | "rollout";

/** Worker runtime(s) that evaluate a flag — where it actually takes effect. */
export type FlagReader = "api" | "discovery" | "mcp" | "webhooks";

export interface FlagDef {
  /** Flagship flag key (kebab-case). MUST exist identically in BOTH apps. */
  readonly key: string;
  /** wrangler-var name that supplies the fallback value (documentation + tests). */
  readonly env: string;
  /** Hardcoded last-resort default when neither Flagship nor the var is set. */
  readonly default: boolean;
  /** Permanent lever vs. temporary rollout gate — see {@link FlagKind}. */
  readonly kind: FlagKind;
  /** Which worker(s) read this flag at runtime. */
  readonly reads: readonly FlagReader[];
  /**
   * One-line summary of what the flag controls. Source of truth for the
   * generated docs table — keep it a single sentence; deeper detail belongs in
   * `docs/architecture/feature-flags.md` prose or the owning subsystem's doc.
   */
  readonly description: string;
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
    kind: "rollout",
    reads: ["api"],
    description: "Transcode uploaded/ingested GIFs to video. Off = store the GIF as-is.",
  },
  feedEnrichEnabled: {
    key: "feed-enrich-enabled",
    env: "FEED_ENRICH_ENABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api"],
    description:
      "Enriches summary-only feed items by fetching the linked page and extracting full content before insert.",
  },
  // #1410: collapses same-source same-normalized-title rows that anchor URLs
  // (`<page>#<slug>`) fail to dedup. ON by default (default:false → not disabled).
  scrapeTitleDedupDisabled: {
    key: "scrape-title-dedup-disabled",
    env: "SCRAPE_TITLE_DEDUP_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api"],
    description: "Kill switch for scrape-source title dedup (#1410). false = dedup active.",
  },
  webBotAuthEnabled: {
    key: "web-bot-auth-enabled",
    env: "WEB_BOT_AUTH_ENABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api", "discovery"],
    description: "Signs outbound content fetches with RFC 9421 Web Bot Auth signatures.",
  },
  invalidationEnabled: {
    key: "invalidation-enabled",
    env: "INVALIDATION_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api"],
    description: "Cache-invalidation workflow. Off = not running.",
  },
  maSessionsDisabled: {
    key: "ma-sessions-disabled",
    env: "MA_SESSIONS_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["discovery"],
    description: "Incident kill switch for managed-agent sessions. false = sessions allowed.",
  },
  batchSummarizeEnabled: {
    key: "batch-summarize-enabled",
    env: "BATCH_SUMMARIZE_ENABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api"],
    description: "Post-ingest batch auto-summarize (Haiku title / short-title / summary).",
  },
  batchOverviewEnabled: {
    key: "batch-overview-enabled",
    env: "BATCH_OVERVIEW_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api"],
    description:
      "Batch org-overview (AI knowledge-page) generation workflow. Off = manual/agent-driven only.",
  },
  overviewRegenEnabled: {
    key: "overview-regen-enabled",
    env: "OVERVIEW_REGEN_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api"],
    description:
      "Automated weekly org-overview regeneration workflow (#1706). Off = manual/agent-driven only.",
  },
  recommendationsDisabled: {
    key: "recommendations-disabled",
    env: "RECOMMENDATIONS_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api"],
    description: "Kill switch for recommendations. false = recommendations active.",
  },
  feedbackDisabled: {
    key: "feedback-disabled",
    env: "FEEDBACK_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api"],
    description: "Kill switch for the feedback endpoints. false = feedback enabled.",
  },
  rateLimitEnabled: {
    key: "rate-limit-enabled",
    env: "RATE_LIMIT_ENABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api", "mcp"],
    description: "Public read-path rate limiting. Off = no limiting.",
  },
  searchQueryLogDisabled: {
    key: "search-query-log-disabled",
    env: "SEARCH_QUERY_LOG_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api", "mcp"],
    description: "Kill switch for search-query logging (`search_queries` table). false = active.",
  },
  apiTokensDisabled: {
    key: "api-tokens-disabled",
    env: "API_TOKENS_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api", "mcp"],
    description:
      "Kill switch for scoped `relk_` API-token auth. false = tokens active (static root key still works).",
  },
  userApiKeysEnabled: {
    key: "user-api-keys-enabled",
    env: "USER_API_KEYS_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api", "mcp"],
    description:
      "Better Auth user-API-key (`relu_`) path — verification + self-serve creation. Separate from `api-tokens-disabled` (which kills both token lanes).",
  },
  cacheDisabled: {
    key: "cache-disabled",
    env: "CACHE_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api"],
    description: "Kill switch for `Cache-Control` response headers. false = caching active.",
  },
  indexingDisabled: {
    key: "indexing-disabled",
    env: "INDEXING_DISABLED",
    default: false,
    kind: "kill-switch",
    reads: ["api", "mcp"],
    description:
      "Stamps `X-Robots-Tag: noindex` + `Disallow: /` (how staging is gated). false in prod = indexable.",
  },
  // default:true — the >50K-token extraction tool-loop is fully rolled out, so the
  // last-resort fallback (Flagship unreachable AND the var unset) matches deployed
  // reality instead of silently dropping every large body back to one-shot.
  extractToolLoopEnabled: {
    key: "extract-toolloop-enabled",
    env: "EXTRACT_TOOLLOOP_ENABLED",
    default: true,
    kind: "kill-switch",
    reads: ["discovery"],
    description:
      "Multi-round tool-use extraction for large bodies (>50K tokens). Off = one-shot inline only.",
  },
  backfillWorkflow: {
    key: "backfill-workflow-enabled",
    env: "BACKFILL_WORKFLOW_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api"],
    description:
      "Durable resumable full-history backfill workflow (deep Firecrawl path). Off = inline backfill only.",
  },
  rawSnapshotCapture: {
    key: "raw-snapshot-capture-enabled",
    env: "RAW_SNAPSHOT_CAPTURE_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["discovery"],
    description:
      "Steady-state scrape path captures the scraped markdown as a raw snapshot (#1283) for cheap re-extraction (#1284).",
  },
  // default:true — OpenRouter is the established prod default (the prod wrangler
  // vars point SUMMARIZE_MODEL / EXTRACT_MODEL / FEED_ENRICH_MODEL at OpenRouter
  // models), so the fallback matches reality rather than dropping the fleet back to
  // Anthropic Haiku. This is the ONLY OpenRouter toggle — per-lane control is "set
  // the model var or leave it empty". Never fronted by the CF AI Gateway (no
  // double-hop) — see docs/architecture/ai-gateway.md.
  openrouterEnabled: {
    key: "openrouter-enabled",
    env: "OPENROUTER_ENABLED",
    default: true,
    kind: "kill-switch",
    reads: ["api", "discovery"],
    description:
      "Single switch for the secondary cheap-call AI lanes (marketing classifier, summarizer, feed-enrich, large-body extract). On = lanes with an OpenRouter model var route to OpenRouter; off = Anthropic Haiku.",
  },
  // default:false → the nightly sweep runs in OBSERVE-ONLY mode (logs candidates
  // without deleting) so you can watch what it would purge in Axiom first.
  oauthClientReaperEnabled: {
    key: "oauth-client-reaper-enabled",
    env: "OAUTH_CLIENT_REAPER_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api"],
    description:
      "Stale OAuth-client reaper cron. Off = observe-only (log reapable candidates); on = delete abandoned DCR clients.",
  },
  // default:false → OFF: the force-drain (#518) + scrape-agent-sweep (#482) crons
  // run as before. ON moves the drain onto the actor path (the crons early-return).
  orgDrainActorEnabled: {
    key: "org-drain-actor-enabled",
    env: "ORG_DRAIN_ACTOR_ENABLED",
    default: false,
    kind: "rollout",
    reads: ["api"],
    description:
      "Actor-native scrape/agent drain (OrgActor, #1777). On = actor path drives; off = the force-drain + scrape-agent-sweep crons run.",
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

import type { Sandbox } from "@cloudflare/sandbox";
import type { FlagshipBinding } from "@releases/lib/flags";

export interface OnboardRequest {
  company: string;
  domain?: string;
  githubOrg?: string;
  /**
   * Optional scope: pin every source the agent adds to this existing org +
   * (optional) product, instead of letting the agent auto-create new ones.
   * Used to onboard a new product under an existing multi-product org
   * without leaving an orphan org + manual cleanup. Issue #794, item 4.
   *
   * The agent is instructed (via a `<scope>` data tag in the task block) to
   * skip `manage_org(action=add)` / `manage_product(action=add)` entirely and
   * pass `organization=<intoOrgSlug>` (+ `product=<intoProductSlug>`) on every
   * `manage_source(action=add)` call.
   */
  intoOrgSlug?: string;
  intoProductSlug?: string;
}

export interface OnboardResponse {
  sessionId: string;
  status: "running";
}

export interface UpdateRequest {
  /** Label for StatusHub — can be an org name or description like "stale sources". */
  company: string;
  /** Source IDs (src_...) or slugs to fetch. IDs preferred. */
  sourceIdentifiers: string[];
  /** Organization ID (org_...) for playbook lookup. */
  orgId?: string;
  /** Correlation ID from the originating client — flows through to managed agent sessions and status events. */
  correlationId?: string;
  /** @deprecated Use sourceIdentifiers instead. */
  sourceSlugs?: string[];
}

export interface StatusResponse {
  status: "running" | "complete" | "error" | "idle";
  progress?: {
    step: string;
    sourcesFound: number;
    sourcesValidated: number;
    currentAction: string;
  };
  result?: object; // DiscoveryState JSON
  error?: string;
}

/** Cloudflare Secrets Store binding — call .get() to retrieve the secret value. */
export type SecretBinding = { get(): Promise<string> };

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  MANAGED_AGENTS_SESSION: DurableObjectNamespace;
  DB: D1Database;
  ANTHROPIC_API_KEY: SecretBinding;
  /** Optional Cloudflare AI Gateway passthrough — see docs/architecture/ai-gateway.md. */
  ANTHROPIC_BASE_URL?: string;
  AI_GATEWAY_TOKEN?: SecretBinding;
  CLOUDFLARE_ACCOUNT_ID: SecretBinding;
  CLOUDFLARE_API_TOKEN: SecretBinding;
  RELEASED_API_URL: string;
  RELEASES_API_URL?: string;
  RELEASED_API_KEY: SecretBinding;
  RELEASES_API_KEY?: SecretBinding;
  API_WORKER?: Fetcher;
  /** Pre-created Anthropic Managed Agent ID (discovery — Sonnet). */
  ANTHROPIC_AGENT_ID?: string;
  /** Pre-created Anthropic Managed Agent version. */
  ANTHROPIC_AGENT_VERSION?: string;
  /** Pre-created Anthropic Worker Agent ID (Haiku — fetches/updates). */
  ANTHROPIC_WORKER_AGENT_ID?: string;
  /**
   * Pre-created Anthropic Coordinator Agent ID (Sonnet — multi-agent onboard).
   * When set, onboard sessions route here instead of ANTHROPIC_AGENT_ID; the
   * coordinator delegates fetches to the worker via agent_toolset_20260401.
   */
  ANTHROPIC_COORDINATOR_AGENT_ID?: string;
  /** Pre-created Anthropic Environment ID. */
  ANTHROPIC_ENVIRONMENT_ID?: string;
  /** Pre-created Anthropic Vault ID for MCP server access. */
  ANTHROPIC_VAULT_ID?: string;
  /**
   * Staging access gate shared secret. Present only in [env.staging]; when set,
   * outbound calls to api-staging attach `X-Releases-Staging-Key` so they pass
   * the middleware in workers/api/src/middleware/staging-access.ts.
   */
  STAGING_ACCESS_KEY?: SecretBinding;
  /** Managed-agents memory stores — attached as read-write mounts. See #537. */
  MEMORY_STORE_ERRATA_ID?: string;
  MEMORY_STORE_TOOL_NOTES_ID?: string;
  /** "true" to enable tool-loop extraction for large bodies globally. */
  EXTRACT_TOOLLOOP_ENABLED?: string;
  /**
   * OpenRouter extraction lane (issue #1536). The large-body tool-loop routes
   * through the AI-SDK/OpenRouter (DeepSeek) path when the `openrouter-enabled`
   * flag is on AND `EXTRACT_MODEL` is non-empty AND `OPENROUTER_API_KEY`
   * resolves; otherwise the Anthropic loop runs (fail open). `EXTRACT_MODEL` is
   * a wrangler var (default ""); the OPENROUTER_API_KEY secret binding is
   * configured in wrangler.jsonc (prod + staging), so enabling the lane only
   * needs the flag on and a non-empty `EXTRACT_MODEL`.
   */
  EXTRACT_MODEL?: string;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  /** Optional wrangler-var override for the `openrouter-enabled` flag (Flagship wins). */
  OPENROUTER_ENABLED?: string;
  /**
   * "true" to capture the scraped markdown body as a raw snapshot (#1283).
   * Resolved once per session against the FLAGS binding and threaded into
   * ScrapeEnv.captureRawSnapshots; when on, runScrapePath POSTs the body to the
   * API worker's raw-snapshot endpoint for later re-extraction (#1284).
   */
  RAW_SNAPSHOT_CAPTURE_ENABLED?: string;
  /** "true" to sign outbound scrape-path content fetches with Web Bot Auth headers. */
  WEB_BOT_AUTH_ENABLED?: string;
  /** Secrets Store binding for the Ed25519 private JWK used by Web Bot Auth signing. */
  WEB_BOT_AUTH_PRIVATE_KEY?: SecretBinding;
  /**
   * Runtime kill switch. Set to "true" to block all new MA session creation
   * at the /update + /onboard HTTP routes AND the typed RPC. Flip via
   * `wrangler secret put MA_SESSIONS_DISABLED` — propagates on next request
   * without a code deploy. Replaces the hardcoded constant deployed during
   * the 2026-05-18 Notion runaway.
   *
   * Superseded in practice by the KV kill switch (key "ma:sessions:disabled"
   * in LATEST_CACHE), which can be flipped sub-second without a redeploy.
   * Both are checked; KV takes priority.
   */
  MA_SESSIONS_DISABLED?: string;
  /**
   * KV namespace used for:
   *   - Kill switch: key "ma:sessions:disabled" blocks all new MA sessions.
   *     Flip on:  wrangler kv:key put --binding=LATEST_CACHE "ma:sessions:disabled" "1"
   *     Flip off: wrangler kv:key delete --binding=LATEST_CACHE "ma:sessions:disabled"
   *   - Per-source dedup lock: keys "ma:active:src:{sourceId}" (15-min TTL)
   *     prevent the same source spawning two concurrent MA sessions.
   *   - Daily spend counters: keys "ma:spend:global:{YYYY-MM-DD}" and
   *     "ma:spend:org:{orgId}:{YYYY-MM-DD}" (26h TTL) — sum of session cost.
   *     Manual reset: wrangler kv:key delete --binding=LATEST_CACHE
   *     "ma:spend:global:2026-05-19"
   * Optional so existing workers without the binding still start up.
   */
  LATEST_CACHE?: KVNamespace;
  /**
   * Per-org daily spend cap in US cents (integer). Default: 200 (= $2.00/day).
   * Override via `wrangler secret put MA_DAILY_SPEND_CAP_ORG_CENTS`.
   * Set to a high value (e.g. "999999") to effectively disable the org cap
   * without disabling the global cap.
   */
  MA_DAILY_SPEND_CAP_ORG_CENTS?: string;
  /**
   * Global daily spend cap in US cents (integer). Default: 1500 (= $15.00/day).
   * Override via `wrangler secret put MA_DAILY_SPEND_CAP_GLOBAL_CENTS`.
   * At the $15 default the Notion incident ($20 over 4.5h) would have been
   * stopped at ~3.5h. Bump after a week of real-traffic data.
   */
  MA_DAILY_SPEND_CAP_GLOBAL_CENTS?: string;
  FLAGS?: FlagshipBinding;
}

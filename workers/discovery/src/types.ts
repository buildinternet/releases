import type { Sandbox } from "@cloudflare/sandbox";

export interface OnboardRequest {
  company: string;
  domain?: string;
  githubOrg?: string;
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
  RELEASED_API_KEY: SecretBinding;
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
}

/**
 * Worker-side ExtractDeps implementation. All DB access goes through the
 * API worker via the supplied fetcher (service binding in prod, direct HTTP
 * over `RELEASES_API_URL` in local dev).
 */

import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { logEvent } from "@releases/lib/log-event.js";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { buildOpenRouterExtractModel } from "@releases/adapters/extract";
import type { Source } from "@buildinternet/releases-core/schema";
import type { ExtractDeps, ExtractRepo, UsageEntry } from "@releases/adapters/extract";

export interface WorkerDepsEnv {
  anthropicApiKey: string;
  /** Optional Cloudflare AI Gateway passthrough — see docs/architecture/ai-gateway.md. */
  anthropicBaseURL?: string;
  aiGatewayToken?: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  agentModel?: string;
  /** Override for the single-call body-extraction model (see DEFAULT_ONESHOT_MODEL). */
  oneShotModel?: string;
  incrementalModel?: string;
  apiFetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  apiKey: string;
  sessionId?: string;
  extractToolLoopEnabled?: boolean;
  /**
   * OpenRouter extraction lane (issue #1536). When `openrouterEnabled` (the
   * resolved `openrouter-enabled` flag) is true AND `extractModel` is non-empty
   * AND `openRouterApiKey` resolves, the large-body tool-loop routes through the
   * AI-SDK path on this model instead of the Anthropic SDK loop. Any missing
   * piece → Anthropic path (fail open). The flag is resolved once per session by
   * the caller (mirrors `extractToolLoopEnabled`).
   * NOTE: the OPENROUTER_API_KEY secret is NOT yet bound in the discovery
   * worker's wrangler.jsonc — binding it is a prerequisite to enable this lane.
   */
  openrouterEnabled?: boolean;
  openRouterApiKey?: SecretBinding;
  openRouterBaseURL?: string;
  extractModel?: string;
}

/**
 * Default model for the AGENTIC extraction paths (web_fetch loop, large-body
 * tool-use loop). Sonnet-class — these are multi-turn tool loops where Haiku
 * degrades, and they run on small inputs (the loop slices the body) so the
 * cost is already low.
 */
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

/**
 * Default model for the SINGLE-CALL body extraction (crawl one-shot,
 * direct-fetch, seed/Cloudflare-render fallback). These inline the whole body
 * into one forced-tool-call request — the largest, most expensive extraction
 * we run (crawl bodies hit 100K+ tokens). Haiku-class parses them reliably at
 * ~⅓ the cost; the agentic loops above stay on Sonnet. Override per env via
 * `oneShotModel`.
 */
const DEFAULT_ONESHOT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Build an org-scoped sub-resource path for a source. We pass `source.id`
 * (a `src_…` ID) as the source segment and `source.orgId` (an `org_…` ID)
 * as the org segment — both are unambiguous IDs and the API resolves them
 * via `findSourceForOrgSlug` (id-or-slug). Using the org-scoped form
 * eliminates the bare-slug ambiguity that #690 introduced and unblocks the
 * planned 400-on-bare-slug rejection (#698).
 */
function sourceSubpath(source: Source, sub: string): string {
  return `/v1/orgs/${encodeURIComponent(source.orgId)}/sources/${encodeURIComponent(source.id)}/${sub}`;
}

const workerLogger = {
  info: (msg: string) =>
    logEvent("info", { component: "extract-deps-worker", event: "extract-info", message: msg }),
  warn: (msg: string) =>
    logEvent("warn", { component: "extract-deps-worker", event: "extract-warn", message: msg }),
  debug: (msg: string) =>
    logEvent("info", { component: "extract-deps-worker", event: "extract-debug", message: msg }),
  error: (msg: string) =>
    logEvent("error", { component: "extract-deps-worker", event: "extract-error", message: msg }),
};

function buildWorkerRepo(env: WorkerDepsEnv): ExtractRepo {
  const headers = () => ({
    Authorization: `Bearer ${env.apiKey}`,
  });
  const jsonHeaders = () => ({
    ...headers(),
    "Content-Type": "application/json",
  });

  return {
    async peekContentHash(source: Source, hash: string): Promise<boolean> {
      const res = await env.apiFetcher.fetch(
        `https://api${sourceSubpath(source, "content-hash")}?peek=true`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ contentHash: hash }),
        },
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { unchanged?: boolean };
      return data.unchanged === true;
    },

    async commitContentHash(source: Source, hash: string): Promise<void> {
      await env.apiFetcher.fetch(`https://api${sourceSubpath(source, "content-hash")}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ contentHash: hash }),
      });
    },

    async updateSourceMeta(source: Source, patch: Record<string, unknown>): Promise<void> {
      await env.apiFetcher.fetch(`https://api${sourceSubpath(source, "metadata")}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify(patch),
      });
    },

    async getOrgPlaybook(orgId: string | null): Promise<string | null> {
      if (!orgId) return null;
      // The :slug param accepts `org_…` IDs via `orgWhere` in the worker,
      // so we can skip the org→slug lookup.
      const res = await env.apiFetcher.fetch(
        `https://api/v1/orgs/${encodeURIComponent(orgId)}/playbook`,
        { headers: headers() },
      );
      if (!res.ok) return null;
      const page = (await res.json()) as { notes?: string | null; content?: string | null } | null;
      const notes = page?.notes?.trim();
      if (notes) return notes;
      return page?.content?.trim() ?? null;
    },

    async logUsage(entry: UsageEntry): Promise<void> {
      // Fire-and-forget; usage logging shouldn't fail the extraction.
      env.apiFetcher
        .fetch("https://api/v1/admin/logs/usage", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            operation: entry.operation,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            sourceSlug: entry.sourceSlug,
            releaseCount: entry.releaseCount,
            extractionMode: entry.extractionMode,
            toolRounds: entry.toolRounds,
            toolChars: entry.toolChars,
            fallbackReason: entry.fallbackReason,
            cacheReadTokens: entry.cacheReadTokens,
            cacheWriteTokens: entry.cacheWriteTokens,
          }),
        })
        .catch(() => {});
    },
  };
}

/**
 * Resolve the OpenRouter extraction model, or `undefined` to keep the Anthropic
 * tool-loop. Fail-open at every step: flag off, no `EXTRACT_MODEL`, an
 * unresolvable/missing key, or any throw → `undefined` (Anthropic path).
 */
async function resolveAiSdkExtractModel(
  env: WorkerDepsEnv,
): Promise<{ model: unknown; label: string } | undefined> {
  try {
    if (!env.openrouterEnabled) return undefined; // off by default — silent (expected path)
    const model = env.extractModel?.trim();
    if (!model) {
      // Flag on but lane not finished — warn so the silent Anthropic fallback is diagnosable.
      logEvent("warn", {
        component: "extract-deps",
        event: "openrouter-misconfigured",
        reason: "EXTRACT_MODEL empty",
      });
      return undefined;
    }
    const apiKey = await getSecret(env.openRouterApiKey).catch(() => null);
    if (!apiKey) {
      logEvent("warn", {
        component: "extract-deps",
        event: "openrouter-misconfigured",
        reason: "OPENROUTER_API_KEY unresolved",
        model,
      });
      return undefined;
    }
    const baseURL = env.openRouterBaseURL?.trim();
    return {
      model: buildOpenRouterExtractModel({ apiKey, model, ...(baseURL ? { baseURL } : {}) }),
      label: model,
    };
  } catch (err) {
    // Any unexpected failure → Anthropic path (fail open).
    logEvent("warn", {
      component: "extract-deps",
      event: "openrouter-resolve-failed",
      err: err instanceof Error ? err : String(err),
    });
    return undefined;
  }
}

export async function buildWorkerExtractDeps(env: WorkerDepsEnv): Promise<ExtractDeps> {
  const cloudflare =
    env.cloudflareAccountId && env.cloudflareApiToken
      ? { accountId: env.cloudflareAccountId, apiToken: env.cloudflareApiToken }
      : null;

  const aiSdk = await resolveAiSdkExtractModel(env);

  // The worker ships its own @anthropic-ai/sdk copy (isolated node_modules);
  // the package types resolve via the root workspace copy. Both are the same
  // version at runtime but are nominally different compiled classes, so TS
  // rejects the instance on the `#private` field. The cast is safe because
  // the runtime shape is identical.
  const anthropicClient = buildAnthropicClient({
    apiKey: env.anthropicApiKey,
    baseURL: env.anthropicBaseURL,
    gatewayToken: env.aiGatewayToken,
  });

  return {
    anthropicClient: anthropicClient as unknown as ExtractDeps["anthropicClient"],
    agentModel: env.agentModel ?? DEFAULT_AGENT_MODEL,
    oneShotModel: env.oneShotModel ?? DEFAULT_ONESHOT_MODEL,
    incrementalModel: env.incrementalModel,
    logger: workerLogger,
    cloudflare,
    repo: buildWorkerRepo(env),
    extractToolLoopEnabled: env.extractToolLoopEnabled ?? false,
    ...(aiSdk ? { aiSdkModel: aiSdk.model, aiSdkModelLabel: aiSdk.label } : {}),
  };
}

/**
 * Worker-side ExtractDeps implementation. All DB access goes through the
 * API worker via the supplied fetcher (service binding in prod, direct HTTP
 * over `RELEASED_API_URL` in local dev).
 */

import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { logEvent } from "@releases/lib/log-event.js";
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
  incrementalModel?: string;
  apiFetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  apiKey: string;
  sessionId?: string;
  extractToolLoopEnabled?: boolean;
}

/** Default model for agent-style extraction in workers. Sonnet-class. */
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

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

export function buildWorkerExtractDeps(env: WorkerDepsEnv): ExtractDeps {
  const cloudflare =
    env.cloudflareAccountId && env.cloudflareApiToken
      ? { accountId: env.cloudflareAccountId, apiToken: env.cloudflareApiToken }
      : null;

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
    incrementalModel: env.incrementalModel,
    logger: workerLogger,
    cloudflare,
    repo: buildWorkerRepo(env),
    extractToolLoopEnabled: env.extractToolLoopEnabled ?? false,
  };
}

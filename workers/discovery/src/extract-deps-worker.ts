/**
 * Worker-side ExtractDeps implementation. All DB access goes through the
 * API worker via the supplied fetcher (service binding in prod, direct HTTP
 * over `RELEASED_API_URL` in local dev).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Source } from "@buildinternet/releases-core/schema";
import type { ExtractDeps, ExtractRepo, UsageEntry } from "@releases/adapters/extract";

export interface WorkerDepsEnv {
  anthropicApiKey: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  agentModel?: string;
  incrementalModel?: string;
  apiFetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  apiKey: string;
  sessionId?: string;
}

/** Default model for agent-style extraction in workers. Sonnet-class. */
const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

const workerLogger = {
  info: (msg: string) => console.log(`[extract] ${msg}`),
  warn: (msg: string) => console.warn(`[extract] ${msg}`),
  debug: (msg: string) => console.debug(`[extract] ${msg}`),
  error: (msg: string) => console.error(`[extract] ${msg}`),
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
        `https://api/v1/sources/${encodeURIComponent(source.slug)}/content-hash?peek=true`,
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
      await env.apiFetcher.fetch(
        `https://api/v1/sources/${encodeURIComponent(source.slug)}/content-hash`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ contentHash: hash }),
        },
      );
    },

    async updateSourceMeta(source: Source, patch: Record<string, unknown>): Promise<void> {
      await env.apiFetcher.fetch(
        `https://api/v1/sources/${encodeURIComponent(source.slug)}/metadata`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify(patch),
        },
      );
    },

    async getOrgPlaybook(orgId: string | null): Promise<string | null> {
      if (!orgId) return null;
      // The playbook endpoint's `slug` param accepts both slugs and `org_…` IDs
      // via `orgWhere` in the worker, so we can skip the org→slug lookup.
      const res = await env.apiFetcher.fetch(
        `https://api/v1/playbook?slug=${encodeURIComponent(orgId)}`,
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
        .fetch("https://api/v1/usage-log", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            operation: entry.operation,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            sourceSlug: entry.sourceSlug,
            releaseCount: entry.releaseCount,
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
  const anthropicClient = new Anthropic({ apiKey: env.anthropicApiKey });

  return {
    anthropicClient: anthropicClient as unknown as ExtractDeps["anthropicClient"],
    agentModel: env.agentModel ?? DEFAULT_AGENT_MODEL,
    incrementalModel: env.incrementalModel,
    logger: workerLogger,
    cloudflare,
    repo: buildWorkerRepo(env),
  };
}

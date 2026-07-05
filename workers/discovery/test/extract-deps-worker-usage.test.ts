/**
 * The crawl (and direct-fetch / agent) extraction paths log Anthropic spend
 * via `deps.repo.logUsage()`, which the worker-side `ExtractRepo` POSTs to
 * `/v1/admin/logs/usage`. Before this fix, callers only passed `sourceSlug`,
 * and the API route resolves an ambiguous slug (one shared across orgs, e.g.
 * "release-notes" — source slugs are only unique per-org, #690) to a NULL
 * `source_id`, silently breaking cost attribution. `logUsage` must now also
 * forward `sourceId` (the stable `src_…` id) end-to-end so attribution never
 * depends on slug uniqueness.
 */
import { describe, it, expect } from "bun:test";
import { buildWorkerExtractDeps, type WorkerDepsEnv } from "@releases/adapters/extract-deps-worker";

type Call = { url: string; body: Record<string, unknown> };

function envWith(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>): {
  env: WorkerDepsEnv;
  calls: Call[];
} {
  const calls: Call[] = [];
  const env: WorkerDepsEnv = {
    anthropicApiKey: "sk-test",
    apiKey: "rel_key",
    apiFetcher: {
      fetch: async (input, init) => {
        const url = input.toString();
        const body = JSON.parse((init?.body as string) ?? "{}");
        calls.push({ url, body });
        return fetchImpl ? fetchImpl(url, init) : new Response("{}", { status: 201 });
      },
    },
  };
  return { env, calls };
}

describe("buildWorkerExtractDeps().repo.logUsage", () => {
  it("forwards sourceId alongside sourceSlug so attribution never relies on slug resolution", async () => {
    const { env, calls } = envWith();
    const deps = await buildWorkerExtractDeps(env);

    await deps.repo.logUsage({
      operation: "agent-ingest",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 20,
      sourceId: "src_djFtfbJFwNTRq_dKhinln",
      sourceSlug: "release-notes",
      releaseCount: 0,
    });

    const usageCalls = calls.filter((c) => c.url.includes("/v1/admin/logs/usage"));
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]!.body.sourceId).toBe("src_djFtfbJFwNTRq_dKhinln");
    expect(usageCalls[0]!.body.sourceSlug).toBe("release-notes");
  });

  it("still sends sourceId even when undefined, letting the API fall back to slug resolution", async () => {
    const { env, calls } = envWith();
    const deps = await buildWorkerExtractDeps(env);

    await deps.repo.logUsage({
      operation: "agent-ingest",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 20,
      sourceSlug: "resend-changelog",
      releaseCount: 1,
    });

    const usageCalls = calls.filter((c) => c.url.includes("/v1/admin/logs/usage"));
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]!.body.sourceId).toBeUndefined();
    expect(usageCalls[0]!.body.sourceSlug).toBe("resend-changelog");
  });
});

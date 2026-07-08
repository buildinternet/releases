/**
 * `resolveAiSdkExtractModel` (issue #1536 / #1878 workstream 2) decides which
 * AI-SDK model backs the large-body extraction tool-loop. It isn't exported
 * directly, but its result surfaces on `ExtractDeps.aiSdkModel` /
 * `aiSdkModelLabel`, so we exercise it through `buildWorkerExtractDeps`.
 *
 * OpenRouter when `openrouterEnabled` + a non-empty `extractModel` + a
 * resolvable `openRouterApiKey` are all set; otherwise Anthropic AI SDK
 * (always when `anthropicApiKey` is present).
 */
import { describe, it, expect } from "bun:test";
import { buildWorkerExtractDeps, type WorkerDepsEnv } from "@releases/adapters/extract-deps-worker";

function baseEnv(overrides: Partial<WorkerDepsEnv> = {}): WorkerDepsEnv {
  return {
    anthropicApiKey: "sk-ant-test",
    apiKey: "rel_key",
    apiFetcher: { fetch: async () => new Response("{}", { status: 201 }) },
    ...overrides,
  };
}

const resolvingKey = { get: async () => "sk-or-test" };
const nullKey = { get: async () => null };

describe("resolveAiSdkExtractModel (via buildWorkerExtractDeps)", () => {
  it("routes to OpenRouter when the flag is on, a model is set, and the key resolves", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.aiSdkModel).toBeDefined();
    expect(deps.aiSdkModelLabel).toBe("deepseek/deepseek-v4-pro");
  });

  it("falls back to Anthropic AI SDK when openrouterEnabled is false", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: false,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.aiSdkModel).toBeDefined();
    expect(deps.aiSdkModelLabel).toBe("claude-sonnet-5");
  });

  it("falls back to Anthropic AI SDK when extractModel is empty", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.aiSdkModel).toBeDefined();
    expect(deps.aiSdkModelLabel).toBe("claude-sonnet-5");
  });

  it("falls back to Anthropic AI SDK when the OpenRouter key does not resolve", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: nullKey,
      }),
    );

    expect(deps.aiSdkModel).toBeDefined();
    expect(deps.aiSdkModelLabel).toBe("claude-sonnet-5");
  });

  it("falls back to Anthropic AI SDK when no OpenRouter key binding is provided", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
      }),
    );

    expect(deps.aiSdkModel).toBeDefined();
    expect(deps.aiSdkModelLabel).toBe("claude-sonnet-5");
  });

  it("uses a custom agentModel for the Anthropic fallback label", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: false,
        agentModel: "claude-custom-agent",
      }),
    );

    expect(deps.aiSdkModel).toBeDefined();
    expect(deps.aiSdkModelLabel).toBe("claude-custom-agent");
  });

  it("returns no aiSdkModel when no Anthropic key is configured", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        anthropicApiKey: "",
        openrouterEnabled: false,
      }),
    );

    expect(deps.aiSdkModel).toBeUndefined();
    expect(deps.aiSdkModelLabel).toBeUndefined();
  });
});

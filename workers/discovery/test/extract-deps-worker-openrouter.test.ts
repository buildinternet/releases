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

/**
 * The one-shot tier's twin resolution (issue #2166) — same OpenRouter
 * `extractModel` / key, but falls back to the Haiku-class `oneShotModel`
 * (not the Sonnet-class `agentModel` the tool-loop resolution above falls
 * back to). Surfaces on `ExtractDeps.oneShotAiSdkModel` / `oneShotAiSdkModelLabel`
 * / `oneShotAiSdkProvider`.
 */
describe("resolveAiSdkExtractModel — one-shot tier (via buildWorkerExtractDeps)", () => {
  it("routes to OpenRouter when the flag is on, a model is set, and the key resolves", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.oneShotAiSdkModel).toBeDefined();
    expect(deps.oneShotAiSdkModelLabel).toBe("deepseek/deepseek-v4-pro");
    expect(deps.oneShotAiSdkProvider).toBe("openrouter");
  });

  it("falls back to the Haiku-class oneShotModel default when openrouterEnabled is false", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: false,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.oneShotAiSdkModel).toBeDefined();
    expect(deps.oneShotAiSdkModelLabel).toBe("claude-haiku-4-5-20251001");
    expect(deps.oneShotAiSdkProvider).toBe("anthropic");
    // And the tool-loop resolution must stay on its OWN (Sonnet) fallback —
    // the two tiers must never collapse onto the same Anthropic fallback model.
    expect(deps.aiSdkModelLabel).toBe("claude-sonnet-5");
  });

  it("falls back to the custom oneShotModel when set, not the default", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: false,
        oneShotModel: "claude-custom-oneshot",
      }),
    );

    expect(deps.oneShotAiSdkModel).toBeDefined();
    expect(deps.oneShotAiSdkModelLabel).toBe("claude-custom-oneshot");
  });

  it("falls back to Anthropic when the OpenRouter key does not resolve", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: nullKey,
      }),
    );

    expect(deps.oneShotAiSdkModel).toBeDefined();
    expect(deps.oneShotAiSdkModelLabel).toBe("claude-haiku-4-5-20251001");
    expect(deps.oneShotAiSdkProvider).toBe("anthropic");
  });

  it("returns no oneShotAiSdkModel when no Anthropic key is configured", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        anthropicApiKey: "",
        openrouterEnabled: false,
      }),
    );

    expect(deps.oneShotAiSdkModel).toBeUndefined();
    expect(deps.oneShotAiSdkModelLabel).toBeUndefined();
  });
});

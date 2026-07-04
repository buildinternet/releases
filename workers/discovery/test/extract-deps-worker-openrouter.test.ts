/**
 * `resolveAiSdkExtractModel` (issue #1536 / #1878 workstream 2) decides
 * whether the large-body extraction tool-loop routes through OpenRouter
 * (DeepSeek) or stays on the Anthropic SDK. It isn't exported directly, but
 * its result surfaces on `ExtractDeps.aiSdkModel` / `aiSdkModelLabel`, so we
 * exercise it through `buildWorkerExtractDeps`. Every condition must hold —
 * `openrouterEnabled`, a non-empty `extractModel`, and a resolvable
 * `openRouterApiKey` — otherwise the lane fails open to Anthropic (unset).
 */
import { describe, it, expect } from "bun:test";
import { buildWorkerExtractDeps, type WorkerDepsEnv } from "../src/extract-deps-worker.js";

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

  it("fails open to Anthropic when openrouterEnabled is false", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: false,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.aiSdkModel).toBeUndefined();
    expect(deps.aiSdkModelLabel).toBeUndefined();
  });

  it("fails open to Anthropic when extractModel is empty", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "",
        openRouterApiKey: resolvingKey,
      }),
    );

    expect(deps.aiSdkModel).toBeUndefined();
  });

  it("fails open to Anthropic when the OpenRouter key does not resolve", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
        openRouterApiKey: nullKey,
      }),
    );

    expect(deps.aiSdkModel).toBeUndefined();
  });

  it("fails open to Anthropic when no OpenRouter key binding is provided at all", async () => {
    const deps = await buildWorkerExtractDeps(
      baseEnv({
        openrouterEnabled: true,
        extractModel: "deepseek/deepseek-v4-pro",
      }),
    );

    expect(deps.aiSdkModel).toBeUndefined();
  });
});

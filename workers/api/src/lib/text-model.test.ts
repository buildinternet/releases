import { describe, expect, it } from "bun:test";
import {
  resolveArticleExtractModel,
  resolveMarketingModel,
  resolveSummarizeModel,
  type TextModelEnv,
} from "./text-model.js";
import type { FlagshipBinding } from "@releases/lib/flags";

/** Flagship stub: `true`/`false` = present key with that value; absent key echoes the default. */
function flagsBinding(values: Record<string, boolean>): FlagshipBinding {
  return {
    getBooleanValue: async (key, defaultValue) => (key in values ? values[key]! : defaultValue),
  };
}

const secret = (v: string | null) => ({ get: async () => v });

/** Base env with a usable Anthropic key + an OpenRouter key & model configured. */
function baseEnv(overrides: Partial<TextModelEnv> = {}): TextModelEnv {
  return {
    ANTHROPIC_API_KEY: secret("anthropic-key"),
    OPENROUTER_API_KEY: secret("or-key"),
    MARKETING_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    ENVIRONMENT: "test",
    ...overrides,
  } as TextModelEnv;
}

describe("resolveMarketingModel — single openrouter-enabled switch", () => {
  it("switch ON + model set → OpenRouter", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "openrouter-enabled": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("switch OFF → Anthropic", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({}) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("ignores a stray legacy per-lane flag (consolidated away)", async () => {
    // `marketing-classifier-openrouter` no longer exists. With the global switch
    // off, a leftover Flagship key of that name must have no effect → Anthropic.
    const env = baseEnv({ FLAGS: flagsBinding({ "marketing-classifier-openrouter": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch ON but no model configured → falls back to Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      MARKETING_CLASSIFIER_MODEL: "",
    });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch ON but no OpenRouter key → falls back to Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      OPENROUTER_API_KEY: undefined,
    });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("returns null when no Anthropic key is available for the fallback", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({}), ANTHROPIC_API_KEY: undefined });
    const model = await resolveMarketingModel(env);
    expect(model).toBeNull();
  });
});

describe("resolveSummarizeModel — model var is the per-lane gate", () => {
  it("switch ON + SUMMARIZE_MODEL empty (the prod config) → stays on Anthropic", async () => {
    // The summarizer ships with SUMMARIZE_MODEL="" so it stays on Anthropic even
    // when the global switch is on — the empty model var is the definitional gate.
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      SUMMARIZE_MODEL: "",
    });
    const model = await resolveSummarizeModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch ON + SUMMARIZE_MODEL set → OpenRouter", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      SUMMARIZE_MODEL: "google/gemini-2.5-flash-lite",
    });
    const model = await resolveSummarizeModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });
});

describe("resolveArticleExtractModel — feed-enrich lane, FEED_ENRICH_MODEL is the gate", () => {
  it("switch ON + FEED_ENRICH_MODEL set → OpenRouter", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      FEED_ENRICH_MODEL: "google/gemini-2.5-flash-lite",
    });
    const model = await resolveArticleExtractModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("switch ON + FEED_ENRICH_MODEL empty → stays on Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      FEED_ENRICH_MODEL: "",
    });
    const model = await resolveArticleExtractModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch OFF → Anthropic even with the model set", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({}),
      FEED_ENRICH_MODEL: "google/gemini-2.5-flash-lite",
    });
    const model = await resolveArticleExtractModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });
});

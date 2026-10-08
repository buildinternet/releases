import { afterEach, describe, expect, test } from "bun:test";
import { ANTHROPIC_PRICING } from "./anthropic-pricing";
import {
  MODEL_ROLES,
  OPENROUTER_MODELS,
  canonicalModelId,
  modelCapabilities,
  modelId,
  samplingParams,
  thinkingParams,
  thinkingProviderOptions,
} from "./models";
import { resolveModel } from "./resolve-model";

const ENV_KEYS = [
  "RELEASES_INGEST_MODEL",
  "RELEASED_INGEST_MODEL",
  "RELEASES_AGENT_MODEL",
  "RELEASED_AGENT_MODEL",
  "RELEASES_SUMMARY_MODEL",
  "RELEASED_SUMMARY_MODEL",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("model roles", () => {
  test("cheap Anthropic lanes share one pin", () => {
    expect(modelId("summarize")).toBe(modelId("marketing"));
    expect(modelId("articleExtract")).toBe(modelId("extraction"));
    expect(modelId("summarize")).toBe(MODEL_ROLES.summarize.id);
  });

  test("every Anthropic pin has a pricing row", () => {
    for (const pin of Object.values(MODEL_ROLES)) {
      if (!pin.pricingId) continue;
      expect(ANTHROPIC_PRICING[pin.pricingId]).toBeDefined();
    }
  });

  test("OpenRouter text lanes share one code default", () => {
    expect(OPENROUTER_MODELS.summarize).toBe(OPENROUTER_MODELS.extract);
    expect(OPENROUTER_MODELS.feedEnrich).toBe(OPENROUTER_MODELS.summarize);
    expect(OPENROUTER_MODELS.marketing.length).toBeGreaterThan(0);
  });
});

describe("modelCapabilities", () => {
  test("current pins and known rejecting families omit sampling", () => {
    for (const model of [
      modelId("extraction"),
      modelId("extractionAgent"),
      `anthropic:${modelId("extraction")}`,
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-fable-5",
      "claude-mythos-5",
    ]) {
      const caps = modelCapabilities(model);
      expect(caps.temperature).toBe(false);
      expect(caps.topP).toBe(false);
      expect(caps.topK).toBe(false);
    }
  });

  test("Haiku 4.5, Opus 4.6, and unknown ids still accept sampling", () => {
    for (const model of [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
      "deepseek/deepseek-v4.1-flash",
      "",
    ]) {
      const caps = modelCapabilities(model);
      expect(caps.temperature).toBe(true);
      expect(caps.topP).toBe(true);
      expect(caps.topK).toBe(true);
      expect(caps.disableThinking).toBe(false);
    }
  });

  test("only Haiku 5 disables thinking, including a provider prefix", () => {
    expect(modelCapabilities(modelId("extraction")).disableThinking).toBe(true);
    expect(modelCapabilities("anthropic:claude-haiku-5").disableThinking).toBe(true);
    expect(modelCapabilities(modelId("extractionAgent")).disableThinking).toBe(false);
    expect(modelCapabilities("claude-haiku-4-5").disableThinking).toBe(false);
  });

  test("canonicalModelId strips a provider prefix and a dated snapshot", () => {
    expect(canonicalModelId("anthropic:claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(canonicalModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });
});

describe("request builders", () => {
  test("samplingParams drops temperature, top_p, and top_k together", () => {
    expect(
      samplingParams(modelId("extractionAgent"), { temperature: 0, topP: 0.2, topK: 1 }),
    ).toEqual({});
    expect(samplingParams("claude-haiku-4-5", { temperature: 0, topP: 0.2, topK: 5 })).toEqual({
      temperature: 0,
      top_p: 0.2,
      top_k: 5,
    });
  });

  test("thinking helpers are Haiku-5-only", () => {
    expect(thinkingParams(modelId("summarize"))).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingProviderOptions(`anthropic:${modelId("extraction")}`)).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    expect(thinkingParams(modelId("extractionAgent"))).toEqual({});
    expect(thinkingProviderOptions("openrouter:deepseek/deepseek-v4.1-flash")).toBeUndefined();
  });
});

describe("resolveModel", () => {
  test("returns the pin when no override is set", () => {
    expect(resolveModel("extraction")).toBe(modelId("extraction"));
    expect(resolveModel("extractionAgent")).toBe(modelId("extractionAgent"));
    expect(resolveModel("summarize")).toBe(modelId("summarize"));
    expect(resolveModel("marketing")).toBe(modelId("marketing"));
    expect(resolveModel("evalJudge")).toBe(modelId("evalJudge"));
  });

  test("prefers RELEASES_ over RELEASED_ and ignores blank values", () => {
    process.env.RELEASED_INGEST_MODEL = "legacy";
    expect(resolveModel("extraction")).toBe("legacy");
    process.env.RELEASES_INGEST_MODEL = "next";
    expect(resolveModel("extraction")).toBe("next");
    process.env.RELEASES_SUMMARY_MODEL = "   ";
    expect(resolveModel("summarize")).toBe(modelId("summarize"));
  });
});

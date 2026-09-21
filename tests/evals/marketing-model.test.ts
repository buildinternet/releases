import { afterEach, expect, it } from "bun:test";
import * as resolvers from "./judge-model";
import { classifyMarketing } from "@releases/ai-internal/marketing-classifier";
import { marketingDecisionResponse } from "../marketing-decision-fixture";

const originalFetch = globalThis.fetch;
const saved = {
  EVAL_MODEL: process.env.EVAL_MODEL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
};
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("resolves the marketing eval candidate via Decisions without running the eval harness", async () => {
  process.env.EVAL_MODEL = "typesafe/jev-1.13";
  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.OPENROUTER_BASE_URL;
  let url = "";
  globalThis.fetch = (async (input) => {
    url = String(input);
    return Response.json(marketingDecisionResponse("case_study", 0.8));
  }) as typeof fetch;
  expect(resolvers).toHaveProperty("resolveMarketingEvalModel");
  const picked = resolvers.resolveMarketingEvalModel({
    anthropicModel: "claude-haiku-4-5",
    generationName: "marketing-classifier-eval",
    orModelEnvVar: "EVAL_MODEL",
  });
  expect(
    (
      await classifyMarketing(picked!.model, {
        sourceName: "Blog",
        title: "Story",
        content: "Body",
        url: null,
      })
    ).isMarketing,
  ).toBe(true);
  expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
});

it("retains the Anthropic eval baseline when JEV has no key", () => {
  process.env.EVAL_MODEL = "typesafe/jev-1.13";
  delete process.env.OPENROUTER_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  expect(resolvers).toHaveProperty("resolveMarketingEvalModel");
  const picked = resolvers.resolveMarketingEvalModel({
    anthropicModel: "claude-haiku-4-5",
    generationName: "marketing-classifier-eval",
    orModelEnvVar: "EVAL_MODEL",
  });
  expect(picked?.model.id).toBe("anthropic:claude-haiku-4-5");
  expect(picked?.model).toHaveProperty("complete");
});

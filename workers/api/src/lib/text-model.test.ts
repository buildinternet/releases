import { describe, expect, it, spyOn } from "bun:test";
import { createTestDb } from "../../../../tests/db-helper.js";
import { putStoredAiLaneModels } from "../queries/site-settings.js";
import { clearAiLaneModelCache } from "./ai-lane-models.js";
import {
  resolveArticleExtractModel,
  resolveCollectionSummaryModel,
  resolveMarketingModel,
  resolveSummarizeModel,
  type TextModelEnv,
} from "./text-model.js";
import type { FlagshipBinding } from "@releases/lib/flags";
import type { TextModel } from "@releases/ai-internal/text-model";
import { classifyMarketing } from "@releases/ai-internal/marketing-classifier";
import { marketingDecisionResponse } from "../../../../tests/marketing-decision-fixture";

/** Flagship stub: `true`/`false` = present key with that value; absent key echoes the default. */
function flagsBinding(values: Record<string, boolean>): FlagshipBinding {
  return {
    getBooleanValue: async (key, defaultValue) => (key in values ? values[key]! : defaultValue),
  };
}

const secret = (v: string | null) => ({ get: async () => v });

/** Minimal OpenRouter chat-completions body the AI SDK provider accepts in tests. */
function openRouterOkResponse() {
  return {
    id: "gen_test",
    choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * Resolve a model, call `.complete()` once with `global.fetch` stubbed, and
 * return the parsed OpenRouter request body so a test can assert what the lane
 * put on the wire (reasoning / provider routing). Restores `fetch` afterward.
 */
async function captureOpenRouterBody(
  resolve: (env: TextModelEnv) => Promise<TextModel | null>,
  env: TextModelEnv,
): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    return new Response(JSON.stringify(openRouterOkResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const model = await resolve(env);
    await model!.complete({ system: "s", user: "u", maxTokens: 256 });
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

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
  for (const [choice, probability, confidence] of [
    ["case_study", 0.64, 0.98],
    ["unclear_other", 0.95, 0.12],
  ] as const) {
    it(`retains distinct ${choice} diagnostics in the classifier result and structured telemetry`, async () => {
      clearAiLaneModelCache();
      const original = globalThis.fetch;
      const logs = spyOn(console, "log").mockImplementation(() => undefined);
      globalThis.fetch = (async () =>
        Response.json(
          marketingDecisionResponse(choice, probability, confidence),
        )) as unknown as typeof fetch;
      try {
        const model = await resolveMarketingModel(
          baseEnv({ OPENROUTER_ENABLED: "true", MARKETING_CLASSIFIER_MODEL: "typesafe/jev-1.13" }),
        );
        const result = await classifyMarketing(model!, {
          sourceName: "Blog",
          title: "Story",
          content: "Body",
          url: null,
        });
        expect(result.isMarketing).toBe(false);
        const diagnostics = {
          choice,
          selectedChoiceProbability: probability,
          providerConfidence: confidence,
        };
        expect(result.decision).toEqual(diagnostics);
        const record = logs.mock.calls
          .map(([line]) => JSON.parse(String(line)))
          .find((row) => row.event === "ai_usage" && row.lane === "marketing-classifier");
        expect(record).toMatchObject({
          provider: "openrouter",
          model: "typesafe/jev-1.13",
          decision: diagnostics,
        });
      } finally {
        globalThis.fetch = original;
        logs.mockRestore();
        clearAiLaneModelCache();
      }
    });
  }

  it("routes the stored JEV override to Decisions with lane tags and usage", async () => {
    const db = createTestDb();
    const original = globalThis.fetch;
    clearAiLaneModelCache();
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      body = JSON.parse(init!.body as string);
      return Response.json(marketingDecisionResponse("case_study", 0.8));
    }) as typeof fetch;
    try {
      await putStoredAiLaneModels(db.db, { marketing: "typesafe/jev-1.13" });
      const model = await resolveMarketingModel(
        baseEnv({ OPENROUTER_ENABLED: "true", DB: db.db as unknown as D1Database }),
      );
      const result = await classifyMarketing(model!, {
        sourceName: "Blog",
        title: "Story",
        content: "Body",
        url: null,
      });
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(body.model).toBe("typesafe/jev-1.13");
      expect(body.session_id).toBe("marketing-classifier");
      expect(body.trace).toEqual({ generation_name: "marketing-classifier", environment: "test" });
      expect(body).not.toHaveProperty("messages");
      expect(result.isMarketing).toBe(true);
      expect(result.usage.costUsd).toBe(0.001);
    } finally {
      globalThis.fetch = original;
      clearAiLaneModelCache();
      db.cleanup();
    }
  });

  for (const overrides of [
    { OPENROUTER_ENABLED: "false" },
    { OPENROUTER_API_KEY: undefined },
    {
      OPENROUTER_API_KEY: {
        get: async () => {
          throw new Error("missing secret");
        },
      },
    },
  ]) {
    it(`keeps the Anthropic text fallback for unavailable JEV: ${Object.keys(overrides)[0]}`, async () => {
      const model = await resolveMarketingModel(
        baseEnv({
          OPENROUTER_ENABLED: "true",
          MARKETING_CLASSIFIER_MODEL: "typesafe/jev-1.13",
          ...overrides,
        }),
      );
      expect(model?.id).toBe("anthropic:claude-haiku-4-5");
      expect(model).toHaveProperty("complete");
    });
  }

  it("switch ON + model set → OpenRouter", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "openrouter-enabled": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("switch OFF → Anthropic", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "openrouter-enabled": false }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("does NOT carry summarize-lane reasoning/provider routing (lane-scoped)", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "openrouter-enabled": true }) });
    const body = await captureOpenRouterBody(async (e) => {
      const model = await resolveMarketingModel(e);
      if (model && !("complete" in model)) throw new Error("Expected a text model");
      return model;
    }, env);
    expect("reasoning" in body).toBe(false);
    expect("provider" in body).toBe(false);
  });

  it("ignores a stray legacy per-lane flag (consolidated away)", async () => {
    // `marketing-classifier-openrouter` no longer exists. With the global switch
    // off, a leftover Flagship key of that name must have no effect → Anthropic.
    const env = baseEnv({
      FLAGS: flagsBinding({
        "openrouter-enabled": false,
        "marketing-classifier-openrouter": true,
      }),
    });
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
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": false }),
      ANTHROPIC_API_KEY: undefined,
    });
    const model = await resolveMarketingModel(env);
    expect(model).toBeNull();
  });
});

describe("resolveSummarizeModel — model var is the per-lane gate", () => {
  it("switch ON + SUMMARIZE_MODEL empty → stays on Anthropic", async () => {
    // An empty SUMMARIZE_MODEL keeps the lane on Anthropic even when the global
    // switch is on — the empty model var is the definitional per-lane gate. (Prod
    // actually sets SUMMARIZE_MODEL=google/gemini-2.5-flash-lite; this exercises
    // the empty-gate fallback, not the deployed value.)
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

  it("on the OpenRouter path, disables reasoning and excludes GMICloud (#1633)", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      SUMMARIZE_MODEL: "deepseek/deepseek-v4.1-flash",
    });
    const body = await captureOpenRouterBody(resolveSummarizeModel, env);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.provider).toEqual({ ignore: ["gmicloud"] });
  });

  it("uses a site_settings overlay over the wrangler SUMMARIZE_MODEL", async () => {
    const db = createTestDb();
    clearAiLaneModelCache();
    try {
      await putStoredAiLaneModels(db.db, { summarize: "openai/gpt-4o-mini" });
      const env = baseEnv({
        FLAGS: flagsBinding({ "openrouter-enabled": true }),
        SUMMARIZE_MODEL: "deepseek/deepseek-v4.1-flash",
        DB: db.db as unknown as D1Database,
      });
      const body = await captureOpenRouterBody(resolveSummarizeModel, env);
      expect(body.model).toBe("openai/gpt-4o-mini");
    } finally {
      clearAiLaneModelCache();
      db.cleanup?.();
    }
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
      FLAGS: flagsBinding({ "openrouter-enabled": false }),
      FEED_ENRICH_MODEL: "google/gemini-2.5-flash-lite",
    });
    const model = await resolveArticleExtractModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });
});

describe("resolveCollectionSummaryModel — collection-daily-summary lane", () => {
  // Reuses the shared SUMMARIZE_MODEL var (same "summarize cheaply" task as the
  // release summarizer) rather than its own model config.
  it("switch ON + SUMMARIZE_MODEL set → OpenRouter", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      SUMMARIZE_MODEL: "meta-llama/llama-3.1-8b-instruct",
    });
    const model = await resolveCollectionSummaryModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("switch ON + SUMMARIZE_MODEL empty → stays on Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      SUMMARIZE_MODEL: "",
    });
    const model = await resolveCollectionSummaryModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch OFF → Anthropic even with the model set", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": false }),
      SUMMARIZE_MODEL: "meta-llama/llama-3.1-8b-instruct",
    });
    const model = await resolveCollectionSummaryModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });
});

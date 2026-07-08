import { describe, expect, it } from "bun:test";
import { splitModelId, withUsageLogging, type UsageRecord } from "./text-model";

function fakeModel(id: string, usage: import("./text-model").TextModelUsage) {
  return { id, complete: async () => ({ text: "OUT", usage }) };
}
const ZERO = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

describe("withUsageLogging", () => {
  it("preserves id and returns the inner result unchanged", async () => {
    const inner = fakeModel("anthropic:claude-haiku-4-5", { ...ZERO, input: 5, output: 2 });
    const wrapped = withUsageLogging(inner, { lane: "x", sink: () => {} });
    expect(wrapped.id).toBe("anthropic:claude-haiku-4-5");
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res).toEqual({ text: "OUT", usage: { ...ZERO, input: 5, output: 2 } });
  });

  it("emits a record with provider/model split from the id, lane, env, and tokens", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("openrouter:google/gemini-2.5-flash-lite", {
      input: 10,
      output: 3,
      cacheCreate: 1,
      cacheRead: 4,
      costUsd: 0.0002,
    });
    const wrapped = withUsageLogging(inner, {
      lane: "marketing-classifier",
      environment: "production",
      sink: (r) => {
        rec = r;
      },
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      lane: "marketing-classifier",
      environment: "production",
      input: 10,
      output: 3,
      cacheCreate: 1,
      cacheRead: 4,
      // OpenRouter `prompt_tokens` already includes cached tokens → promptTokens = input.
      promptTokens: 10,
      cacheHitRate: 0.4,
      costUsd: 0.0002,
    });
  });

  it("normalizes Anthropic promptTokens to include cache reads/writes for a comparable hit rate", async () => {
    let rec: UsageRecord | undefined;
    // Anthropic `input_tokens` EXCLUDES cache → promptTokens = 10 + 30 read + 60 write = 100.
    const inner = fakeModel("anthropic:claude-haiku-4-5", {
      input: 10,
      output: 5,
      cacheCreate: 60,
      cacheRead: 30,
    });
    const wrapped = withUsageLogging(inner, {
      lane: "summarize-release",
      sink: (r) => {
        rec = r;
      },
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.promptTokens).toBe(100);
    expect(rec?.cacheHitRate).toBeCloseTo(0.3, 5);
  });

  it("reports a zero hit rate (no divide-by-zero) when there are no prompt tokens", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("openrouter:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: (r) => {
        rec = r;
      },
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.promptTokens).toBe(0);
    expect(rec?.cacheHitRate).toBe(0);
  });

  it("derives cost via deriveCost when the provider reports none", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("anthropic:claude-haiku-4-5", { ...ZERO, input: 100, output: 20 });
    const wrapped = withUsageLogging(inner, {
      lane: "summarize-release",
      sink: (r) => {
        rec = r;
      },
      deriveCost: (provider, model) => (provider === "anthropic" ? 0.005 : undefined),
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.costUsd).toBe(0.005);
  });

  it("preserves costUsd: 0 rather than falling through to deriveCost", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("openrouter:m", { ...ZERO, costUsd: 0 });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: (r) => {
        rec = r;
      },
      deriveCost: () => 99,
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.costUsd).toBe(0);
  });

  it("does not break the call when the sink throws", async () => {
    const inner = fakeModel("anthropic:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: () => {
        throw new Error("axiom down");
      },
    });
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res.text).toBe("OUT");
  });

  it("does not break the call when deriveCost throws", async () => {
    const inner = fakeModel("anthropic:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: () => {},
      deriveCost: () => {
        throw new Error("pricing boom");
      },
    });
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res.text).toBe("OUT");
  });
});

describe("splitModelId", () => {
  it("splits a provider:model id on the first colon", () => {
    expect(splitModelId("anthropic:claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("preserves a model segment that contains slashes and no further colon", () => {
    expect(splitModelId("openrouter:google/gemini-2.5-flash-lite")).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
    });
  });

  it("returns provider 'unknown' when there is no colon", () => {
    expect(splitModelId("claude-haiku-4-5")).toEqual({
      provider: "unknown",
      model: "claude-haiku-4-5",
    });
  });
});

import { describe, expect, it } from "bun:test";
import {
  applyLaneOverride,
  isAiLane,
  parseAiLaneModels,
  parseOpenRouterModelId,
} from "./ai-lane-models";

describe("parseOpenRouterModelId", () => {
  it("accepts vendor/model ids, snapshots, and variant suffixes", () => {
    expect(parseOpenRouterModelId("deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
    expect(parseOpenRouterModelId("~deepseek/deepseek-v4-flash-latest")).toBe(
      "~deepseek/deepseek-v4-flash-latest",
    );
    expect(parseOpenRouterModelId("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(parseOpenRouterModelId("  google/gemini-2.5-flash-lite  ")).toBe(
      "google/gemini-2.5-flash-lite",
    );
  });

  it("rejects empty, whitespace, and non-OpenRouter shapes", () => {
    expect(parseOpenRouterModelId("")).toBeNull();
    expect(parseOpenRouterModelId("   ")).toBeNull();
    expect(parseOpenRouterModelId("deepseek")).toBeNull();
    expect(parseOpenRouterModelId("not a model")).toBeNull();
    expect(parseOpenRouterModelId("javascript:alert(1)")).toBeNull();
  });
});

describe("parseAiLaneModels", () => {
  it("keeps only known lanes with valid ids", () => {
    expect(
      parseAiLaneModels(
        JSON.stringify({
          summarize: "deepseek/deepseek-v4.1-flash",
          extract: "nope",
          mystery: "openai/gpt-4o",
          marketing: "google/gemini-2.5-flash-lite",
        }),
      ),
    ).toEqual({
      summarize: "deepseek/deepseek-v4.1-flash",
      marketing: "google/gemini-2.5-flash-lite",
    });
  });

  it("returns {} for missing, malformed, or non-object JSON", () => {
    expect(parseAiLaneModels(null)).toEqual({});
    expect(parseAiLaneModels("")).toEqual({});
    expect(parseAiLaneModels("not-json")).toEqual({});
    expect(parseAiLaneModels("[]")).toEqual({});
  });
});

describe("applyLaneOverride", () => {
  it("prefers a set override, else the wrangler default", () => {
    expect(applyLaneOverride("wrangler/default", "override/model")).toBe("override/model");
    expect(applyLaneOverride("wrangler/default", undefined)).toBe("wrangler/default");
    expect(applyLaneOverride("wrangler/default", "  ")).toBe("wrangler/default");
    expect(applyLaneOverride("  ", undefined)).toBeUndefined();
    expect(applyLaneOverride(undefined, undefined)).toBeUndefined();
  });
});

describe("isAiLane", () => {
  it("accepts the four cheap-call lanes", () => {
    expect(isAiLane("summarize")).toBe(true);
    expect(isAiLane("extract")).toBe(true);
    expect(isAiLane("feed-enrich")).toBe(true);
    expect(isAiLane("marketing")).toBe(true);
    expect(isAiLane("overview")).toBe(false);
  });
});

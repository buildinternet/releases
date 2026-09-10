import { describe, expect, it } from "bun:test";
import { AiLaneModelsPutSchema } from "./ai-models";

describe("AiLaneModelsPutSchema", () => {
  it("accepts a partial map", () => {
    expect(
      AiLaneModelsPutSchema.safeParse({
        models: { summarize: "deepseek/deepseek-v4.1-flash" },
      }).success,
    ).toBe(true);
  });

  it("accepts null to clear an override", () => {
    expect(AiLaneModelsPutSchema.safeParse({ models: { extract: null } }).success).toBe(true);
  });

  it("rejects an empty models object", () => {
    expect(AiLaneModelsPutSchema.safeParse({ models: {} }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      AiLaneModelsPutSchema.safeParse({
        models: { summarize: "x" },
        extra: true,
      }).success,
    ).toBe(false);
  });
});

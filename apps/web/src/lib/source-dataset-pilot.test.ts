import { describe, expect, test } from "bun:test";
import { getSourceDatasetPilot, sourceDatasetEligible } from "./source-dataset-pilot";

describe("source dataset pilot scope", () => {
  test("only selected source coordinates have dataset descriptions", () => {
    const names = new Set<string>();
    for (const [org, slug] of [
      ["anthropic", "claude-code-releases"],
      ["openai", "openai-codex-changelog"],
      ["vercel", "next-js"],
    ]) {
      const pilot = getSourceDatasetPilot(org!, slug!);
      expect(pilot?.name).toBeTruthy();
      expect(pilot?.description.length).toBeGreaterThanOrEqual(50);
      expect(pilot?.description.length).toBeLessThanOrEqual(5000);
      names.add(pilot!.name);
    }
    expect(names.size).toBe(3);
    expect(getSourceDatasetPilot("anthropic", "claude-code")).toBeUndefined();
    expect(getSourceDatasetPilot("other", "next-js")).toBeUndefined();
    expect(getSourceDatasetPilot("anthropic", "anthropic-news")).toBeUndefined();
  });

  test("public dataset treatment never exposes hidden or on-demand sources", () => {
    expect(sourceDatasetEligible({ isHidden: false, discovery: "curated" })).toBe(true);
    expect(sourceDatasetEligible({ isHidden: true, discovery: "curated" })).toBe(false);
    expect(sourceDatasetEligible({ isHidden: false, discovery: "on_demand" })).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { getSourceDatasetPilot, sourceDatasetEligible } from "./source-dataset-pilot";

describe("source dataset pilot scope", () => {
  test("only selected source coordinates have dataset descriptions", () => {
    const names = new Set<string>();
    for (const [org, slug] of [
      ["anthropic", "claude-code-releases"],
      ["openai", "openai-codex-changelog"],
      ["vercel", "next-js"],
      ["openai", "openai-api-changelog"],
      ["openai", "chatgpt-release-notes"],
      ["openai", "model-release-notes"],
      ["xai", "release-notes"],
      ["xai", "release-notes-2"],
      ["xai", "grok-build-releases"],
      ["cloudflare", "cloudflare-application-performance"],
      ["cloudflare", "cloudflare-application-security"],
      ["cloudflare", "cloudflare-cloudflare-one"],
      ["cloudflare", "cloudflare-core-platform"],
      ["cloudflare", "cloudflare-developer-platform"],
      ["vercel", "vercel"],
    ]) {
      const pilot = getSourceDatasetPilot(org!, slug!);
      expect(pilot?.name).toBeTruthy();
      expect(pilot?.description.length).toBeGreaterThanOrEqual(50);
      expect(pilot?.description.length).toBeLessThanOrEqual(5000);
      names.add(pilot!.name);
    }
    expect(names.size).toBe(15);
    expect(getSourceDatasetPilot("anthropic", "claude-code")).toBeUndefined();
    expect(getSourceDatasetPilot("other", "next-js")).toBeUndefined();
    expect(getSourceDatasetPilot("anthropic", "anthropic-news")).toBeUndefined();
    expect(getSourceDatasetPilot("openai", "openai-news")).toBeUndefined();
    expect(getSourceDatasetPilot("xai", "news")).toBeUndefined();
    expect(getSourceDatasetPilot("spacex", "release-notes")).toBeUndefined();
  });

  test("public dataset treatment never exposes hidden or on-demand sources", () => {
    expect(sourceDatasetEligible({ isHidden: false, discovery: "curated" })).toBe(true);
    expect(sourceDatasetEligible({ isHidden: true, discovery: "curated" })).toBe(false);
    expect(sourceDatasetEligible({ isHidden: false, discovery: "on_demand" })).toBe(false);
  });
});

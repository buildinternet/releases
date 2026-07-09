import { describe, expect, test } from "bun:test";
import {
  classifyContentQuality,
  isEmptyReleaseContent,
  meaningfulTextLength,
  releaseDisplayText,
} from "./content-quality.js";

describe("classifyContentQuality", () => {
  test("langfuse-style placeholder is empty", () => {
    expect(classifyContentQuality("test", 4).tier).toBe("empty");
    expect(classifyContentQuality("test", 4).weight).toBe(0);
    expect(isEmptyReleaseContent({ title: "test", summary: "test" })).toBe(true);
  });

  test("no-changes family is empty when short", () => {
    expect(classifyContentQuality("- no changes", 12).tier).toBe("empty");
    expect(classifyContentQuality("No user-facing changes.", 23).tier).toBe("empty");
  });

  test("short real bugfix is thin", () => {
    const q = classifyContentQuality("Fixed crash on startup (#1234)", 30);
    expect(q.tier).toBe("thin");
    expect(q.weight).toBe(0.5);
  });

  test("long body mentioning no breaking changes stays full", () => {
    const text =
      "This release adds a new dashboard widget for webhook deliveries, " +
      "improves retry semantics for failed callbacks, and ships operator docs. " +
      "There are no breaking changes for existing API clients that already " +
      "subscribe to the delivery stream.";
    expect(text.length).toBeGreaterThan(160);
    expect(classifyContentQuality(text, text.length).tier).toBe("full");
  });

  test("URL-only changelog is empty after strip", () => {
    const text = "Full Changelog: https://github.com/acme/x/compare/v1.0.0...v1.0.1";
    expect(meaningfulTextLength(text)).toBeLessThan(15);
    expect(classifyContentQuality(text, text.length).tier).toBe("empty");
  });
});

describe("releaseDisplayText", () => {
  test("prefers summary over title", () => {
    expect(releaseDisplayText({ title: "v1", summary: "Shipped webhooks" })).toBe(
      "Shipped webhooks",
    );
  });

  test("falls back to title", () => {
    expect(releaseDisplayText({ title: "v1.2.3", summary: "  " })).toBe("v1.2.3");
  });
});

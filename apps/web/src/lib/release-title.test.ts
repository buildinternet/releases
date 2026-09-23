import { describe, it, expect } from "bun:test";
import {
  clampTitle,
  deriveFeedTitle,
  normalizeVersionLabel,
  titleIsBareVersion,
} from "./release-title";

describe("clampTitle", () => {
  it("leaves short titles untouched", () => {
    expect(clampTitle("Short title — Acme", 60)).toBe("Short title — Acme");
  });

  it("truncates on a word boundary with an ellipsis when over the limit", () => {
    const long =
      "An extremely long descriptive release headline that keeps going well past the limit — Acme";
    const out = clampTitle(long, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
    // Cuts at a space, not mid-word.
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it("hard-cuts when there is no late word boundary", () => {
    const out = clampTitle("a".repeat(80), 60);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("normalizeVersionLabel", () => {
  it("prepends v to numeric versions", () => {
    expect(normalizeVersionLabel("2.1.154")).toBe("v2.1.154");
    expect(normalizeVersionLabel("2024.1")).toBe("v2024.1");
  });

  it("leaves already-prefixed versions untouched (no double v)", () => {
    expect(normalizeVersionLabel("v2.1.154")).toBe("v2.1.154");
    expect(normalizeVersionLabel("V3")).toBe("V3");
  });

  it("leaves non-numeric tags untouched", () => {
    expect(normalizeVersionLabel("R3")).toBe("R3");
    expect(normalizeVersionLabel("stable-2024")).toBe("stable-2024");
  });

  it("returns null for empty/absent input", () => {
    expect(normalizeVersionLabel(null)).toBeNull();
    expect(normalizeVersionLabel(undefined)).toBeNull();
    expect(normalizeVersionLabel("   ")).toBeNull();
  });
});

describe("titleIsBareVersion", () => {
  it("matches exact and v-prefix-insensitive restatements", () => {
    expect(titleIsBareVersion("v2.1.154", "v2.1.154")).toBe(true);
    expect(titleIsBareVersion("2.1.154", "v2.1.154")).toBe(true);
    expect(titleIsBareVersion("v2.1.154", "2.1.154")).toBe(true);
  });

  it("is false when the title carries extra meaning", () => {
    expect(titleIsBareVersion("Spring release", "v2.1.154")).toBe(false);
    expect(titleIsBareVersion("v2.1.154 — security fixes", "v2.1.154")).toBe(false);
  });

  it("treats an empty title as bare when a version exists", () => {
    expect(titleIsBareVersion("", "v2.1.154")).toBe(true);
    expect(titleIsBareVersion("   ", "v2.1.154")).toBe(true);
  });

  it("is false when there is no version", () => {
    expect(titleIsBareVersion("Anything", null)).toBe(false);
    expect(titleIsBareVersion("", null)).toBe(false);
  });
});

describe("deriveFeedTitle", () => {
  it("prefers the AI short title, then the long title", () => {
    expect(
      deriveFeedTitle({
        title: "v2.1.154",
        version: "v2.1.154",
        titleShort: "Dynamic workflows launch",
        titleGenerated: "Dynamic workflows launch; Opus 4.8 defaults to lean prompt",
      }).descriptive,
    ).toBe("Dynamic workflows launch");

    expect(
      deriveFeedTitle({
        title: "v2.1.154",
        version: "v2.1.154",
        titleShort: null,
        titleGenerated: "Dynamic workflows launch; Opus 4.8 defaults to lean prompt",
      }).descriptive,
    ).toBe("Dynamic workflows launch; Opus 4.8 defaults to lean prompt");
  });

  it("uses a meaningful raw title when there is no AI title", () => {
    expect(deriveFeedTitle({ title: "Spring cleanup", version: "v2.0.0" }).descriptive).toBe(
      "Spring cleanup",
    );
  });

  it("returns no descriptive headline when the title is just the version", () => {
    const parts = deriveFeedTitle({ title: "v2.1.153", version: "v2.1.153" });
    expect(parts.descriptive).toBeNull();
    expect(parts.versionLabel).toBe("v2.1.153");
  });

  it("treats a version-less descriptive title as the headline (blog/feed posts)", () => {
    const parts = deriveFeedTitle({ title: "Introducing teams", version: null });
    expect(parts.descriptive).toBe("Introducing teams");
    expect(parts.versionLabel).toBeNull();
  });

  it("normalizes the version label", () => {
    expect(deriveFeedTitle({ title: "Notes", version: "2.1.154" }).versionLabel).toBe("v2.1.154");
  });

  it("trims whitespace-only AI titles away", () => {
    const parts = deriveFeedTitle({
      title: "v2.1.153",
      version: "v2.1.153",
      titleShort: "   ",
      titleGenerated: "  ",
    });
    expect(parts.descriptive).toBeNull();
  });
});

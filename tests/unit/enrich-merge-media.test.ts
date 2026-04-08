import { describe, it, expect } from "bun:test";
import { mergeMedia } from "../../src/adapters/enrich.js";

describe("mergeMedia", () => {
  it("returns empty array when both inputs are empty", () => {
    expect(mergeMedia([], [])).toEqual([]);
  });

  it("returns existing when incoming is empty", () => {
    const existing = [{ type: "image", url: "https://example.com/a.png" }];
    expect(mergeMedia(existing, [])).toEqual(existing);
  });

  it("returns incoming when existing is empty", () => {
    const incoming = [{ type: "image", url: "https://example.com/a.png" }];
    expect(mergeMedia([], incoming)).toEqual(incoming);
  });

  it("deduplicates by URL", () => {
    const existing = [{ type: "image", url: "https://example.com/a.png", alt: "original" }];
    const incoming = [{ type: "image", url: "https://example.com/a.png", alt: "duplicate" }];
    const result = mergeMedia(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].alt).toBe("original"); // existing takes precedence
  });

  it("appends new media from incoming", () => {
    const existing = [{ type: "image", url: "https://example.com/a.png" }];
    const incoming = [
      { type: "image", url: "https://example.com/a.png" }, // duplicate
      { type: "video", url: "https://youtube.com/watch?v=123" }, // new
    ];
    const result = mergeMedia(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://example.com/a.png");
    expect(result[1].url).toBe("https://youtube.com/watch?v=123");
  });

  it("preserves order: existing first, then new incoming", () => {
    const existing = [
      { type: "image", url: "https://example.com/1.png" },
      { type: "image", url: "https://example.com/2.png" },
    ];
    const incoming = [
      { type: "image", url: "https://example.com/3.png" },
      { type: "image", url: "https://example.com/1.png" }, // duplicate
    ];
    const result = mergeMedia(existing, incoming);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.url)).toEqual([
      "https://example.com/1.png",
      "https://example.com/2.png",
      "https://example.com/3.png",
    ]);
  });

  it("handles mixed types (image + video)", () => {
    const existing = [{ type: "image", url: "https://example.com/a.png" }];
    const incoming = [{ type: "video", url: "https://example.com/a.png" }]; // same URL, different type
    const result = mergeMedia(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("image"); // existing wins
  });

  it("handles large merge without duplicates", () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({
      type: "image",
      url: `https://example.com/existing-${i}.png`,
    }));
    const incoming = Array.from({ length: 10 }, (_, i) => ({
      type: "image",
      url: `https://example.com/incoming-${i}.png`,
    }));
    const result = mergeMedia(existing, incoming);
    expect(result).toHaveLength(20);
  });

  it("handles large merge with all duplicates", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      type: "image",
      url: `https://example.com/${i}.png`,
    }));
    const result = mergeMedia(items, items);
    expect(result).toHaveLength(10);
  });
});

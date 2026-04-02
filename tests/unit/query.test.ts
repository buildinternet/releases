import { describe, it, expect } from "bun:test";
import { toReleaseInput } from "../../src/ai/query.js";

describe("toReleaseInput", () => {
  it("maps non-null fields directly", () => {
    const result = toReleaseInput({
      title: "Release 1.0",
      content: "New features",
      version: "1.0.0",
      publishedAt: "2024-01-01T00:00:00Z",
      url: "https://example.com/v1",
    });
    expect(result).toEqual({
      title: "Release 1.0",
      content: "New features",
      version: "1.0.0",
      publishedAt: "2024-01-01T00:00:00Z",
      url: "https://example.com/v1",
    });
  });

  it("converts null fields to undefined", () => {
    const result = toReleaseInput({
      title: "Release",
      content: "Content",
      version: null,
      publishedAt: null,
      url: null,
    });
    expect(result.version).toBeUndefined();
    expect(result.publishedAt).toBeUndefined();
    expect(result.url).toBeUndefined();
  });
});

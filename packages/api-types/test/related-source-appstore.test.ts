import { describe, it, expect } from "bun:test";
import { RelatedReleaseItemSchema } from "../src/schemas/related";

const base = {
  id: "rel_abc",
  title: "ChatGPT 1.2026.188",
  version: "1.2026.188",
  url: null,
  publishedAt: null,
  summary: "Bug fixes and small improvements.",
  titleGenerated: null,
  titleShort: null,
  importance: 4,
  thumbnail: null,
  score: 0.9,
  source: {
    id: "src_abc",
    slug: "chatgpt-ios",
    name: "ChatGPT",
    productName: "ChatGPT",
    orgSlug: "openai",
    orgName: "OpenAI",
    orgAvatarUrl: null,
  },
};

describe("RelatedReleaseItem source.appStore", () => {
  it("accepts an appStore block on the source", () => {
    const r = RelatedReleaseItemSchema.safeParse({
      ...base,
      source: {
        ...base.source,
        appStore: { platform: "ios", iconUrl: "https://x/1024x1024bb.png" },
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a macOS appStore block with a null iconUrl", () => {
    const r = RelatedReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "macos", iconUrl: null } },
    });
    expect(r.success).toBe(true);
  });

  it("still parses a source that omits appStore (non-app / back-compat)", () => {
    const r = RelatedReleaseItemSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("rejects an invalid appStore platform", () => {
    const r = RelatedReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "android", iconUrl: null } },
    });
    expect(r.success).toBe(false);
  });
});

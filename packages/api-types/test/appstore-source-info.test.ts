import { describe, it, expect } from "bun:test";
import { OrgReleaseItemSchema } from "../src/schemas/orgs";

const base = {
  version: "3.12.0",
  title: "Notion 3.12.0",
  summary: "",
  publishedAt: null,
  url: null,
  source: { slug: "notion-ios", name: "Notion", type: "appstore" },
};

describe("OrgReleaseItem source.appStore", () => {
  it("accepts an appStore block on the source", () => {
    const r = OrgReleaseItemSchema.safeParse({
      ...base,
      source: {
        ...base.source,
        appStore: { platform: "ios", iconUrl: "https://x/1024x1024bb.png" },
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a source with no appStore (non-app source)", () => {
    const r = OrgReleaseItemSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts a null iconUrl", () => {
    const r = OrgReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "macos", iconUrl: null } },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid platform", () => {
    const r = OrgReleaseItemSchema.safeParse({
      ...base,
      source: { ...base.source, appStore: { platform: "android", iconUrl: null } },
    });
    expect(r.success).toBe(false);
  });
});

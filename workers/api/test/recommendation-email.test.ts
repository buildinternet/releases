import { describe, expect, it } from "bun:test";
import {
  formatRecommendationEmail,
  withinRecommendationNotifyBudget,
} from "../src/lib/recommendation-email.js";
import type { Recommendation } from "@buildinternet/releases-core/schema";

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    store,
  };
}

const base: Recommendation = {
  id: "rec_123",
  createdAt: 1_700_000_000_000,
  type: "source",
  url: "https://example.com/releases",
  note: "Public release notes index",
  contactEmail: "user@example.com",
  status: "new",
  archived: false,
  surface: "web",
  userAgent: "test-agent",
};

describe("formatRecommendationEmail", () => {
  it("prefixes the subject and includes the submitted fields", () => {
    const { subject, text } = formatRecommendationEmail(base);
    expect(subject).toBe("[recommendation] source: https://example.com/releases");
    expect(text).toContain("Type: source");
    expect(text).toContain("URL: https://example.com/releases");
    expect(text).toContain("Additional info: Public release notes index");
    expect(text).toContain("Email to notify: user@example.com");
    expect(text).toContain("rec_123");
  });

  it("renders optional fields as none when omitted", () => {
    const { text } = formatRecommendationEmail({
      ...base,
      note: null,
      contactEmail: null,
    });
    expect(text).toContain("Additional info: (none)");
    expect(text).toContain("Email to notify: (none)");
  });
});

describe("withinRecommendationNotifyBudget", () => {
  it("allows and increments when under the hourly cap", async () => {
    const kv = fakeKv();
    expect(await withinRecommendationNotifyBudget(kv, 2)).toBe(true);
    expect(await withinRecommendationNotifyBudget(kv, 2)).toBe(true);
  });

  it("blocks once the cap is reached", async () => {
    const kv = fakeKv();
    expect(await withinRecommendationNotifyBudget(kv, 2)).toBe(true);
    expect(await withinRecommendationNotifyBudget(kv, 2)).toBe(true);
    expect(await withinRecommendationNotifyBudget(kv, 2)).toBe(false);
  });
});

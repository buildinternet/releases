import { describe, expect, it } from "bun:test";
import {
  formatRecommendationAckEmail,
  formatRecommendationEmail,
  withinRecommendationNotifyBudget,
} from "../src/lib/recommendation-email.js";
import type { Recommendation } from "@buildinternet/releases-core/schema";
import { createTestDb } from "./setup";

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

  it("includes an operator footer explaining the notification", () => {
    const { text } = formatRecommendationEmail(base);
    expect(text).toContain("Internal notification from Releases");
  });
});

describe("formatRecommendationAckEmail", () => {
  it("thanks the submitter and explains why they received the email", () => {
    const { subject, text, html } = formatRecommendationAckEmail(base, "https://releases.sh");
    expect(subject).toContain("Thanks");
    expect(text).toContain(base.url);
    expect(text).toContain(base.note!);
    expect(text).toContain("releases.sh/submit");
    expect(text).toContain("You received this because you submitted");
    expect(html).toContain(base.url);
  });
});

describe("withinRecommendationNotifyBudget", () => {
  it("allows and increments when under the hourly cap", async () => {
    const db = createTestDb();
    expect(await withinRecommendationNotifyBudget(db as unknown as D1Database, 2)).toBe(true);
    expect(await withinRecommendationNotifyBudget(db as unknown as D1Database, 2)).toBe(true);
  });

  it("blocks once the cap is reached", async () => {
    const db = createTestDb();
    expect(await withinRecommendationNotifyBudget(db as unknown as D1Database, 2)).toBe(true);
    expect(await withinRecommendationNotifyBudget(db as unknown as D1Database, 2)).toBe(true);
    expect(await withinRecommendationNotifyBudget(db as unknown as D1Database, 2)).toBe(false);
  });
});

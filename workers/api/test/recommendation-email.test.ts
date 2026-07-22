import { describe, expect, it } from "bun:test";
import {
  formatRecommendationAckEmail,
  formatRecommendationEmail,
  withinRecommendationAckBudget,
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
    expect(text).toContain("Type:    source");
    expect(text).toContain("URL:     https://example.com/releases");
    // The note is the message, so it leads as prose rather than as a labelled field.
    expect(text).toContain("Public release notes index");
    expect(text).toContain("Contact: user@example.com");
    expect(text).toContain("rec_123");
  });

  it("renders optional fields as none when omitted", () => {
    const { text } = formatRecommendationEmail({
      ...base,
      note: null,
      contactEmail: null,
    });
    expect(text).toContain("No additional note was left.");
    expect(text).toContain("Contact: (none)");
  });

  it("includes an operator footer explaining the notification", () => {
    const { text } = formatRecommendationEmail(base);
    expect(text).toContain("Internal notification from Releases");
  });
});

describe("formatRecommendationAckEmail", () => {
  it("thanks the submitter without echoing submitted url or note", () => {
    const { subject, text, html } = formatRecommendationAckEmail(base, "https://releases.sh");
    expect(subject).toContain("Thanks");
    expect(text).not.toContain(base.url);
    expect(text).not.toContain(base.note!);
    expect(text).toContain(`Reference: ${base.id}`);
    expect(text).toContain("releases.sh/submit");
    expect(text).toContain("You received this because you submitted");
    expect(html).not.toContain(base.url);
    expect(html).toContain(base.id);
  });
});

describe("withinRecommendationAckBudget", () => {
  it("uses a separate counter from operator notify", async () => {
    const db = createTestDb();
    expect(await withinRecommendationAckBudget(db as unknown as D1Database, 1)).toBe(true);
    expect(await withinRecommendationAckBudget(db as unknown as D1Database, 1)).toBe(false);
    expect(await withinRecommendationNotifyBudget(db as unknown as D1Database, 1)).toBe(true);
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

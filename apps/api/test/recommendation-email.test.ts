import { describe, expect, it } from "bun:test";
import {
  formatRecommendationAckEmail,
  formatRecommendationAddedEmail,
  formatRecommendationEmail,
  recommendationRegistryUrl,
  sendRecommendationAdded,
  withinRecommendationAckBudget,
  withinRecommendationAddedBudget,
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
  addedNotifiedAt: null,
};

const listing = {
  orgName: "Example Co",
  orgSlug: "example",
  sourceName: "Example Changelog",
  sourceSlug: "changelog",
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
    expect(text).toContain("a visitor submitted a changelog URL");
  });
});

describe("formatRecommendationAckEmail", () => {
  it("thanks the submitter without echoing submitted url or note", () => {
    const { subject, text, html } = formatRecommendationAckEmail(base, "https://releases.sh");
    // The subject names the submitted domain; the body still doesn't echo the
    // full url back at the submitter.
    expect(subject).toContain("example.com");
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

describe("formatRecommendationAddedEmail", () => {
  it("names the listing and links the live registry URL", () => {
    const { subject, text, html } = formatRecommendationAddedEmail(
      base,
      listing,
      "https://releases.sh",
    );
    expect(subject).toContain("Example Co");
    expect(subject).toContain("Example Changelog");
    expect(text).toContain("Example Co");
    expect(text).toContain("Example Changelog");
    expect(text).toContain("https://releases.sh/example/changelog");
    expect(text).toContain(`Reference: ${base.id}`);
    expect(text).toContain("You received this because you submitted");
    expect(html).toContain("https://releases.sh/example/changelog");
    expect(html).toContain(base.id);
    expect(text).not.toContain(base.url);
    expect(text).not.toContain(base.note!);
  });

  it("links the org page when no source is provided", () => {
    const { text } = formatRecommendationAddedEmail(
      base,
      { orgName: "Example Co", orgSlug: "example" },
      "https://releases.sh",
    );
    expect(text).toContain("https://releases.sh/example");
    expect(text).not.toContain("/changelog");
  });
});

describe("recommendationRegistryUrl", () => {
  it("joins org and optional source slugs", () => {
    expect(recommendationRegistryUrl("https://releases.sh", { orgName: "A", orgSlug: "a" })).toBe(
      "https://releases.sh/a",
    );
    expect(
      recommendationRegistryUrl("https://releases.sh", {
        orgName: "A",
        orgSlug: "a",
        sourceSlug: "s",
      }),
    ).toBe("https://releases.sh/a/s");
  });
});

describe("sendRecommendationAdded", () => {
  const listingOnly = { orgName: "Example Co", orgSlug: "example" };

  it("skips when there is no contact email", async () => {
    const calls: unknown[] = [];
    const result = await sendRecommendationAdded(
      {
        AUTH_EMAIL: {
          send: async (msg) => {
            calls.push(msg);
            return {};
          },
        },
      },
      { ...base, contactEmail: null },
      listingOnly,
    );
    expect(result).toEqual({ sent: false, reason: "no_contact_email" });
    expect(calls).toHaveLength(0);
  });

  it("skips when already notified", async () => {
    const calls: unknown[] = [];
    const result = await sendRecommendationAdded(
      {
        AUTH_EMAIL: {
          send: async (msg) => {
            calls.push(msg);
            return {};
          },
        },
      },
      { ...base, addedNotifiedAt: 1_700_000_000_000 },
      listingOnly,
    );
    expect(result).toEqual({
      sent: false,
      reason: "already_notified",
      notifiedAt: 1_700_000_000_000,
    });
    expect(calls).toHaveLength(0);
  });

  it("skips when the hourly budget is exhausted", async () => {
    const db = createTestDb();
    const calls: unknown[] = [];
    const env = {
      DB: db as unknown as D1Database,
      RECOMMENDATION_ADDED_MAX_PER_HOUR: "1",
      AUTH_EMAIL: {
        send: async (msg: unknown) => {
          calls.push(msg);
          return {};
        },
      },
    };
    const first = await sendRecommendationAdded(env, base, listingOnly);
    const second = await sendRecommendationAdded(env, { ...base, id: "rec_456" }, listingOnly);
    expect(first.sent).toBe(true);
    expect(second).toEqual({ sent: false, reason: "rate_capped" });
    expect(calls).toHaveLength(1);
  });
});

describe("withinRecommendationAddedBudget", () => {
  it("uses a separate counter from ack and operator notify", async () => {
    const db = createTestDb();
    expect(await withinRecommendationAddedBudget(db as unknown as D1Database, 1)).toBe(true);
    expect(await withinRecommendationAddedBudget(db as unknown as D1Database, 1)).toBe(false);
    expect(await withinRecommendationAckBudget(db as unknown as D1Database, 1)).toBe(true);
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

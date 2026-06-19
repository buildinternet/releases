import { describe, expect, it } from "bun:test";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import {
  followsSubscriptionMatchesEvent,
  orgSubscriptionMatchesEvent,
  parseReleaseTypeFilter,
  type WebhookEventOwner,
} from "./subscription-match.js";

function sub(o: Partial<WebhookSubscription>): WebhookSubscription {
  return {
    id: "whk_x",
    scope: "org",
    userId: null,
    orgId: "org_a",
    url: "https://hook.example/u",
    sourceId: null,
    productId: null,
    releaseType: null,
    enabled: true,
    description: null,
    secretVersion: 1,
    createdAt: "2026-04-18T00:00:00Z",
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMsg: null,
    failureStreakStartedAt: null,
    consecutiveFailures: 0,
    disabledReason: null,
    ...o,
  } as WebhookSubscription;
}

const owner: WebhookEventOwner = {
  orgId: "org_a",
  sourceId: "src_a",
  productId: "prd_x",
  releaseType: "feature",
};

describe("parseReleaseTypeFilter", () => {
  it("accepts feature and rollup", () => {
    expect(parseReleaseTypeFilter("feature")).toBe("feature");
    expect(parseReleaseTypeFilter("rollup")).toBe("rollup");
  });

  it("treats empty as no filter", () => {
    expect(parseReleaseTypeFilter(null)).toBe(null);
    expect(parseReleaseTypeFilter("")).toBe(null);
  });

  it("rejects unknown values", () => {
    expect(parseReleaseTypeFilter("news")).toBe("invalid");
  });
});

describe("orgSubscriptionMatchesEvent", () => {
  it("matches org-wide subscription", () => {
    expect(orgSubscriptionMatchesEvent(sub({ orgId: "org_a" }), owner)).toBe(true);
  });

  it("respects sourceId, productId, and releaseType filters", () => {
    expect(orgSubscriptionMatchesEvent(sub({ sourceId: "src_b" }), owner)).toBe(false);
    expect(orgSubscriptionMatchesEvent(sub({ productId: "prd_y" }), owner)).toBe(false);
    expect(orgSubscriptionMatchesEvent(sub({ releaseType: "rollup" }), owner)).toBe(false);
    expect(
      orgSubscriptionMatchesEvent(
        sub({ sourceId: "src_a", productId: "prd_x", releaseType: "feature" }),
        owner,
      ),
    ).toBe(true);
  });
});

describe("followsSubscriptionMatchesEvent", () => {
  it("honors releaseType on follows subs", () => {
    const follows = { orgIds: new Set(["org_a"]), productIds: new Set<string>() };
    expect(
      followsSubscriptionMatchesEvent(sub({ scope: "follows", userId: "u1" }), owner, follows),
    ).toBe(true);
    expect(
      followsSubscriptionMatchesEvent(
        sub({ scope: "follows", userId: "u1", releaseType: "rollup" }),
        owner,
        follows,
      ),
    ).toBe(false);
  });
});

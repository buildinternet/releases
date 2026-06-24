import { describe, expect, it } from "bun:test";
import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import { expandFollows } from "./expand-follows.js";

function evt(id: string): ReleaseEvent {
  return {
    id: "evt_x",
    seq: 1,
    ts: 1,
    type: "release.created",
    release: {
      id,
      title: "t",
      version: null,
      publishedAt: null,
      sourceName: "s",
      sourceSlug: "s",
      summary: null,
      titleGenerated: null,
      titleShort: null,
      media: [],
      contentChars: null,
      contentTokens: null,
    },
  };
}

function followsSub(userId: string): WebhookSubscription {
  return {
    id: `whk_${userId}`,
    userId,
    scope: "follows",
    orgId: null,
    url: "https://1.1.1.1/hook",
    sourceId: null,
    productId: null,
    releaseType: null,
    enabled: true,
    description: null,
    format: "json",
    secretVersion: 1,
    createdAt: "2026-06-19T00:00:00Z",
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMsg: null,
    failureStreakStartedAt: null,
    consecutiveFailures: 0,
    disabledReason: null,
  };
}

describe("expandFollows", () => {
  it("delivers when the owner's org is followed", () => {
    const events = [evt("rel_1")];
    const owners = new Map([
      [
        "rel_1",
        { orgId: "org_a", sourceId: "src_a", productId: "prd_x", releaseType: "feature" as const },
      ],
    ]);
    const follows = new Map([
      ["u1", { orgIds: new Set(["org_a"]), productIds: new Set<string>() }],
    ]);
    const out = expandFollows(
      events,
      [followsSub("u1")],
      (e) => owners.get(e.release.id) ?? null,
      follows,
    );
    expect(out).toHaveLength(1);
    expect(out[0].subscriptionId).toBe("whk_u1");
  });

  it("skips when follows do not match", () => {
    const events = [evt("rel_1")];
    const owners = new Map([
      [
        "rel_1",
        { orgId: "org_a", sourceId: "src_a", productId: "prd_x", releaseType: "feature" as const },
      ],
    ]);
    const follows = new Map([["u1", { orgIds: new Set<string>(), productIds: new Set<string>() }]]);
    const out = expandFollows(
      events,
      [followsSub("u1")],
      (e) => owners.get(e.release.id) ?? null,
      follows,
    );
    expect(out).toHaveLength(0);
  });
});

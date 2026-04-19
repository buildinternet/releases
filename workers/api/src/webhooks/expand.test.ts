import { describe, it, expect } from "bun:test";
import { expand } from "./expand.js";
import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@releases/core-internal/schema";

function evt(overrides: Partial<ReleaseEvent["release"]> & { orgId: string; sourceId: string }): ReleaseEvent {
  return {
    id: "evt_x",
    seq: 1,
    ts: 1,
    type: "release.created",
    release: {
      id: "rel_a",
      title: "t",
      version: null,
      publishedAt: null,
      sourceName: "s",
      sourceSlug: "s",
      contentSummary: null,
      media: [],
      ...overrides,
    } as any,
  };
}

function sub(o: Partial<WebhookSubscription>): WebhookSubscription {
  return {
    id: "whk_x",
    orgId: "org_a",
    url: "https://hook.example/u",
    sourceId: null,
    enabled: true,
    description: null,
    secretVersion: 1,
    createdAt: "2026-04-18T00:00:00Z",
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMsg: null,
    consecutiveFailures: 0,
    disabledReason: null,
    ...o,
  } as WebhookSubscription;
}

function eventOwner(e: ReleaseEvent): { orgId: string; sourceId: string } {
  return { orgId: (e.release as any).orgId, sourceId: (e.release as any).sourceId };
}

describe("expand", () => {
  it("matches no subscriptions when none target the event's org", () => {
    const events = [evt({ orgId: "org_a", sourceId: "src_a" })];
    const subs = [sub({ id: "whk_1", orgId: "org_b" })];
    const out = expand(events, subs, eventOwner);
    expect(out).toEqual([]);
  });

  it("matches an org-wide subscription (sourceId null) for every event in that org", () => {
    const events = [
      evt({ id: "rel_1", orgId: "org_a", sourceId: "src_a" }),
      evt({ id: "rel_2", orgId: "org_a", sourceId: "src_b" }),
    ];
    const subs = [sub({ id: "whk_1", orgId: "org_a", sourceId: null })];
    const out = expand(events, subs, eventOwner);
    expect(out.length).toBe(2);
    expect(out.every((m) => m.subscriptionId === "whk_1")).toBe(true);
  });

  it("respects sourceId scoping", () => {
    const events = [
      evt({ id: "rel_1", orgId: "org_a", sourceId: "src_a" }),
      evt({ id: "rel_2", orgId: "org_a", sourceId: "src_b" }),
    ];
    const subs = [sub({ id: "whk_1", orgId: "org_a", sourceId: "src_a" })];
    const out = expand(events, subs, eventOwner);
    expect(out.length).toBe(1);
    expect((out[0].event.release as any).id).toBe("rel_1");
  });

  it("captures url and secretVersion from the subscription at fan-out time", () => {
    const events = [evt({ orgId: "org_a", sourceId: "src_a" })];
    const subs = [sub({ id: "whk_1", orgId: "org_a", url: "https://x.test/u", secretVersion: 7 })];
    const out = expand(events, subs, eventOwner);
    expect(out[0].url).toBe("https://x.test/u");
    expect(out[0].secretVersion).toBe(7);
    expect(out[0].attempt).toBe(1);
  });

  it("expands one event into N messages when N subscriptions match", () => {
    const events = [evt({ orgId: "org_a", sourceId: "src_a" })];
    const subs = [
      sub({ id: "whk_1", orgId: "org_a", sourceId: null }),
      sub({ id: "whk_2", orgId: "org_a", sourceId: "src_a" }),
      sub({ id: "whk_3", orgId: "org_a", sourceId: "src_b" }),
    ];
    const out = expand(events, subs, eventOwner);
    expect(out.map((m) => m.subscriptionId).toSorted()).toEqual(["whk_1", "whk_2"]);
  });
});

import { describe, it, expect, mock } from "bun:test";
import { expandAndEnqueue } from "./expand-and-enqueue.js";
import type { DeliveryMessage } from "./types.js";

describe("expandAndEnqueue", () => {
  it("no-ops on empty events", async () => {
    const sendBatch = mock(async (_: any[]) => {});
    await expandAndEnqueue({
      events: [],
      eventOwners: new Map(),
      loadSubscriptions: async () => [],
      queue: { sendBatch } as any,
    });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("no-ops when no subscriptions match", async () => {
    const sendBatch = mock(async (_: any[]) => {});
    await expandAndEnqueue({
      events: [{ id: "evt_1", seq: 1, ts: 1, type: "release.created" as const, release: { id: "rel_1" } as any }],
      eventOwners: new Map([["rel_1", { orgId: "org_a", sourceId: "src_a" }]]),
      loadSubscriptions: async () => [],
      queue: { sendBatch } as any,
    });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("sends one message per match", async () => {
    const sent: DeliveryMessage[] = [];
    const sendBatch = mock(async (msgs: { body: DeliveryMessage }[]) => {
      for (const m of msgs) sent.push(m.body);
    });
    const events = [{ id: "evt_1", seq: 1, ts: 1, type: "release.created" as const, release: { id: "rel_1" } as any }];
    const owners = new Map([["rel_1", { orgId: "org_a", sourceId: "src_a" }]]);
    const subs = [
      { id: "whk_1", orgId: "org_a", sourceId: null, url: "https://h1", secretVersion: 1, enabled: true } as any,
      { id: "whk_2", orgId: "org_b", sourceId: null, url: "https://h2", secretVersion: 1, enabled: true } as any,
    ];
    await expandAndEnqueue({
      events,
      eventOwners: owners,
      loadSubscriptions: async () => subs,
      queue: { sendBatch } as any,
    });
    expect(sent.length).toBe(1);
    expect(sent[0].subscriptionId).toBe("whk_1");
  });

  it("chunks sendBatch calls at 100 messages each", async () => {
    const calls: number[] = [];
    const sendBatch = mock(async (msgs: any[]) => { calls.push(msgs.length); });
    const events = Array.from({ length: 250 }, (_, i) => ({
      id: `evt_${i}`, seq: i + 1, ts: 1, type: "release.created" as const, release: { id: `rel_${i}` } as any,
    }));
    const owners = new Map(events.map((e) => [(e.release as any).id, { orgId: "org_a", sourceId: "src_a" }]));
    const subs = [{ id: "whk_1", orgId: "org_a", sourceId: null, url: "https://h", secretVersion: 1, enabled: true } as any];
    await expandAndEnqueue({
      events,
      eventOwners: owners,
      loadSubscriptions: async () => subs,
      queue: { sendBatch } as any,
    });
    expect(calls).toEqual([100, 100, 50]);
  });

  it("swallows queue errors with a warn — never throws", async () => {
    const sendBatch = mock(async (_: any[]) => { throw new Error("queue down"); });
    const events = [{ id: "evt_1", seq: 1, ts: 1, type: "release.created" as const, release: { id: "rel_1" } as any }];
    const owners = new Map([["rel_1", { orgId: "org_a", sourceId: "src_a" }]]);
    const subs = [{ id: "whk_1", orgId: "org_a", sourceId: null, url: "https://h", secretVersion: 1, enabled: true } as any];
    await expandAndEnqueue({ events, eventOwners: owners, loadSubscriptions: async () => subs, queue: { sendBatch } as any });
  });
});

import { describe, it, expect } from "bun:test";
import {
  appendEvent,
  replayEvents,
  currentSeq,
  oldestSeq,
  type EventStore,
} from "../../workers/api/src/events/buffer.js";
import type { ReleaseEventPayload } from "../../workers/api/src/events/types.js";

function makeStore(): EventStore {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (map.get(key) ?? null) as T | null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(keys) {
      for (const k of keys) map.delete(k);
    },
    async list<T>({ prefix, startAfter }: { prefix: string; startAfter?: string }) {
      const out = new Map<string, T>();
      const sorted = [...map.keys()].filter((k) => k.startsWith(prefix)).toSorted();
      for (const k of sorted) {
        if (startAfter && k <= startAfter) continue;
        out.set(k, map.get(k) as T);
      }
      return out;
    },
  };
}

function payload(id: string): ReleaseEventPayload {
  return {
    id,
    title: `t-${id}`,
    version: null,
    publishedAt: null,
    sourceName: "Acme",
    sourceSlug: "acme",
    contentSummary: null,
    media: [],
  };
}

describe("appendEvent", () => {
  it("assigns monotonic seq starting at 1", async () => {
    const store = makeStore();
    const a = await appendEvent(store, payload("rel_a"), 1000);
    const b = await appendEvent(store, payload("rel_b"), 1000);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toMatch(/^evt_/);
    expect(a.ts).toBeGreaterThan(0);
  });

  it("trims the oldest event when buffer exceeds max size", async () => {
    const store = makeStore();
    for (let i = 0; i < 4; i++) await appendEvent(store, payload(`r${i}`), 2);
    const events = await replayEvents(store, 0);
    expect(events.map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("replayEvents", () => {
  it("returns events with seq > since in order", async () => {
    const store = makeStore();
    for (let i = 0; i < 3; i++) await appendEvent(store, payload(`r${i}`), 1000);
    const events = await replayEvents(store, 1);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("returns empty when since is at or beyond current head", async () => {
    const store = makeStore();
    await appendEvent(store, payload("r0"), 1000);
    expect(await replayEvents(store, 5)).toEqual([]);
  });
});

describe("currentSeq", () => {
  it("returns 0 on an empty store and equals the latest seq after appends", async () => {
    const store = makeStore();
    expect(await currentSeq(store)).toBe(0);
    await appendEvent(store, payload("r0"), 1000);
    await appendEvent(store, payload("r1"), 1000);
    expect(await currentSeq(store)).toBe(2);
  });
});

describe("oldestSeq", () => {
  it("returns 0 on an empty store", async () => {
    const store = makeStore();
    expect(await oldestSeq(store)).toBe(0);
  });

  it("returns the oldest retained seq after a trim", async () => {
    const store = makeStore();
    for (let i = 0; i < 4; i++) await appendEvent(store, payload(`r${i}`), 2);
    expect(await oldestSeq(store)).toBe(3);
  });
});

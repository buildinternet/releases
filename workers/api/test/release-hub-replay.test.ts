import { describe, it, expect } from "bun:test";
import { ReleaseHub } from "../src/release-hub.js";

// Minimal harness: build a fake DurableObjectState with an in-memory storage map.
function makeHub() {
  const map = new Map<string, unknown>();
  const storage = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: unknown) => {
      map.set(k, v);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) map.delete(k);
      return undefined;
    },
    list: async (opts: { prefix: string; startAfter?: string }) => {
      const out = new Map<string, unknown>();
      const keys = [...map.keys()].filter((k) => k.startsWith(opts.prefix)).toSorted();
      for (const k of keys) {
        if (opts.startAfter && k <= opts.startAfter) continue;
        out.set(k, map.get(k));
      }
      return out as Map<string, any>;
    },
  } as unknown as DurableObjectStorage;

  const ctx = {
    storage,
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  } as unknown as DurableObjectState;

  return new (ReleaseHub as any)(ctx, {});
}

async function publish(hub: any, n: number) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      id: `rel_${i}`,
      title: `r${i}`,
      version: null,
      publishedAt: null,
      sourceName: "s",
      sourceSlug: "s",
      contentSummary: null,
      media: [],
    });
  }
  await hub.fetch(
    new Request("https://do/publish", {
      method: "POST",
      body: JSON.stringify({ events }),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("ReleaseHub /replay", () => {
  it("returns events with seq > since in JSON", async () => {
    const hub = makeHub();
    await publish(hub, 5);
    const res = await hub.fetch(new Request("https://do/replay?since=2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number }[]; head: number; gap?: unknown };
    expect(body.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(body.head).toBe(5);
    expect(body.gap).toBeUndefined();
  });

  it("returns gap marker when since is below oldestSeq - 1", async () => {
    const hub = makeHub();
    await publish(hub, 3);
    // Manually patch oldest-seq to simulate a trimmed buffer.
    await (hub.ctx.storage as any).put("oldest-seq", 100);
    const res = await hub.fetch(new Request("https://do/replay?since=10"));
    const body = (await res.json()) as { gap?: { oldestSeq: number } };
    expect(body.gap).toEqual({ oldestSeq: 100 });
  });

  it("caps response size at limit param (default 500)", async () => {
    const hub = makeHub();
    await publish(hub, 600);
    const res = await hub.fetch(new Request("https://do/replay?since=0"));
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events.length).toBe(500);
  });

  it("respects custom limit param up to 500 max", async () => {
    const hub = makeHub();
    await publish(hub, 50);
    const res = await hub.fetch(new Request("https://do/replay?since=0&limit=10"));
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events.length).toBe(10);
  });
});

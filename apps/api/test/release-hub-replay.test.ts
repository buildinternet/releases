import { describe, it, expect } from "bun:test";
import { ReleaseHub } from "../src/release-hub.js";

// Minimal harness: fake DurableObjectState with an in-memory storage map.
function makeHub(opts?: {
  setWebSocketAutoResponse?: (pair: { request: string; response: string }) => void;
}) {
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
    list: async (listOpts: { prefix: string; startAfter?: string }) => {
      const out = new Map<string, unknown>();
      const keys = [...map.keys()].filter((k) => k.startsWith(listOpts.prefix)).toSorted();
      for (const k of keys) {
        if (listOpts.startAfter && k <= listOpts.startAfter) continue;
        out.set(k, map.get(k));
      }
      return out as Map<string, any>;
    },
  } as unknown as DurableObjectStorage;

  const ctx = {
    storage,
    acceptWebSocket: () => {},
    setWebSocketAutoResponse: opts?.setWebSocketAutoResponse ?? (() => {}),
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
      summary: null,
      titleGenerated: null,
      titleShort: null,
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

// Workers runtime globals; polyfill once for unit tests outside miniflare.
(
  globalThis as unknown as { WebSocketRequestResponsePair: unknown }
).WebSocketRequestResponsePair ??= class {
  request: string;
  response: string;
  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
};
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair ??= class {
  0 = { send: () => {} };
  1 = { send: () => {} };
};

describe("ReleaseHub WebSocket auto-response", () => {
  it("registers platform ping/pong before accepting the socket", async () => {
    const captured: { request?: string; response?: string } = {};
    const hub = makeHub({
      setWebSocketAutoResponse: (pair) => {
        captured.request = pair.request;
        captured.response = pair.response;
      },
    });
    const res = await hub.fetch(
      new Request("https://do/subscribe", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(101);
    expect(captured.request).toBe("ping");
    expect(captured.response).toBe("pong");
  });
});

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

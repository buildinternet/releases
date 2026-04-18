import { describe, it, expect } from "bun:test";
import { streamReleases, type StreamMessage } from "../../src/api/stream.js";

// Tiny mock WebSocket that replays a scripted message sequence and then closes.
function mockWs(script: Array<StreamMessage | "close">) {
  const listeners: Record<string, (ev: any) => void> = {};
  const ws: any = {
    readyState: 0,
    close() { listeners.close?.({}); },
    addEventListener(type: string, fn: (ev: any) => void) { listeners[type] = fn; },
    removeEventListener(type: string, _fn: any) { delete listeners[type]; },
    send() {},
  };
  setTimeout(() => {
    ws.readyState = 1;
    listeners.open?.({});
    for (const msg of script) {
      if (msg === "close") { listeners.close?.({ wasClean: true }); break; }
      listeners.message?.({ data: JSON.stringify(msg) });
    }
    listeners.close?.({ wasClean: true });
  }, 0);
  return ws;
}

describe("streamReleases", () => {
  it("yields release.created events and the ready handshake", async () => {
    const ws = mockWs([
      { type: "ready", seq: 0 },
      { type: "release.created", id: "evt_1", seq: 1, ts: 0, release: stubPayload("a") },
      { type: "release.created", id: "evt_2", seq: 2, ts: 0, release: stubPayload("b") },
      "close",
    ]);
    const messages: StreamMessage[] = [];
    for await (const m of streamReleases({ url: "ws://fake", openWebSocket: () => ws, reconnect: false })) {
      messages.push(m);
    }
    expect(messages.map((m) => m.type)).toEqual(["ready", "release.created", "release.created"]);
  });

  it("signals snapshot_gap so the caller can switch to polling", async () => {
    const ws = mockWs([
      { type: "ready", seq: 100 },
      { type: "snapshot_gap", since: 1, oldestSeq: 50 },
      "close",
    ]);
    const seen: string[] = [];
    for await (const m of streamReleases({ url: "ws://fake", openWebSocket: () => ws, reconnect: false })) {
      seen.push(m.type);
      if (m.type === "snapshot_gap") break;
    }
    expect(seen).toContain("snapshot_gap");
  });
});

function stubPayload(id: string) {
  return {
    id, title: `t-${id}`, version: null, publishedAt: null,
    sourceName: "x", sourceSlug: "x", contentSummary: null, media: [],
  };
}

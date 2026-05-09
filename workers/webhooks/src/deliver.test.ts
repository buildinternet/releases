import { describe, it, expect } from "bun:test";
import { deliver } from "./deliver.js";
import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

function msg(): DeliveryMessage {
  return {
    subscriptionId: "whk_1",
    url: "https://hook.example/u",
    secretVersion: 1,
    event: {
      id: "evt_1",
      seq: 1,
      ts: 1,
      type: "release.created",
      release: {
        id: "rel_1",
        title: "t",
        version: null,
        publishedAt: null,
        sourceName: "s",
        sourceSlug: "s",
        summary: null,
        titleGenerated: null,
        titleShort: null,
        contentSummary: null,
        contentTitle: null,
        contentTitleShort: null,
        media: [],
      } as any,
    },
    attempt: 1,
  };
}

async function fetch200() {
  return new Response("ok", { status: 200 });
}

async function fetch400() {
  return new Response("bad", { status: 400 });
}

async function fetch503() {
  return new Response("err", { status: 503 });
}

async function fetchNetworkError(): Promise<Response> {
  throw new TypeError("network");
}

async function fetchAbortError(): Promise<Response> {
  const e: any = new Error("aborted");
  e.name = "AbortError";
  throw e;
}

describe("deliver", () => {
  it("returns success on 2xx", async () => {
    const r = await deliver(msg(), {
      masterKey: "deadbeef".repeat(8),
      timeoutMs: 1000,
      fetchImpl: fetch200 as any,
      now: () => 1729281234,
    });
    expect(r.outcome).toBe("success");
    expect(r.httpStatus).toBe(200);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns perm_fail on 4xx", async () => {
    const r = await deliver(msg(), {
      masterKey: "deadbeef".repeat(8),
      timeoutMs: 1000,
      fetchImpl: fetch400 as any,
      now: () => 1,
    });
    expect(r.outcome).toBe("perm_fail");
    expect(r.httpStatus).toBe(400);
  });

  it("returns retry on 5xx", async () => {
    const r = await deliver(msg(), {
      masterKey: "deadbeef".repeat(8),
      timeoutMs: 1000,
      fetchImpl: fetch503 as any,
      now: () => 1,
    });
    expect(r.outcome).toBe("retry");
  });

  it("returns retry on network error", async () => {
    const r = await deliver(msg(), {
      masterKey: "deadbeef".repeat(8),
      timeoutMs: 1000,
      fetchImpl: fetchNetworkError as any,
      now: () => 1,
    });
    expect(r.outcome).toBe("retry");
    expect(r.errorCode).toBe("network");
  });

  it("returns retry on timeout (AbortError)", async () => {
    const r = await deliver(msg(), {
      masterKey: "deadbeef".repeat(8),
      timeoutMs: 1,
      fetchImpl: fetchAbortError as any,
      now: () => 1,
    });
    expect(r.outcome).toBe("retry");
    expect(r.errorCode).toBe("timeout");
  });

  it("sends the expected headers", async () => {
    let captured: Request | null = null;
    const fetch = async (req: Request) => {
      captured = req;
      return new Response("ok", { status: 200 });
    };
    await deliver(msg(), {
      masterKey: "deadbeef".repeat(8),
      timeoutMs: 1000,
      fetchImpl: fetch as any,
      now: () => 1729281234,
    });
    expect(captured).not.toBeNull();
    const r = captured!;
    expect(r.headers.get("X-Releases-Version")).toBe("1");
    expect(r.headers.get("X-Releases-Event-Id")).toBe("evt_1");
    expect(r.headers.get("X-Releases-Timestamp")).toBe("1729281234");
    expect(r.headers.get("X-Releases-Signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    expect(r.headers.get("User-Agent")).toBe("releases-webhooks/1");
  });
});

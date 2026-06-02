import { describe, it, expect } from "bun:test";
import worker, { DLQ_QUEUE } from "./index.js";

// Minimal MessageBatch fake.
function batch(messages: any[], queue = "webhook-delivery") {
  const acked: any[] = [];
  const retried: any[] = [];
  return {
    queue,
    messages: messages.map((body, i) => ({
      id: `m${i}`,
      body,
      timestamp: new Date(),
      attempts: 1,
      ack: () => acked.push(body),
      retry: (opts?: any) => retried.push({ body, opts }),
    })),
    ackAll: () => {},
    retryAll: () => {},
    acked,
    retried,
  };
}

function fakeEnv(overrides: any = {}) {
  return {
    DB: {} as any,
    WEBHOOK_DELIVERIES_AE: { writeDataPoint: () => {} } as any,
    WEBHOOK_HMAC_MASTER: { get: async () => "deadbeef".repeat(8) },
    PER_SUB_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DELIVERY_TIMEOUT_MS: "100",
    AUTO_DISABLE_THRESHOLD: "50",
    ...overrides,
  };
}

function deliveryMsg(subId = "whk_1") {
  return {
    subscriptionId: subId,
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
        media: [],
      } as any,
    },
    attempt: 1,
  };
}

describe("queue handler", () => {
  it("acks messages routed to the dlq", async () => {
    const b = batch([deliveryMsg()], DLQ_QUEUE);
    await worker.queue(b as any, fakeEnv() as any, fakeCtx());
    expect(b.acked.length).toBe(1);
  });

  it("rate-limits and retries when the limiter says no", async () => {
    const b = batch([deliveryMsg()]);
    const env = fakeEnv({
      PER_SUB_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    await worker.queue(b as any, env as any, fakeCtx());
    expect(b.retried.length).toBe(1);
  });
});

describe("fetch handler (health + robots)", () => {
  it("serves /health 200 with noindex header", async () => {
    const res = await worker.fetch(new Request("https://webhooks.releases.sh/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
  });

  it("serves / 200 (no longer 500) with noindex", async () => {
    const res = await worker.fetch(new Request("https://webhooks.releases.sh/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("serves a deny-all robots.txt", async () => {
    const res = await worker.fetch(new Request("https://webhooks.releases.sh/robots.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Disallow: /");
  });

  it("404s unknown paths with noindex (no unhandled 500)", async () => {
    const res = await worker.fetch(new Request("https://webhooks.releases.sh/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

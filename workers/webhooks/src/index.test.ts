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
    WEBHOOK_HMAC_MASTER: "deadbeef".repeat(8),
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
    event: { id: "evt_1", seq: 1, ts: 1, type: "release.created", release: { id: "rel_1", title: "t", version: null, publishedAt: null, sourceName: "s", sourceSlug: "s", contentSummary: null, media: [] } as any },
    attempt: 1,
  };
}

describe("queue handler", () => {
  it("acks messages routed to the dlq", async () => {
    const b = batch([deliveryMsg()], DLQ_QUEUE);
    await worker.queue(b as any, fakeEnv() as any);
    expect(b.acked.length).toBe(1);
  });

  it("rate-limits and retries when the limiter says no", async () => {
    const b = batch([deliveryMsg()]);
    const env = fakeEnv({
      PER_SUB_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    await worker.queue(b as any, env as any);
    expect(b.retried.length).toBe(1);
  });
});

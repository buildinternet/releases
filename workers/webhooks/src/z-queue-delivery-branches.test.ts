import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { DeliveryResult } from "./deliver.js";

let deliverOutcome: DeliveryResult = {
  outcome: "success",
  httpStatus: 200,
  latencyMs: 1,
  errorMessage: null,
  errorCode: null,
};

let deliverCalls = 0;

const subscriptions = new Map<
  string,
  {
    id: string;
    enabled: boolean;
    userId: string | null;
    consecutiveFailures: number;
    failureStreakStartedAt: string | null;
  }
>();

mock.module("./queries.js", () => ({
  getWebhookSubscriptionById: async (_db: unknown, id: string) => subscriptions.get(id) ?? null,
  getWebhookSubscriptionLabels: async () => [],
  getOrgLabelById: async () => null,
  updateWebhookSubscriptionSummary: async () => {},
  setWebhookSubscriptionEnabled: async (_db: unknown, id: string, enabled: boolean) => {
    const sub = subscriptions.get(id);
    if (!sub || !sub.enabled || enabled) return false;
    sub.enabled = false;
    return true;
  },
}));

const { default: worker, DLQ_QUEUE, setDeliverHook } = await import("./index.js");

function batch(messages: unknown[], queue = "webhook-delivery") {
  const acked: unknown[] = [];
  const retried: { body: unknown; opts?: unknown }[] = [];
  return {
    queue,
    messages: messages.map((body, i) => ({
      id: `m${i}`,
      body,
      timestamp: new Date(),
      attempts: 1,
      ack: () => acked.push(body),
      retry: (opts?: unknown) => retried.push({ body, opts }),
    })),
    ackAll: () => {},
    retryAll: () => {},
    acked,
    retried,
  };
}

function fakeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as D1Database,
    WEBHOOK_DELIVERIES_AE: { writeDataPoint: () => {} } as AnalyticsEngineDataset,
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
    url: "https://1.1.1.1/hook",
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
      },
    },
    attempt: 1,
  };
}

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

function enabledSub(
  id: string,
  overrides: Partial<{
    enabled: boolean;
    userId: string | null;
    consecutiveFailures: number;
    failureStreakStartedAt: string | null;
  }> = {},
) {
  subscriptions.set(id, {
    id,
    enabled: true,
    userId: null,
    consecutiveFailures: 0,
    failureStreakStartedAt: null,
    ...overrides,
  });
}

describe("queue handler delivery branches", () => {
  beforeEach(() => {
    deliverCalls = 0;
    subscriptions.clear();
    deliverOutcome = {
      outcome: "success",
      httpStatus: 200,
      latencyMs: 1,
      errorMessage: null,
      errorCode: null,
    };
    setDeliverHook(async () => {
      deliverCalls += 1;
      return deliverOutcome;
    });
  });

  afterEach(() => {
    setDeliverHook(null);
  });

  it("acks on deliver success", async () => {
    enabledSub("whk_1");
    const b = batch([deliveryMsg()]);
    await worker.queue(b as never, fakeEnv() as never, fakeCtx());
    expect(b.acked.length).toBe(1);
    expect(b.retried.length).toBe(0);
    expect(deliverCalls).toBe(1);
  });

  it("acks on deliver perm_fail (4xx)", async () => {
    enabledSub("whk_1");
    deliverOutcome = {
      outcome: "perm_fail",
      httpStatus: 400,
      latencyMs: 1,
      errorMessage: "bad",
      errorCode: "subscriber_4xx",
    };
    const b = batch([deliveryMsg()]);
    await worker.queue(b as never, fakeEnv() as never, fakeCtx());
    expect(b.acked.length).toBe(1);
    expect(b.retried.length).toBe(0);
  });

  it("retries on deliver retry (5xx)", async () => {
    enabledSub("whk_1");
    deliverOutcome = {
      outcome: "retry",
      httpStatus: 503,
      latencyMs: 1,
      errorMessage: "err",
      errorCode: "subscriber_5xx",
    };
    const b = batch([deliveryMsg()]);
    await worker.queue(b as never, fakeEnv() as never, fakeCtx());
    expect(b.acked.length).toBe(0);
    expect(b.retried.length).toBe(1);
  });

  it("acks without delivering when subscription is disabled", async () => {
    enabledSub("whk_1", { enabled: false });
    const b = batch([deliveryMsg()]);
    await worker.queue(b as never, fakeEnv() as never, fakeCtx());
    expect(b.acked.length).toBe(1);
    expect(b.retried.length).toBe(0);
    expect(deliverCalls).toBe(0);
  });

  it("retries all messages when the HMAC master key is missing", async () => {
    enabledSub("whk_1");
    const b = batch([deliveryMsg(), deliveryMsg("whk_2")]);
    const env = fakeEnv({
      WEBHOOK_HMAC_MASTER: { get: async () => null },
    });
    await worker.queue(b as never, env as never, fakeCtx());
    expect(b.retried.length).toBe(2);
    expect(b.acked.length).toBe(0);
    expect(deliverCalls).toBe(0);
  });

  it("acks dlq-routed messages without delivering", async () => {
    setDeliverHook(null);
    const b = batch([deliveryMsg()], DLQ_QUEUE);
    await worker.queue(b as never, fakeEnv() as never, fakeCtx());
    expect(b.acked.length).toBe(1);
    expect(deliverCalls).toBe(0);
  });
});

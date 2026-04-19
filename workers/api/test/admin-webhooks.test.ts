import { describe, it, expect, mock, beforeEach } from "bun:test";

type FakeSub = {
  id: string;
  orgId: string;
  url: string;
  sourceId: string | null;
  description: string | null;
  enabled: boolean;
  secretVersion: number;
  createdAt: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
};

const store: FakeSub[] = [];
let nextId = 1;

// Queue spy: records all messages sent via WEBHOOK_DELIVERY_QUEUE.send().
const queueMessages: unknown[] = [];

// Stub the worker-local query module so the route exercises real validation/
// signing logic against an in-memory store, without standing up a D1 fake.
mock.module("../src/webhooks/queries.js", () => ({
  insertWebhookSubscription: async (
    _db: unknown,
    input: { orgId: string; url: string; sourceId: string | null; description: string | null },
  ) => {
    const row: FakeSub = {
      id: `whk_test${String(nextId++).padStart(4, "0")}`,
      orgId: input.orgId,
      url: input.url,
      sourceId: input.sourceId,
      description: input.description,
      enabled: true,
      secretVersion: 1,
      createdAt: new Date().toISOString(),
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMsg: null,
      consecutiveFailures: 0,
      disabledReason: null,
    };
    store.push(row);
    return row;
  },
  getWebhookSubscriptionById: async (_db: unknown, id: string) =>
    store.find((s) => s.id === id) ?? null,
  listWebhookSubscriptionsByOrg: async (
    _db: unknown,
    orgId: string,
    opts?: { enabledOnly?: boolean },
  ) =>
    store.filter((s) => s.orgId === orgId && (!opts?.enabledOnly || s.enabled)),
  updateWebhookSubscription: async (
    _db: unknown,
    id: string,
    updates: Partial<{
      url: string;
      description: string | null;
      enabled: boolean;
      disabledReason: string | null;
      consecutiveFailures: number;
    }>,
  ) => {
    const idx = store.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    Object.assign(store[idx], updates);
    return { ...store[idx] };
  },
  deleteWebhookSubscription: async (_db: unknown, id: string) => {
    const idx = store.findIndex((s) => s.id === id);
    if (idx !== -1) store.splice(idx, 1);
  },
  bumpWebhookSecretVersion: async (_db: unknown, id: string) => {
    const sub = store.find((s) => s.id === id);
    if (!sub) throw new Error(`subscription not found: ${id}`);
    sub.secretVersion += 1;
    return sub.secretVersion;
  },
}));

// Imports must follow mock.module so the route picks up the stub.
const { Hono } = await import("hono");
const { adminWebhooksRoutes } = await import("../src/routes/admin-webhooks.js");

const TEST_MASTER_KEY = "a".repeat(64);

function makeApp(opts?: { masterKey?: string | null; withQueue?: boolean }) {
  const masterKey = opts === undefined
    ? TEST_MASTER_KEY
    : opts.masterKey ?? TEST_MASTER_KEY;
  const withQueue = opts?.withQueue !== false; // default true
  const fakeEnv: Record<string, unknown> = {
    DB: {},
    WEBHOOK_HMAC_MASTER: masterKey !== null
      ? { get: async () => masterKey }
      : undefined,
  };
  if (withQueue) {
    fakeEnv.WEBHOOK_DELIVERY_QUEUE = {
      send: async (msg: unknown) => {
        queueMessages.push(msg);
      },
    };
  }
  const app = new Hono();
  app.route("/", adminWebhooksRoutes);
  return (req: Request) => app.fetch(req, fakeEnv);
}

beforeEach(() => {
  store.length = 0;
  queueMessages.length = 0;
  nextId = 1;
});

describe("POST /v1/admin/webhooks", () => {
  it("creates a subscription and returns id + signing key", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { id?: string; signingKey?: string };
    expect(body.id).toMatch(/^whk_/);
    expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 400 for non-HTTPS URL", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "http://insecure/u" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed URL", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "not-a-url" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when orgId is missing", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/hook" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when url is missing", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/webhooks", () => {
  it("returns 200 with the subscriptions seeded for an org", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const res = await fetch(new Request("https://x.test/v1/admin/webhooks?org=org_test"));
    expect(res.status).toBe(200);
    const body = await res.json() as { subscriptions: { id: string; orgId: string }[] };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].orgId).toBe("org_test");
  });

  it("returns 400 when org param is missing", async () => {
    const fetch = makeApp();
    const res = await fetch(new Request("https://x.test/v1/admin/webhooks"));
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/webhooks/:id", () => {
  it("returns 404 for an unknown id even when other subscriptions exist", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const res = await fetch(new Request("https://x.test/v1/admin/webhooks/whk_nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 200 with the subscription for a known id", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    const res = await fetch(new Request(`https://x.test/v1/admin/webhooks/${id}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { id?: string };
    expect(body.id).toBe(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /v1/admin/webhooks/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /v1/admin/webhooks/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/whk_nope", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when url is invalid", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not-a-url" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when url is HTTP (not HTTPS)", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://insecure.example.com/hook" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when no recognized fields are provided", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unknownField: "whatever" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("resets consecutiveFailures and clears disabledReason when enabled:true", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    // Manually set the subscription to disabled with some failures
    store[0].enabled = false;
    store[0].consecutiveFailures = 5;
    store[0].disabledReason = "auto disabled";

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as FakeSub;
    expect(body.enabled).toBe(true);
    expect(body.consecutiveFailures).toBe(0);
    expect(body.disabledReason).toBeNull();
  });

  it("sets disabledReason to 'manually disabled' when enabled:false with no reason", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as FakeSub;
    expect(body.enabled).toBe(false);
    expect(body.disabledReason).toBe("manually disabled");
  });

  it("updates description and returns fresh subscription", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "updated description" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as FakeSub;
    expect(body.id).toBe(id);
    expect(body.description).toBe("updated description");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/admin/webhooks/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/admin/webhooks/:id", () => {
  it("returns 204 for an existing subscription", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("subscription is gone after delete (GET returns 404)", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}`, {
        method: "DELETE",
      }),
    );
    const getRes = await fetch(new Request(`https://x.test/v1/admin/webhooks/${id}`));
    expect(getRes.status).toBe(404);
  });

  it("returns 204 even for an unknown id (idempotent)", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/whk_doesnotexist", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/admin/webhooks/:id/rotate-secret
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/admin/webhooks/:id/rotate-secret", () => {
  it("returns 404 for an unknown id", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/whk_nope/rotate-secret", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("bumps secretVersion to 2 and returns a valid 64-hex signing key", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;
    expect(store[0].secretVersion).toBe(1);

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}/rotate-secret`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { secretVersion: number; signingKey: string };
    expect(body.secretVersion).toBe(2);
    expect(body.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different signing key after rotation", async () => {
    const fetch = makeApp();
    // First create and get the original signing key
    const createRes = await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const original = await createRes.json() as { id: string; signingKey: string };
    const id = original.id;

    const rotateRes = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}/rotate-secret`, {
        method: "POST",
      }),
    );
    const rotated = await rotateRes.json() as { secretVersion: number; signingKey: string };
    expect(rotated.signingKey).not.toBe(original.signingKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/admin/webhooks/:id/test
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/admin/webhooks/:id/test", () => {
  it("returns 404 for an unknown id", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/whk_nope/test", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns { enqueued: true, eventId } and sends the message to the queue", async () => {
    const fetch = makeApp();
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    const id = store[0].id;

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}/test`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { enqueued: boolean; eventId: string };
    expect(body.enqueued).toBe(true);
    expect(body.eventId).toMatch(/^test_/);

    // Verify the message was actually enqueued
    expect(queueMessages).toHaveLength(1);
    const msg = queueMessages[0] as {
      subscriptionId: string;
      url: string;
      secretVersion: number;
      event: { id: string; type: string };
      attempt: number;
    };
    expect(msg.subscriptionId).toBe(id);
    expect(msg.url).toBe("https://example.com/hook");
    expect(msg.event.type).toBe("release.created");
    expect(msg.attempt).toBe(1);
  });

  it("returns 503 when WEBHOOK_DELIVERY_QUEUE binding is missing", async () => {
    const fetch = makeApp({ withQueue: false });
    await fetch(
      new Request("https://x.test/v1/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org_test", url: "https://example.com/hook" }),
      }),
    );
    // We don't have a queue, so we need to look up the sub directly since
    // the POST also fails without a queue (but the sub is in the store from mock)
    const id = store[0]?.id ?? "whk_test0001";

    const res = await fetch(
      new Request(`https://x.test/v1/admin/webhooks/${id}/test`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/admin/webhooks/:id/deliveries
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/admin/webhooks/:id/deliveries", () => {
  it("returns 501 when CF_API_TOKEN is absent", async () => {
    const fetch = makeApp();
    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/whk_test0001/deliveries"),
    );
    expect(res.status).toBe(501);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("deliveries_unavailable");
  });

  it("returns 400 when id is malformed (does not match whk_ pattern)", async () => {
    // Build an app with CF_API_TOKEN and CF_ACCOUNT_ID set
    const fakeEnv: Record<string, unknown> = {
      DB: {},
      WEBHOOK_HMAC_MASTER: { get: async () => TEST_MASTER_KEY },
      WEBHOOK_DELIVERY_QUEUE: { send: async () => {} },
      CF_API_TOKEN: { get: async () => "fake-token" },
      CF_ACCOUNT_ID: "fake-account",
    };
    const { Hono: H } = await import("hono");
    const app = new H();
    app.route("/", adminWebhooksRoutes);
    const fetch = (req: Request) => app.fetch(req, fakeEnv);

    const res = await fetch(
      new Request("https://x.test/v1/admin/webhooks/not-a-real-id/deliveries"),
    );
    expect(res.status).toBe(400);
  });
});

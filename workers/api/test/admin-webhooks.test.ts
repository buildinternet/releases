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
}));

// Imports must follow mock.module so the route picks up the stub.
const { Hono } = await import("hono");
const { adminWebhooksRoutes } = await import("../src/routes/admin-webhooks.js");

const TEST_MASTER_KEY = "a".repeat(64);

function makeApp(opts?: { masterKey?: string | null }) {
  const masterKey = opts === undefined
    ? TEST_MASTER_KEY
    : opts.masterKey ?? TEST_MASTER_KEY;
  const fakeEnv: Record<string, unknown> = {
    DB: {},
    WEBHOOK_HMAC_MASTER: masterKey !== null
      ? { get: async () => masterKey }
      : undefined,
  };
  const app = new Hono();
  app.route("/", adminWebhooksRoutes);
  return (req: Request) => app.fetch(req, fakeEnv);
}

beforeEach(() => {
  store.length = 0;
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
